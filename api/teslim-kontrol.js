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
    reasonId: raw.cargoReasonId,          // orn. "AAB"/"MSA"
    reasonExplanation: raw.cargoReasonExplanation,
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
    }, 25000);
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
    }, 8000);
  } catch (e) {
    console.error("TESLIM-KONTROL: teslim-basarisiz Sheets log HATA:", e && e.message ? e.message : e);
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
      8000
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
    }, 8000);
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
async function isaretleIadeGorulduSirkete(orderNumber, iadeSebebi) {
  try {
    await redis.set("sirkete-iade-gorundu:" + orderNumber, "1", { ex: 90 * 24 * 3600 });
  } catch (e) {}
  const mesaj = "PAKET MUSTERIYE ULASMADAN SIRKETE IADE EDILDI/REDDEDILDI - FATURA KESILMEDI - MANUEL KONTROL/YENIDEN GONDERIM GEREKEBILIR" +
    (iadeSebebi ? " - Sebep: " + iadeSebebi : "");
  await logTeslimAlarmToSheets(orderNumber, 0, mesaj);
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
    }, 15000);
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
    }, 8000);
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
        faturaSayisi++;
        detaylar.push(no + ":FATURA");
      } else if (detail && detail.sirketeIadeEdildi) {
        // Paket musteriye ulasmadan bize geri donmus - fatura kesilmez,
        // aday listesinden dusmesi icin kalici bir isaret birak (bir kereye
        // mahsus bildirim, tekrar tekrar aynisini dusurmesin).
        const zatenIsaretli = await alreadyFlaggedReturnedToCompany(String(no));
        if (!zatenIsaretli) await isaretleIadeGorulduSirkete(String(no), detail.iadeSebebi);
        detaylar.push(no + ":SIRKETE-IADE");
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
      bildirimSayisi + " teslim-basarisiz bildirimi gonderildi (toplam aday: " + adaylar.length + ") - " +
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
      return res.status(200).send("OK - teslim edildi, fatura tetiklendi");
    }

    // Paket musteriye ulasmadan bize (sirkete) iade edildiyse: fatura kesme,
    // tekrar tekrar denemeyi durdur, bir kereye mahsus Sheets'e bildir.
    if (detail && detail.sirketeIadeEdildi) {
      console.log("TESLIM-KONTROL: paket musteriye ulasmadan sirkete iade edildi, fatura kesilmeyecek:", orderNumber);
      const zatenIsaretli = await alreadyFlaggedReturnedToCompany(orderNumber);
      if (!zatenIsaretli) await isaretleIadeGorulduSirkete(orderNumber, detail.iadeSebebi);
      return res.status(200).send("OK - paket sirkete iade edildi, fatura kesilmedi");
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
