// api/teslim-kontrol.js
// QStash tarafindan cagrilir. Siparisin Yurtici Kargo durumunu kontrol eder.
// Henuz teslim edilmediyse (DLV degilse) belirli bir sure sonra kendini
// yeniden zamanlar. Teslim edildiyse fatura-kes.js'i tetikler.
//
// Akis: fatura-baslat.js (kargoya verildi webhook'u) -> ilk teslim-kontrol
//       gorevini QStash'e birakir -> bu dosya calisir -> DLV degilse
//       kendini X saat sonraya yeniden zamanlar -> DLV olunca fatura-kes'i cagirir.
//
// Ayrica: kurye teslimatta basarisiz olursa (orn. Yurtici reason kodu "AAB" =
// Alici Adreste Bulunamadi, "MSA" = Musteri Subeden Alacak) musteriye bir
// kereye mahsus "subeden teslim alabilirsiniz" WhatsApp bildirimi gonderir
// (teslim_basarisiz sablonu).
//
// Yurtici Kargo sorgusu artik ../lib/yurtici.js'deki ORTAK istemciyi kullanir
// (webhook-process.js, teslim-kontrol.js ve yorum.js ayni koddan besleniyor).
//
// 2026-09-05 DUZELTME: hesap artik Vercel Pro'da (bu fonksiyon icin
// maxDuration 180sn). Eskiden fatura-kes.js'e ve Sheets/WhatsApp'a giden
// istekler sikistirilmis zaman asimlariyla yapiliyordu - Yurtici/Mysoft
// hafif yavas oldugunda bile istek ERKEN kesilip gereksiz "ulasilamadi"
// alarmi/hata sayilabiliyordu. Asagidaki fetchWithTimeout cagrilarinin
// sureleri bu yuzden bollastirildi (triggerFatura: 25sn->60sn, Sheets
// loglama: 8sn->15sn, teslim-basarisiz WhatsApp mesaji: 8sn->12sn, tarama'nin
// Shopify siparis listesi cekme: 15sn->20sn). Tarama modunun kendi ic
// mantigi (parti buyuklugu, kac gun geriye bakildigi, tekrar deneme araligi)
// DEGISTIRILMEDI - sadece "gercekten calisiyor ama yavas olan bir istegi
// yanlislikla basarisiz saymamak" icin sureler arttirildi.

// GUVENLIK AGI (TARAMA MODU) - 2026-09-02'de eklendi:
// fatura-baslat.js'in Shopify webhook'u ara sira bir siparisi hic
// tetiklemeyebiliyor (webhook'lar %100 garantili degildir). Bu durumda
// yukaridaki normal akis o siparise HIC dokunmuyor - ne fatura ne hata
// ne alarm, hicbir iz kalmiyor (gercek bir vaka: #12359 - teslim alinmis,
// odemesi tahsil edilmis ama fatura akisina hic girmemis).
// Bu riski ortadan kaldirmak icin: GET ?mod=tarama&secret=... ile
// cagrildiginda, Shopify'dan kargoya verilmis ama "fatura-kesildi"
// etiketi olmayan siparisleri kucuk gruplar halinde tarar, Yurtici'de
// gercekten teslim edilmis olanlari fatura-kes.js'e yonlendirir. Duzenli
// araliklarla (orn. QStash Schedule ile her 30 dakikada bir) cagrilmasi
// onerilir - hem gecmis boslugu kapatir hem ileride ayni sorun olursa
// kendiliginden telafi eder.

const { Redis } = require("@upstash/redis");
const redis = Redis.fromEnv();
const yurtici = require("../lib/yurtici");

const SECRET = "masajur_yakkoholding_2128";
const RECHECK_DELAY = "1h";       // 6h -> 1h: teslimat tespiti cok daha hizli olsun
// fatura-baslat.js ilk kontrolu 1 gun sonra baslatiyor. Buradan itibaren
// 1 saatte bir kontrol edilirse 96 deneme = 4 gun -> toplam ~5 gun (oncekiyle ayni sinir).
const MAX_DENEME = 96;
// NOT: Bu sinira ulasilirsa fatura KESILMEZ. Sadece Google Sheets'e alarm
// kaydi dusulur, sen Mysoft panelinden manuel kontrol edip karar verirsin.
// Sadece gercekten "teslim edildi" (DLV) onayi gelen siparislere fatura kesilir.

// Teslim basarisiz (kapida bulunamadi) bildirimi icin sablon + tekrar
// gonderimi engelleyen Redis anahtari. AAB (Alici Adreste Bulunamadi) ve
// MSA (Musteri Subeden Alacak) - IGH (2 gunluk hat, otomatik tekrar
// denenecek) kasitli olarak DISINDA, cunku gercek bir sorun degil.
const FAILED_REASON_CODES = ["AAB", "MSA"];
const TESLIM_BASARISIZ_TEMPLATE = "teslim_basarisiz";
const TESLIM_BASARISIZ_LANG = "tr";

// 2026-09-17 EKLENDI - KAPIDAN DONEN AKISI
// Paket musteriye ulasmadan sirkete geri dondugunde iki mesaj gidiyor:
//   1) MUSTERIYE  : "kapidan_donen_kurtarma" - yeniden gonderim teklifi (satisi kurtarma)
//   2) YETKILILERE: "kapidan_donen_alarm"    - siparis no + ad + telefon + sebep
// Ikisi de isaretleIadeGorulduSirkete() icinden, EN SONDA tetikleniyor -
// yani fatura/Redis/Sheets tarafi zaten tamamlanmis oluyor, bu cagrilar
// patlasa bile mevcut akista hicbir sey bozulmaz.
//
// DIL KODU NOTU: kurtarma sablonu Meta'da yanlislikla "English" olarak
// kaydedildi (metin Turkce, sadece etiketi ingilizce). WhatsApp bu etiketi
// ceviri icin kullanmiyor, sablonda ne yaziyorsa onu gonderiyor - bu yuzden
// sablonu silip yeniden olusturmak yerine dil kodunu "en" biraktik. Alarm
// sablonu normal sekilde "tr".
const KAPIDAN_DONEN_KURTARMA_TEMPLATE = "kapidan_donen_kurtarma";
const KAPIDAN_DONEN_KURTARMA_LANG = "en";
const KAPIDAN_DONEN_ALARM_TEMPLATE = "kapidan_donen_alarm";
const KAPIDAN_DONEN_ALARM_LANG = "tr";

// Alarmin gidecegi yetkili numaralar (webhook-process.js'tekiyle AYNI iki numara)
const ALERT_NUMBERS = ["905530681619", "905511485344"];

// 2026-09-17 EKLENDI - TESLIMAT GUNU HATIRLATMASI
// Amac: kapida odemede "alici kabul etmedi" iadelerini azaltmak. Musteri
// siparisi anlik heyecanla veriyor, kargo 3-5 gun sonra geldiginde heyecan
// sonmus oluyor ve pesin para vermedigi icin vazgecmesinin hicbir maliyeti
// yok. Paket kuryeye zimmetlendigi gun giden kisa bir mesaj hem satin alma
// hissini tazeliyor hem de - en onemlisi - tereddutlu musteriye KONUSMA
// KAPISI aciyor: kuryeye "almiyorum" demek yerine bize yaziyor, bot da
// itirazi karsilayip satisi kurtarabiliyor.
//
// TETIKLEYICI (12988 numarali gercek siparisin Yurtici cevabindan dogrulandi):
//   cargoEventId        = "YK"   -> Kargo Yuklendi
//   cargoReasonId       = "GOK"  -> Kuryede/zimmetlendi (dagitima cikti)
//   operationStatus     = "IND"  -> Kargo teslimattadir
// Bunlardan en net olani cargoReasonId === "GOK". Bu alan getKargoDetail()
// tarafindan zaten "reasonId" olarak donduruluyordu.
//
// DIKKAT: "GOK", asagidaki FAILED_REASON_CODES ("AAB"/"MSA") ile CAKISMAZ -
// onlar teslimat DENEMESI BASARISIZ oldugunda geliyor, bu ise paket daha
// kuryenin elindeyken. Ayrica bu kontrol gercekTeslim ve sirketeIadeEdildi
// kontrollerinden SONRA yapiliyor, yani paket teslim edilmis veya geri
// donmusse mesaj hic gonderilmiyor.
const TESLIMAT_GUNU_TEMPLATE = "teslimat_gunu_hatirlatma";
const TESLIMAT_GUNU_LANG = "tr";
const DAGITIMA_CIKTI_REASON_CODES = ["GOK"];

// 2026-09-18 EKLENDI - TESLIMAT SONRASI REHBER MESAJI
// Paket MUSTERIYE GERCEKTEN TESLIM EDILDIGI anda (gercekTeslim === true)
// bir kereye mahsus "Boyun Sagligi Rehberi" linki gonderilir. Amac: cihazi
// ilk gunden dogru kullandirmak (modlarin BIRLIKTE acilmasi, dogru baslangic
// seviyeleri) - yanlis kullanim hem memnuniyetsizlik hem iade sebebi.
//
// TASARIM KARARI - FATURA AKISI KORUNUYOR: bu mesaj her iki cagri
// noktasinda da triggerFatura()'dan SONRA gonderiliyor ve sendRehberMesajiGuvenli()
// icinde try/catch ile sarili - WhatsApp tarafinda ne olursa olsun (token
// hatasi, sablon reddi, zaman asimi) fatura kesme akisi ETKILENMEZ.
//
// MUKERRER KORUMASI: "rehber-gonderildi:<siparis no>" Redis bayragi (90 gun).
// Bayrak, gonderim BASARISIZ olsa da atiliyor - bu bilincli bir tercih:
// musteriye ayni mesajin iki kez gitmesi, hic gitmemesinden daha rahatsiz edici.
const REHBER_TEMPLATE = "teslimat_rehber";
const REHBER_LANG = "tr";

// Arka plan/batch isi oldugu icin webhook-process.js'in musteri sohbeti
// devre kesicisinden AYRI, kendi ortak anahtarini kullanir.
const cb = yurtici.createCircuitBreaker("yurtici-cb");

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 2026-09-02 EKLENDI: #12415 vakasi (Yurtici panelinde "Iade Durumu: IADE" ve
// "Alici Adi: FATIH TATLI" ile ayri bir "Teslim Alan: YAKUP SEVIM" gorunen,
// ama receiverCustName sirket adiyla eslesmedigi icin sirketeIadeEdildi=false
// cikan ve YANLISLIKLA fatura kesilen bir siparis) sirketeIadeEdildi tespitinin
// TEK BASINA YETERLI OLMADIGINI gosterdi. Yurtici'nin queryShipment SOAP
// cevabinda "Iade Durumu" ve "Teslim Alan" alanlarinin hangi XML etiketine
// karsilik geldigini gormek icin bu debug ucu eklendi - ham XML'i ve tum
// etiketleri oldugu gibi doner, boylece bir sonraki duzeltme TAHMINE degil
// GERCEK VERIYE dayanir.
function tumEtiketleriCikar(xml) {
  const sonuc = {};
  const regex = /<(\w+)>([^<]*)<\/\1>/g;
  let m;
  while ((m = regex.exec(xml)) !== null) {
    const key = m[1];
    const val = m[2].trim();
    if (!(key in sonuc)) sonuc[key] = val;
    else if (Array.isArray(sonuc[key])) sonuc[key].push(val);
    else sonuc[key] = [sonuc[key], val];
  }
  return sonuc;
}

async function handleDebugKargo(req, res) {
  const secret = req.query && req.query.secret;
  if (secret !== SECRET) {
    return res.status(401).send("Unauthorized");
  }
  const orderNumber = req.query && req.query.orderNumber;
  if (!orderNumber) {
    return res.status(400).send("orderNumber parametresi gerekli, orn: ?mod=debug-kargo&orderNumber=12415&secret=...");
  }
  try {
    const raw = await yurtici.queryShipment(String(orderNumber), cb, "DEBUG-KARGO");
    if (!raw) {
      return res.status(200).send("SONUC YOK (devre kesici acik olabilir veya sorgu basarisiz oldu) - siparis: " + orderNumber);
    }
    const tumEtiketler = raw.rawXml ? tumEtiketleriCikar(raw.rawXml) : {};
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send(
      "=== SIPARIS: " + orderNumber + " ===\n\n" +
      "=== SU AN KODUN HESAPLADIGI ALANLAR ===\n" +
      JSON.stringify({
        operationStatus: raw.operationStatus,
        receiverCustName: raw.receiverCustName,
        deliveryUnitName: raw.deliveryUnitName,
        cargoEventExplanation: raw.cargoEventExplanation,
        cargoReasonId: raw.cargoReasonId,
        cargoReasonExplanation: raw.cargoReasonExplanation,
        gercektenMusteriyeTeslimEdildi: raw.gercektenMusteriyeTeslimEdildi,
        sirketeIadeEdildi: raw.sirketeIadeEdildi
      }, null, 2) +
      "\n\n=== XML ICINDEKI TUM ETIKETLER (HICBIRI FILTRELENMEDI) ===\n" +
      JSON.stringify(tumEtiketler, null, 2) +
      "\n\n=== HAM XML (TAM CEVAP) ===\n" +
      (raw.rawXml || "(rawXml alani yok - lib/yurtici.js guncellenmemis olabilir)")
    );
  } catch (e) {
    return res.status(200).send("HATA: " + (e && e.message ? e.message : e));
  }
}

async function getKargoDetail(orderNumber) {
  const raw = await yurtici.queryShipment(orderNumber, cb, "TESLIM-KONTROL");
  if (!raw) return null;
  return {
    status: raw.operationStatus,                            // HAM Yurtici kodu - loglama icin, fatura kararinda KULLANMA
    gercekTeslim: raw.gercektenMusteriyeTeslimEdildi,        // DOGRU alan: gercekten musteriye mi teslim edildi
    sirketeIadeEdildi: raw.sirketeIadeEdildi,                // DLV ama aslinda paket bize geri donmus/reddedilmis
    iadeSebebi: raw.rejectReasonExplanation || raw.rejectStatusExplanation || null, // orn. "Alici Kabul Etmedi (...)"
    reasonId: raw.cargoReasonId,          // orn. "AAB"/"MSA"/"GOK"
    reasonExplanation: raw.cargoReasonExplanation,
    // 2026-09-17 EKLENDI: kargo hareketi (orn. "YK" = Kargo Yuklendi). Teslimat
    // gunu hatirlatmasinin dogru ana denk gelip gelmedigini loglardan takip
    // edebilmek icin ekledi - karar reasonId uzerinden veriliyor.
    eventId: raw.cargoEventId,
    eventExplanation: raw.cargoEventExplanation,
    branch: raw.deliveryUnitName          // gonderinin bekledigi sube
  };
}

// Bir sonraki kontrolu QStash'e birak
async function scheduleRecheck(orderNumber, deneme, phone, name) {
  if (!process.env.QSTASH_TOKEN) {
    console.log("QSTASH_TOKEN yok, tekrar deneme birakilamadi");
    return;
  }
  const targetUrl = "https://masajur-ai-proxy.vercel.app/api/teslim-kontrol?secret=" + SECRET;
  await fetch("https://qstash.upstash.io/v2/publish/" + targetUrl, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.QSTASH_TOKEN,
      "Content-Type": "application/json",
      "Upstash-Delay": RECHECK_DELAY
    },
    body: JSON.stringify({ orderNumber: orderNumber, deneme: deneme + 1, phone: phone, name: name })
  });
}

// Teslim edildi -> fatura-kes.js'i tetikle
async function triggerFatura(orderNumber) {
  // 2026-09-02 DUZELTME: fatura-kes.js CALISABILDIYSE kendi sonucunu (basari,
  // hata, belirsiz durum, iptal, bulunamadi) zaten KENDI ICINDE Sheets'e
  // yaziyor - burada AYRICA loglamak ayni olayi IKI KEZ kaydedip gereksiz
  // gurultu yaratir (kullanici acikca "abartma" dedi). Bu yuzden burada
  // SADECE fatura-kes.js'e hic ULASILAMADIGI durumu (istek onun calisma
  // firsati bile bulamadan koptu, yani HICBIR YERDE kayit yok) logluyoruz.
  // Tarama zaten ~30 dk icinde otomatik tekrar deneyecek - bu normal
  // kendiliginden iyilesme akisi, alarm sadece "hicbir iz kalmasin" diye.
  const url = "https://masajur-ai-proxy.vercel.app/api/fatura-kes?secret=" + SECRET;
  try {
    const resp = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderNumber: orderNumber })
    }, 60000);
    const data = await resp.json().catch(() => ({}));
    console.log("TESLIM-KONTROL: fatura-kes tetiklendi:", JSON.stringify(data));
  } catch (e) {
    console.error("TESLIM-KONTROL: fatura-kes'e ulasilamadi:", e && e.message ? e.message : e);
    await logTeslimAlarmToSheets(orderNumber, 0,
      "FATURA-KES'E ULASILAMADI (ag hatasi/zaman asimi, fatura-kes.js hic calisamadi) - tarama ~30 dk icinde otomatik tekrar deneyecek");
  }
}

// Ayni siparis icin "teslim basarisiz" bildirimini bir kereden fazla
// gondermemek icin Redis'te bayrak tutuyoruz (her saat tekrar denendigi icin).
async function alreadyNotifiedFailed(orderNumber) {
  try {
    const v = await redis.get("teslim-basarisiz-bildirildi:" + orderNumber);
    return !!v;
  } catch (e) {
    return false; // Redis erisilemezse guvenli taraf: bildirim gondermeye izin ver
  }
}
async function markNotifiedFailed(orderNumber) {
  try {
    await redis.set("teslim-basarisiz-bildirildi:" + orderNumber, "1", { ex: 30 * 24 * 3600 });
  } catch (e) {}
}

// 2026-09-17: teslimat gunu hatirlatmasi da siparis basina SADECE BIR KEZ
// gitmeli. Paket kuryede oldugu surece her saatlik kontrolde "GOK" gorunmeye
// devam ediyor; bayrak olmasa musteriye saatte bir mesaj giderdi. Ayrica
// paket ilk gun teslim edilemeyip ertesi gun tekrar dagitima cikarsa da
// ikinci bir mesaj gitmesin istiyoruz - o senaryoyu zaten AAB/MSA
// bildirimi ("subeden teslim alabilirsiniz") karsiliyor.
async function alreadyNotifiedTeslimatGunu(orderNumber) {
  try {
    const v = await redis.get("teslimat-gunu-bildirildi:" + orderNumber);
    return !!v;
  } catch (e) {
    // Redis erisilemezse GUVENLI TARAF: mesaj GONDERME. Mukerrer mesaj,
    // hic mesaj gitmemesinden daha kotu (musteriyi rahatsiz eder).
    return true;
  }
}
async function markNotifiedTeslimatGunu(orderNumber) {
  try {
    await redis.set("teslimat-gunu-bildirildi:" + orderNumber, "1", { ex: 30 * 24 * 3600 });
  } catch (e) {}
}

// 2026-09-18: rehber mesaji da siparis basina SADECE BIR KEZ gitmeli.
async function alreadySentRehber(orderNumber) {
  try {
    const v = await redis.get("rehber-gonderildi:" + orderNumber);
    return !!v;
  } catch (e) {
    // Redis erisilemezse GUVENLI TARAF: mesaj GONDERME (teslimat gunu
    // bayragiyla ayni gerekce - mukerrer mesaj musteriyi rahatsiz eder).
    return true;
  }
}
async function markSentRehber(orderNumber) {
  try {
    await redis.set("rehber-gonderildi:" + orderNumber, "1", { ex: 90 * 24 * 3600 });
  } catch (e) {}
}

// WhatsApp API cevabindan gercek gonderim durumunu cikar
function readWaStatus(waData) {
  try {
    if (waData && waData.messages && waData.messages[0] && waData.messages[0].id) {
      return "Gonderildi OK (" + waData.messages[0].id + ")";
    }
    if (waData && waData.error) {
      const code = waData.error.code != null ? " [" + waData.error.code + "]" : "";
      const msg = waData.error.message || "bilinmeyen hata";
      return "GITMEDI HATA" + code + ": " + msg;
    }
    return "BELIRSIZ: " + JSON.stringify(waData).slice(0, 150);
  } catch (e) {
    return "DURUM OKUNAMADI: " + (e && e.message ? e.message : e);
  }
}

// Teslim basarisiz bildirimini Google Sheets'e yaz (type:teslim_basarisiz)
async function logTeslimBasarisizToSheets(phone, name, orderNumber, branch, status) {
  try {
    if (!process.env.SHEETS_URL) return;
    await fetchWithTimeout(process.env.SHEETS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "teslim_basarisiz",
        phone: phone,
        name: name,
        orderNumber: orderNumber,
        branch: branch,
        status: status
      })
    }, 15000);
  } catch (e) {
    console.error("TESLIM-KONTROL: teslim-basarisiz Sheets log HATA:", e && e.message ? e.message : e);
  }
}

// 2026-09-17 EKLENDI: teslimat gunu hatirlatmasini eski BOTSohbet Google
// Sheets dosyasina yazar ("Teslimat Günü Mesajları" sekmesi).
// Apps Script tarafinda type:"teslimat_gunu" dali hazir ve deploy edilmis durumda.
//
// TEKRAR DENEME YOK (#12558 dersi): Apps Script cevabi bize ulasmasa bile
// satiri cogu zaman ZATEN eklemis oluyor; tekrar denemek mukerrer satir demek.
// Hicbir hata disari yayilmaz - bu kayit patlasa bile musteriye mesaj zaten
// gitmis, Redis bayragi zaten atilmis oluyor.
async function logTeslimatGunuToSheets(orderNumber, name, phone, status) {
  try {
    if (!process.env.SHEETS_URL) return;
    await fetchWithTimeout(process.env.SHEETS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "teslimat_gunu",
        orderNumber: String(orderNumber || ""),
        name: String(name || ""),
        phone: String(phone || ""),
        status: String(status || "")
      })
    }, 15000);
  } catch (e) {
    console.error("TESLIM-KONTROL: teslimat-gunu Sheets log HATA (TEKRAR DENENMIYOR):", e && e.message ? e.message : e);
  }
}

// 2026-09-17 EKLENDI: kapidan donen siparis icin gonderilen IKI mesajin
// (musteriye kurtarma + yetkililere alarm) sonucunu TEK satirda eski BOTSohbet
// Google Sheets dosyasina yazar ("Kapıdan Dönen Mesajları" sekmesi).
// Apps Script tarafinda type:"kapidan_donen_mesaj" dali hazir ve deploy edilmis.
// Tekrar deneme yok, hata disari yayilmaz (yukaridakiyle ayni gerekce).
async function logKapidanDonenMesajToSheets(orderNumber, name, phone, sebep, musteriMesaji, alarm) {
  try {
    if (!process.env.SHEETS_URL) return;
    await fetchWithTimeout(process.env.SHEETS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "kapidan_donen_mesaj",
        orderNumber: String(orderNumber || ""),
        name: String(name || ""),
        phone: String(phone || ""),
        sebep: String(sebep || ""),
        musteriMesaji: String(musteriMesaji || ""),
        alarm: String(alarm || "")
      })
    }, 15000);
  } catch (e) {
    console.error("TESLIM-KONTROL: kapidan-donen-mesaj Sheets log HATA (TEKRAR DENENMIYOR):", e && e.message ? e.message : e);
  }
}

// Kurye teslim edemedi (orn. AAB/MSA) -> musteriye "subeden teslim alabilirsiniz" mesaji
async function sendTeslimBasarisizMesaji(phone, name, orderNumber, branch) {
  let waStatus;
  try {
    const resp = await fetchWithTimeout(
      `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: phone,
          type: "template",
          template: {
            name: TESLIM_BASARISIZ_TEMPLATE,
            language: { code: TESLIM_BASARISIZ_LANG },
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: String(name || "Merhaba") },
                  { type: "text", text: String(orderNumber) },
                  { type: "text", text: String(branch || "en yakın şube") }
                ]
              }
            ]
          }
        })
      },
      12000
    );
    const data = await resp.json().catch(() => ({}));
    console.log("TESLIM-KONTROL: teslim-basarisiz mesaji sonucu:", JSON.stringify(data));
    waStatus = readWaStatus(data);
  } catch (e) {
    console.error("TESLIM-KONTROL: teslim-basarisiz mesaji HATA:", e && e.message ? e.message : e);
    waStatus = "GITMEDI HATA: " + (e && e.message ? e.message : e);
  }
  await logTeslimBasarisizToSheets(phone, name, orderNumber, branch, waStatus);
}

// 5 gun gecmesine ragmen teslim onayi gelmediyse (veya paket bize iade
// edildiyse): fatura KESILMEZ, sadece Google Sheets'e alarm kaydi dusulur
// (manuel kontrol icin). status parametresi verilmezse eski 5-gunluk mesaj kullanilir.
async function logTeslimAlarmToSheets(orderNumber, deneme, status) {
  try {
    if (!process.env.SHEETS_URL) {
      console.error("SHEETS_URL yok, alarm kaydedilemedi:", orderNumber);
      return;
    }
    await fetchWithTimeout(process.env.SHEETS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "fatura_alarm",
        orderNumber: orderNumber,
        deneme: deneme,
        status: status || "5 GUN GECTI - TESLIM ONAYLANAMADI - FATURA KESILMEDI - MANUEL KONTROL GEREKLI"
      })
    }, 15000);
    console.log("TESLIM-KONTROL: alarm Sheets'e kaydedildi:", orderNumber);
  } catch (e) {
    console.error("TESLIM-KONTROL ALARM LOG HATA:", e && e.message ? e.message : e);
  }
}

// Paket musteriye ulasmadan bize (sirkete) iade edildiyse: fatura kesilmez,
// bir kereye mahsus Sheets'e bildirim dusulur (manuel takip icin - yeniden
// gonderim mi, iade mi islenecek sana kalir) ve kalici bir Redis bayragiyla
// bir daha aday listesine girmemesi saglanir (aksi halde 15 gunluk pencere
// boyunca her taramada tekrar tekrar kontrol edilip ayni bildirim tekrarlanirdi).
async function alreadyFlaggedReturnedToCompany(orderNumber) {
  try {
    const v = await redis.get("sirkete-iade-gorundu:" + orderNumber);
    return !!v;
  } catch (e) { return false; }
}
// 2026-09-15 EKLENDI: "kapidan donen" zararini yeni "Masajur Muhasebe" Google
// Sheets dosyasina yazar (Kapıdan Dönen sekmesi).
//
// Onemli tasarim kararlari:
// - process.env.MUHASEBE_SHEETS_URL tanimli degilse sessizce hicbir sey yapmaz.
// - TEKRAR DENEME YOK (#12558 dersi) - Apps Script cevabi bize ulasmasa bile
//   satiri cogu zaman ZATEN eklemis oluyor; tekrar denemek mukerrer satir
//   riski yaratir. Muhasebe tarafinda ayrica siparis no bazli mukerrer
//   kontrolu de var.
// - Hicbir hata disari yayilmaz; bu fonksiyon patlasa bile teslim-kontrol
//   akisi (Redis bayragi + alarm kaydi) zaten tamamlanmis oluyor.
// - Sadece HAM veri gonderiyoruz (tarih, siparis no, sebep). Kargo zarari
//   (549 TL) ve o gunku ortalama reklam maliyeti hesabini Sheets'teki
//   formuller yapiyor - boylece rakamlar degistiginde KOD DEPLOY ETMEDEN
//   sadece Sheets'teki "Sabitler" sekmesi guncellenebiliyor.
async function logKapidanDonenMuhasebe(orderNumber, iadeSebebi) {
  try {
    if (!process.env.MUHASEBE_SHEETS_URL) return;
    const body = JSON.stringify({
      type: "kapidan_donen",
      siparisNo: String(orderNumber),
      tarih: new Date().toISOString(),
      sebep: iadeSebebi ? String(iadeSebebi) : ""
    });
    try {
      const resp = await fetchWithTimeout(process.env.MUHASEBE_SHEETS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body
      }, 15000);
      if (!resp.ok) {
        console.error("MUHASEBE LOG (kapidan donen): HTTP " + resp.status + " - satir yazilmis OLABILIR, TEKRAR DENENMIYOR:", orderNumber);
      }
    } catch (e) {
      console.error("MUHASEBE LOG (kapidan donen) HATA - satir yazilmis OLABILIR, TEKRAR DENENMIYOR:", orderNumber, e && e.message ? e.message : e);
    }
  } catch (e) {
    console.error("MUHASEBE LOG (kapidan donen) HATA:", e && e.message ? e.message : e);
  }
}

// WhatsApp sablon parametreleri satir sonu, sekme veya 4+ ardisik bosluk
// iceremez - Meta bu tur parametreleri reddediyor. Yurtici'den gelen iade
// sebebi metni bunlari icerebildigi icin temizleyip kisaltiyoruz.
function temizleParam_(v, varsayilan) {
  var s = String(v == null ? "" : v)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!s) return varsayilan;
  return s.slice(0, 200);
}

// Musteriye: "siparisiniz bugun teslim edilecek" (kapida vazgecmeyi azaltmak icin)
async function sendTeslimatGunuMesaji(phone, name, orderNumber) {
  if (!phone) {
    console.log("TESLIMAT GUNU: telefon yok, mesaj gonderilemedi:", orderNumber);
    return false;
  }
  try {
    const resp = await fetchWithTimeout(
      `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: phone,
          type: "template",
          template: {
            name: TESLIMAT_GUNU_TEMPLATE,
            language: { code: TESLIMAT_GUNU_LANG },
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: temizleParam_(name, "değerli müşterimiz") }
                ]
              }
            ]
          }
        })
      },
      12000
    );
    const data = await resp.json().catch(() => ({}));
    const waStatus = readWaStatus(data);
    console.log("TESLIMAT GUNU (" + orderNumber + "):", waStatus);
    // Sheets kaydi EN SONDA - mesaj zaten gonderilmis durumda, bu satir
    // yazilamasa bile akista hicbir sey degismiyor.
    await logTeslimatGunuToSheets(orderNumber, name, phone, waStatus);
    return true;
  } catch (e) {
    console.error("TESLIMAT GUNU HATA (" + orderNumber + "):", e && e.message ? e.message : e);
    await logTeslimatGunuToSheets(orderNumber, name, phone, "GITMEDI HATA: " + (e && e.message ? e.message : e));
    return false;
  }
}

// 2026-09-18: musteriye teslimat sonrasi rehber linki.
// Sablon: "teslimat_rehber" (tr) - tek degisken: {{1}} = musteri adi.
// Link sablonun ICINDE sabit metin olarak duruyor, parametre degil.
async function sendRehberMesaji(phone, name, orderNumber) {
  try {
    const resp = await fetchWithTimeout(
      `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: phone,
          type: "template",
          template: {
            name: REHBER_TEMPLATE,
            language: { code: REHBER_LANG },
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: temizleParam_(name, "değerli müşterimiz") }
                ]
              }
            ]
          }
        })
      },
      12000
    );
    const data = await resp.json().catch(() => ({}));
    const waStatus = readWaStatus(data);
    console.log("REHBER MESAJI (" + orderNumber + "):", waStatus);
    return true;
  } catch (e) {
    console.error("REHBER MESAJI HATA (" + orderNumber + "):", e && e.message ? e.message : e);
    return false;
  }
}

// Cagri noktalarindan kullanilan GUVENLI sarmalayici.
// Telefon kontrolu + mukerrer kontrolu + gonderim + bayrak, hepsi burada.
// HICBIR hata disari yayilmaz - fatura akisi bu fonksiyondan etkilenmez.
async function sendRehberMesajiGuvenli(phone, name, orderNumber) {
  try {
    if (!phone) {
      console.log("REHBER: telefon yok, gonderilemedi:", orderNumber);
      return false;
    }
    if (await alreadySentRehber(orderNumber)) {
      console.log("REHBER: zaten gonderilmis, atlandi:", orderNumber);
      return false;
    }
    const sonuc = await sendRehberMesaji(phone, name, orderNumber);
    // Gonderim basarisiz olsa da bayrak atiliyor - mukerrer mesaj riskini
    // tekrar deneme kazancina tercih etmiyoruz (yukaridaki nota bakiniz).
    await markSentRehber(orderNumber);
    return sonuc;
  } catch (e) {
    console.error("REHBER: beklenmeyen hata (FATURA AKISI ETKILENMEDI):", orderNumber, e && e.message ? e.message : e);
    return false;
  }
}

// Musteriye: "paketiniz geri dondu, yeniden gonderelim mi?" (satisi kurtarma)
// 2026-09-17: Sheets kaydi icin gonderim durumunu metin olarak DONDURUYOR.
// Cagiran taraf (isaretleIadeGorulduSirkete) bu metni alarm sonucuyla birlikte
// tek satirda Sheets'e yaziyor.
async function sendKapidanDonenKurtarma(phone, name, orderNumber) {
  if (!phone) {
    console.log("KAPIDAN DONEN KURTARMA: telefon yok, musteriye mesaj gonderilemedi:", orderNumber);
    return "GONDERILMEDI: telefon yok";
  }
  try {
    const resp = await fetchWithTimeout(
      `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: phone,
          type: "template",
          template: {
            name: KAPIDAN_DONEN_KURTARMA_TEMPLATE,
            language: { code: KAPIDAN_DONEN_KURTARMA_LANG },
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: temizleParam_(name, "değerli müşterimiz") },
                  { type: "text", text: temizleParam_(orderNumber, "-") }
                ]
              }
            ]
          }
        })
      },
      12000
    );
    const data = await resp.json().catch(() => ({}));
    const waStatus = readWaStatus(data);
    console.log("KAPIDAN DONEN KURTARMA (" + orderNumber + "):", waStatus);
    return waStatus;
  } catch (e) {
    console.error("KAPIDAN DONEN KURTARMA HATA (" + orderNumber + "):", e && e.message ? e.message : e);
    return "GITMEDI HATA: " + (e && e.message ? e.message : e);
  }
}

// Yetkililere: siparis no + musteri + telefon + sebep
// 2026-09-17: her numaranin sonucunu toplayip tek metin olarak donduruyor
// (Sheets'teki "Yetkili Alarmi" sutununa yazilsin diye).
async function sendKapidanDonenAlarm(orderNumber, musteriAdi, musteriTelefon, sebep) {
  const sonuclar = [];
  for (const numara of ALERT_NUMBERS) {
    try {
      const resp = await fetchWithTimeout(
        `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: numara,
            type: "template",
            template: {
              name: KAPIDAN_DONEN_ALARM_TEMPLATE,
              language: { code: KAPIDAN_DONEN_ALARM_LANG },
              components: [
                {
                  type: "body",
                  parameters: [
                    { type: "text", text: temizleParam_(orderNumber, "-") },
                    { type: "text", text: temizleParam_(musteriAdi, "Bilinmiyor") },
                    { type: "text", text: temizleParam_(musteriTelefon, "Bilinmiyor") },
                    { type: "text", text: temizleParam_(sebep, "Belirtilmemiş") }
                  ]
                }
              ]
            }
          })
        },
        12000
      );
      const data = await resp.json().catch(() => ({}));
      const waStatus = readWaStatus(data);
      console.log("KAPIDAN DONEN ALARM (" + numara + " / " + orderNumber + "):", waStatus);
      sonuclar.push(numara + ": " + waStatus);
    } catch (e) {
      console.error("KAPIDAN DONEN ALARM HATA (" + numara + " / " + orderNumber + "):", e && e.message ? e.message : e);
      sonuclar.push(numara + ": GITMEDI HATA: " + (e && e.message ? e.message : e));
    }
  }
  return sonuclar.join(" | ");
}

async function isaretleIadeGorulduSirkete(orderNumber, iadeSebebi, phone, name) {
  try {
    await redis.set("sirkete-iade-gorundu:" + orderNumber, "1", { ex: 90 * 24 * 3600 });
  } catch (e) {}
  const mesaj = "PAKET MUSTERIYE ULASMADAN SIRKETE IADE EDILDI/REDDEDILDI - FATURA KESILMEDI - MANUEL KONTROL/YENIDEN GONDERIM GEREKEBILIR" +
    (iadeSebebi ? " - Sebep: " + iadeSebebi : "");
  await logTeslimAlarmToSheets(orderNumber, 0, mesaj);
  // Muhasebe kaydi EN SONDA - Redis bayragi ve alarm kaydi bu noktada zaten
  // tamamlanmis durumda, dolayisiyla bu cagri gecikse veya patlasa bile
  // teslim-kontrol akisinda hicbir sey bozulmaz. Bu fonksiyon her iki
  // cagri noktasindan da (normal akis ve tarama) otomatik olarak calisir.
  await logKapidanDonenMuhasebe(orderNumber, iadeSebebi);

  // 2026-09-17 EKLENDI: WhatsApp mesajlari. Bunlar da EN SONDA - Redis
  // bayragi, Sheets alarmi ve muhasebe kaydi bu noktada tamamlanmis durumda.
  // Bu fonksiyon zaten siparis basina SADECE BIR KEZ cagriliyor (cagri
  // noktalarinda alreadyFlaggedReturnedToCompany kontrolu var), dolayisiyla
  // musteriye veya yetkililere mukerrer mesaj gitmez.
  const kurtarmaSonuc = await sendKapidanDonenKurtarma(phone, name, orderNumber);
  const alarmSonuc = await sendKapidanDonenAlarm(orderNumber, name, phone, iadeSebebi);

  // 2026-09-17: iki mesajin sonucu TEK satirda eski BOTSohbet Sheets dosyasina
  // yaziliyor. En sonda - buraya gelindiginde Redis bayragi, fatura alarmi,
  // muhasebe kaydi ve iki WhatsApp mesaji zaten tamamlanmis durumda.
  await logKapidanDonenMesajToSheets(orderNumber, name, phone, iadeSebebi, kurtarmaSonuc, alarmSonuc);
}

// ============ TARAMA MODU (guvenlik agi) ============

const TARAMA_API_VERSION = "2026-04"; // fatura-kes.js ile ayni
// 2026-09-02: 10 ile denendi, Vercel'de FUNCTION_INVOCATION_TIMEOUT alindi
// (Yurtici sorgulari bazen retry'a giriyor, her biri birkac saniye surebiliyor).
// 5'e dusuruldu + vercel.json'da maxDuration 60'a cikarildi - guvenli marj icin.
const TARAMA_BATCH_SIZE = 5;
// BILINCLI KARAR (2026-09-02): sadece YENI siparislerin arada kaybolmamasi
// icin var, GECMISE dokunmuyor. Gecmis eksik faturalari kullanici manuel
// hallediyor. Pencere kucuk tutuluyor ki tarama fiziksel olarak eski
// siparislere hic erisemesin (Redis bayragi/Shopify etiketi ne olursa olsun).
const TARAMA_LOOKBACK_DAYS = 15;
const TARAMA_MIN_AGE_HOURS = 30;      // normal akisa (1 gun sonra ilk kontrol) yetecek kadar sure taninsin

function normalizeTelefon(raw) {
  if (!raw) return "";
  let d = String(raw).replace(/[^0-9]/g, "");
  if (!d) return "";
  if (d.startsWith("0")) d = "90" + d.slice(1);
  if (!d.startsWith("90")) d = "90" + d;
  return d;
}

// Shopify'dan son N gunde olusturulmus tum siparisleri ceker (sayfalama dahil).
async function fetchTumSiparisler(gunler) {
  const minDate = new Date(Date.now() - gunler * 24 * 3600 * 1000).toISOString();
  const fields = "id,name,phone,tags,cancelled_at,customer,shipping_address,fulfillments,created_at";
  let url = `https://${process.env.SHOPIFY_STORE}/admin/api/${TARAMA_API_VERSION}/orders.json` +
    `?status=any&created_at_min=${encodeURIComponent(minDate)}&limit=250&fields=${fields}`;
  let tumu = [];
  let sayfa = 0;
  while (url && sayfa < 5) { // guvenlik siniri: en fazla 5 sayfa (~1250 siparis)
    sayfa++;
    const r = await fetchWithTimeout(url, {
      headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_TOKEN, "Content-Type": "application/json" }
    }, 20000);
    if (!r.ok) {
      console.error("TARAMA: Shopify siparis listesi alinamadi, HTTP", r.status);
      break;
    }
    const data = await r.json().catch(() => ({}));
    if (Array.isArray(data.orders)) tumu = tumu.concat(data.orders);
    const link = (r.headers.get && (r.headers.get("link") || r.headers.get("Link"))) || null;
    const match = link && link.match(/<([^>]+)>;\s*rel="next"/);
    url = match ? match[1] : null;
  }
  return tumu;
}

// Taramaya aday mi: iptal edilmemis, zaten faturalanmamis, en az bir kargoya
// verilmis "fulfillment" kaydi var ve yeterince eski (normal akisa sans taninmis).
function taramaAdayiMi(order, simdiMs) {
  if (order.cancelled_at) return false;
  const tags = order.tags ? order.tags.split(",").map(t => t.trim()) : [];
  if (tags.includes("fatura-kesildi")) return false;
  if (!order.fulfillments || order.fulfillments.length === 0) return false;
  const fulfillment = order.fulfillments[0];
  const sevkTarihi = fulfillment && fulfillment.created_at ? new Date(fulfillment.created_at) : new Date(order.created_at);
  const yasSaat = (simdiMs - sevkTarihi.getTime()) / 3600000;
  return yasSaat >= TARAMA_MIN_AGE_HOURS;
}

async function taramaCursorOku() {
  try {
    const v = await redis.get("tarama-cursor");
    return v ? Number(v) : 0;
  } catch (e) { return 0; }
}
async function taramaCursorYaz(v) {
  try { await redis.set("tarama-cursor", String(v)); } catch (e) {}
}

async function logTaramaOzetToSheets(ozet) {
  try {
    if (!process.env.SHEETS_URL) return;
    await fetchWithTimeout(process.env.SHEETS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "tarama", status: ozet })
    }, 15000);
  } catch (e) {}
}

async function handleTarama(req, res) {
  const secret = req.query && req.query.secret;
  if (secret !== SECRET) {
    console.error("TARAMA: gecersiz secret");
    return res.status(401).send("Unauthorized");
  }
  if (!process.env.SHOPIFY_STORE || !process.env.SHOPIFY_TOKEN) {
    console.error("TARAMA: SHOPIFY_STORE/SHOPIFY_TOKEN tanimli degil");
    return res.status(200).send("OK - shopify bilgisi yok, tarama yapilamadi");
  }

  try {
    const simdi = Date.now();
    const tumSiparisler = await fetchTumSiparisler(TARAMA_LOOKBACK_DAYS);

    let adaylar = tumSiparisler
      .filter(o => taramaAdayiMi(o, simdi))
      .map(o => ({ order: o, no: parseInt(String(o.name).replace(/[^0-9]/g, ""), 10) }))
      .filter(x => !isNaN(x.no))
      .sort((a, b) => a.no - b.no);

    // Ek guvenlik: Shopify etiketi eksik olsa bile Redis'teki kalici
    // "faturalandi" bayragini da kontrol et - fatura-kes.js'teki ayni anahtar
    // (bkz. #12642 vakasi: Shopify etiketleme sessizce basarisiz olabiliyordu).
    if (adaylar.length > 0) {
      try {
        const flags = await redis.mget(...adaylar.map(x => "fatura-kesildi:" + x.no));
        adaylar = adaylar.filter((x, i) => !flags[i]);
      } catch (e) {
        console.error("TARAMA: Redis mget hatasi, filtreleme atlandi:", e && e.message ? e.message : e);
      }
    }
    // Zaten "sirkete iade edildi" olarak isaretlenmis siparisleri de atla -
    // bunlar hic bir zaman gercek DLV'ye donmeyecek, her taramada tekrar
    // sorgulamaya (ve mukerrer bildirime) gerek yok.
    if (adaylar.length > 0) {
      try {
        const iadeFlags = await redis.mget(...adaylar.map(x => "sirkete-iade-gorundu:" + x.no));
        adaylar = adaylar.filter((x, i) => !iadeFlags[i]);
      } catch (e) {
        console.error("TARAMA: Redis mget hatasi (iade), filtreleme atlandi:", e && e.message ? e.message : e);
      }
    }

    console.log("TARAMA: toplam siparis:", tumSiparisler.length, "aday:", adaylar.length);

    if (adaylar.length === 0) {
      await logTaramaOzetToSheets("0 aday bulundu (hepsi faturali/iptal/cok yeni) - toplam bakilan: " + tumSiparisler.length);
      return res.status(200).send("OK - aday yok");
    }

    const cursor = await taramaCursorOku();
    let baslangic = adaylar.findIndex(x => x.no > cursor);
    if (baslangic === -1) baslangic = 0; // listenin sonuna gelindi, basa don

    const parti = adaylar.slice(baslangic, baslangic + TARAMA_BATCH_SIZE);
    let faturaSayisi = 0, bildirimSayisi = 0, kontrolSayisi = 0;
    const detaylar = [];

    for (const { order, no } of parti) {
      kontrolSayisi++;
      const detail = await getKargoDetail(String(no));
      console.log("TARAMA:", no, "->", JSON.stringify(detail));

      if (detail && detail.gercekTeslim) {
        await triggerFatura(String(no));
        // 2026-09-18: normal akis bu siparisi kacirdiysa rehber mesajini
        // tarama gondersin. Redis bayragi ortak oldugu icin iki yoldan da
        // tetiklense musteriye yalnizca BIR mesaj gider.
        const rehberTelefon = normalizeTelefon(order.phone || (order.shipping_address && order.shipping_address.phone));
        const rehberMusteriAdi =
          (order.customer && ((order.customer.first_name || "") + " " + (order.customer.last_name || "")).trim()) ||
          (order.shipping_address && order.shipping_address.name) ||
          "";
        await sendRehberMesajiGuvenli(rehberTelefon, rehberMusteriAdi, String(no));
        faturaSayisi++;
        detaylar.push(no + ":FATURA");
      } else if (detail && detail.sirketeIadeEdildi) {
        // Paket musteriye ulasmadan bize geri donmus - fatura kesilmez,
        // aday listesinden dusmesi icin kalici bir isaret birak (bir kereye
        // mahsus bildirim, tekrar tekrar aynisini dusurmesin).
        const zatenIsaretli = await alreadyFlaggedReturnedToCompany(String(no));
        if (!zatenIsaretli) {
          // 2026-09-17: musteriye kurtarma mesaji ve yetkililere alarm
          // gonderebilmek icin telefon/isim bilgisini Shopify siparisinden
          // cikariyoruz (normal akista bunlar zaten QStash govdesinden geliyor).
          const iadeTelefon = normalizeTelefon(order.phone || (order.shipping_address && order.shipping_address.phone));
          const iadeMusteriAdi =
            (order.customer && ((order.customer.first_name || "") + " " + (order.customer.last_name || "")).trim()) ||
            (order.shipping_address && order.shipping_address.name) ||
            "";
          await isaretleIadeGorulduSirkete(String(no), detail.iadeSebebi, iadeTelefon, iadeMusteriAdi);
        }
        detaylar.push(no + ":SIRKETE-IADE");
      } else if (detail && detail.reasonId && DAGITIMA_CIKTI_REASON_CODES.includes(detail.reasonId)) {
        // 2026-09-17: normal akis (saatlik QStash zinciri) bu siparisi bir
        // sekilde kacirmissa tarama da teslimat gunu mesajini gonderebilsin.
        // Redis bayragi ortak oldugu icin iki yoldan da tetiklense musteriye
        // yalnizca BIR mesaj gider.
        const dagitimTelefon = normalizeTelefon(order.phone || (order.shipping_address && order.shipping_address.phone));
        if (dagitimTelefon) {
          const zatenBildirildi = await alreadyNotifiedTeslimatGunu(String(no));
          if (!zatenBildirildi) {
            const dagitimMusteriAdi =
              (order.customer && ((order.customer.first_name || "") + " " + (order.customer.last_name || "")).trim()) ||
              (order.shipping_address && order.shipping_address.name) ||
              "";
            await sendTeslimatGunuMesaji(dagitimTelefon, dagitimMusteriAdi, String(no));
            await markNotifiedTeslimatGunu(String(no));
            bildirimSayisi++;
            detaylar.push(no + ":TESLIMAT-GUNU");
          } else {
            detaylar.push(no + ":DAGITIMDA");
          }
        } else {
          detaylar.push(no + ":DAGITIMDA(telefon-yok)");
        }
      } else if (detail && detail.reasonId && FAILED_REASON_CODES.includes(detail.reasonId)) {
        const phone = normalizeTelefon(order.phone || (order.shipping_address && order.shipping_address.phone));
        if (phone) {
          const already = await alreadyNotifiedFailed(String(no));
          if (!already) {
            const musteriAdi =
              (order.customer && ((order.customer.first_name || "") + " " + (order.customer.last_name || "")).trim()) ||
              (order.shipping_address && order.shipping_address.name) ||
              "Merhaba";
            await sendTeslimBasarisizMesaji(phone, musteriAdi, String(no), detail.branch);
            await markNotifiedFailed(String(no));
            bildirimSayisi++;
            detaylar.push(no + ":BILDIRIM(" + detail.reasonId + ")");
          }
        }
      } else {
        detaylar.push(no + ":" + (detail ? detail.status || "BILINMIYOR" : "SORGU-BASARISIZ"));
      }
      await new Promise(r => setTimeout(r, 250)); // Yurtici/Shopify'i yormayalim
    }

    const sonIndex = baslangic + TARAMA_BATCH_SIZE;
    const yeniCursor = sonIndex >= adaylar.length ? 0 : parti[parti.length - 1].no;
    await taramaCursorYaz(yeniCursor);

    const ozet = kontrolSayisi + " siparis kontrol edildi, " + faturaSayisi + " fatura tetiklendi, " +
      bildirimSayisi + " musteri bildirimi gonderildi (teslim-basarisiz + teslimat-gunu) (toplam aday: " + adaylar.length + ") - " +
      detaylar.join(", ");
    console.log("TARAMA OZET:", ozet);
    await logTaramaOzetToSheets(ozet);

    return res.status(200).send("OK - " + ozet);
  } catch (error) {
    console.error("TARAMA HATA:", error && error.message ? error.message : error);
    return res.status(200).send("OK - tarama hatasi: " + (error && error.message ? error.message : error));
  }
}

// ============ /TARAMA MODU ============

module.exports = async (req, res) => {
  if (req.method === "GET" && req.query && req.query.mod === "tarama") {
    return handleTarama(req, res);
  }

  if (req.method === "GET" && req.query && req.query.mod === "debug-kargo") {
    return handleDebugKargo(req, res);
  }

  if (req.method !== "POST") return res.status(200).send("OK");

  const secret = req.query && req.query.secret;
  if (secret !== SECRET) {
    console.error("TESLIM-KONTROL: gecersiz secret");
    return res.status(401).send("Unauthorized");
  }

  try {
    const body = req.body || {};
    const orderNumber = body.orderNumber ? String(body.orderNumber) : "";
    const deneme = body.deneme || 1;
    const phone = body.phone ? String(body.phone) : "";
    const name = body.name ? String(body.name) : "Merhaba";

    if (!orderNumber) {
      // Normalde hic olmamasi gereken bir durum (fatura-baslat.js ve QStash
      // recheck'i her zaman orderNumber gonderir) ama "hicbir sey sessizce
      // kaybolmasin" ilkesi geregi bunu da Sheets'e dusuruyoruz - en azindan
      // boyle bir cagrinin oldugu goze carpsin.
      console.error("TESLIM-KONTROL: siparis no yok");
      await logTeslimAlarmToSheets("BILINMIYOR", 0,
        "SISTEM UYARISI: teslim-kontrol.js siparis numarasi OLMADAN cagrildi - hangi siparis oldugu belirlenemedi, tetikleyen kodu kontrol edin");
      return res.status(200).send("OK");
    }

    console.log("TESLIM-KONTROL:", orderNumber, "deneme:", deneme);

    const detail = await getKargoDetail(orderNumber);
    console.log("TESLIM-KONTROL DURUM:", orderNumber, "->", JSON.stringify(detail));

    if (detail && detail.gercekTeslim) {
      await triggerFatura(orderNumber);
      // 2026-09-18: fatura tetiklendikten SONRA rehber linki. Bu cagri
      // kendi icinde try/catch'li - patlasa bile yukaridaki fatura
      // tetiklemesi zaten tamamlanmis durumda, akis bozulmaz.
      const rehberAdi = (name && name !== "Merhaba") ? name : "";
      await sendRehberMesajiGuvenli(phone, rehberAdi, orderNumber);
      return res.status(200).send("OK - teslim edildi, fatura tetiklendi");
    }

    // Paket musteriye ulasmadan bize (sirkete) iade edildiyse: fatura kesme,
    // tekrar tekrar denemeyi durdur, bir kereye mahsus Sheets'e bildir.
    if (detail && detail.sirketeIadeEdildi) {
      console.log("TESLIM-KONTROL: paket musteriye ulasmadan sirkete iade edildi, fatura kesilmeyecek:", orderNumber);
      const zatenIsaretli = await alreadyFlaggedReturnedToCompany(orderNumber);
      if (!zatenIsaretli) {
        // name varsayilani "Merhaba" oldugu icin sablona oyle gitmesin -
        // gercek isim yoksa bos gec, sablon tarafi "değerli müşterimiz" yazar.
        const iadeMusteriAdi = (name && name !== "Merhaba") ? name : "";
        await isaretleIadeGorulduSirkete(orderNumber, detail.iadeSebebi, phone, iadeMusteriAdi);
      }
      return res.status(200).send("OK - paket sirkete iade edildi, fatura kesilmedi");
    }

    // 2026-09-17: paket kuryeye zimmetlendiyse (GOK) musteriye bir kereye
    // mahsus "bugun teslim edilecek" hatirlatmasi gonder. Buraya ancak paket
    // TESLIM EDILMEMISSE ve GERI DONMEMISSE geliniyor (ikisi de yukarida
    // return ediyor), yani mesaj sadece paket gercekten kuryenin elindeyken
    // gidiyor. Akisin geri kalanini hic etkilemiyor - mesaj gitse de gitmese
    // de asagidaki tekrar zamanlama aynen calisiyor.
    if (detail && detail.reasonId && DAGITIMA_CIKTI_REASON_CODES.includes(detail.reasonId) && phone) {
      const zatenBildirildi = await alreadyNotifiedTeslimatGunu(orderNumber);
      if (!zatenBildirildi) {
        console.log("TESLIM-KONTROL: paket dagitima cikti (" + detail.reasonId + "), teslimat gunu mesaji gonderiliyor:", orderNumber);
        const musteriAdi = (name && name !== "Merhaba") ? name : "";
        await sendTeslimatGunuMesaji(phone, musteriAdi, orderNumber);
        await markNotifiedTeslimatGunu(orderNumber);
      }
    }

    // Kurye teslim edemedi (orn. "AAB"/"MSA") ve musteriye daha once bildirim
    // gonderilmediyse: bir kereye mahsus "subeden teslim alabilirsiniz" mesajini gonder.
    if (detail && detail.reasonId && FAILED_REASON_CODES.includes(detail.reasonId) && phone) {
      const already = await alreadyNotifiedFailed(orderNumber);
      if (!already) {
        console.log("TESLIM-KONTROL: teslim basarisiz (" + detail.reasonId + "), bildirim gonderiliyor:", orderNumber);
        await sendTeslimBasarisizMesaji(phone, name, orderNumber, detail.branch);
        await markNotifiedFailed(orderNumber);
      }
    }

    if (deneme >= MAX_DENEME) {
      console.error("TESLIM-KONTROL: max deneme asildi (5 gun), siparis:", orderNumber);
      await logTeslimAlarmToSheets(orderNumber, deneme);
      return res.status(200).send("OK - 5 gun asildi, alarm kaydedildi, fatura kesilmedi");
    }

    await scheduleRecheck(orderNumber, deneme, phone, name);
    return res.status(200).send("OK - henuz teslim edilmedi, tekrar zamanlandi");
  } catch (error) {
    console.error("TESLIM-KONTROL HATA:", error && error.message ? error.message : error);
    // Hata olsa da tekrar dene (aginin gecici sorunu olabilir) - ama 5 gunluk
    // sinira ulasildiysa burada da alarm dusur, sonsuz donguye girmesin.
    try {
      const body = req.body || {};
      const deneme = body.deneme || 1;
      const phone = body.phone ? String(body.phone) : "";
      const name = body.name ? String(body.name) : "Merhaba";
      if (body.orderNumber) {
        if (deneme >= MAX_DENEME) {
          console.error("TESLIM-KONTROL: max deneme asildi (hata yolunda), siparis:", body.orderNumber);
          await logTeslimAlarmToSheets(String(body.orderNumber), deneme);
        } else {
          await scheduleRecheck(String(body.orderNumber), deneme, phone, name);
        }
      }
    } catch (e2) {}
    return res.status(200).send("OK");
  }
};
