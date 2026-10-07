// api/webhook-process.js
// QStash tarafindan (webhook.js'in devrettigi) cagrilir. Asil is burada:
// Shopify siparis + Yurtici kargo + Claude -> WhatsApp cevabi.
// Bu dosyanin webhook.js'den ayri olmasinin tek sebebi: Meta'nin 5sn
// kuralindan bagimsiz olarak, Yurtici/Claude yavas oldugunda bile rahat
// calisabilsin (vercel.json'da bu fonksiyona artik 90sn suresi tanimli -
// hesap Vercel Pro'da, bkz. 2026-09-05 notu asagida).
//
// Yurtici Kargo sorgusu artik ../lib/yurtici.js'deki ORTAK istemciyi kullanir
// (webhook-process.js, teslim-kontrol.js ve yorum.js ayni koddan besleniyor -
// QuotaGuard proxy + devre kesici + retry mantigi tek yerde).
//
// + Her mesaj Google Sheets'e kaydedilir (SHEETS_URL).
// + Riskli kelimelerde yetkililere 'temsilci_bildirim' sablonu gonderilir.
// + Konusma hafizasi (Upstash Redis): son mesajlar hatirlanir.
// + Mukerrer isleme korumasi (Redis kilidi, wamid bazli): QStash veya Meta
//   ayni mesaji birden fazla kez teslim etse bile bot ayni soruya sadece
//   BIR KERE cevap yazar.
//
// 2026-09-05 DUZELTME (musterilerin gordugu "kisa bir yogunluk yasiyoruz"
// mesaji cok sik cikiyordu): Claude'a (chat.js) giden ic istege sadece 9
// SANIYE sure taniniyordu - yapay zeka cevabi (ozellikle uzun cevaplarda
// veya yogun saatlerde) bundan kolayca uzun surebiliyor, bu da GERCEK bir
// yogunluk olmasa bile musteriye otomatik "yogunluk" mesaji gitmesine yol
// aciyordu. Hesap artik Vercel Pro'da ve bu fonksiyonun suresi 90 saniyeye
// cikarildigi icin: (1) chat.js'e taninan sure 9sn -> 40sn'ye cikarildi,
// (2) musteriye giden asil WhatsApp cevabi gonderimi eskiden HICBIR zaman
// asimi olmadan (sinirsiz bekleyebilen ciplak bir fetch ile) yapiliyordu -
// bu da teorik olarak fonksiyonu sonsuza kadar bekletip QStash'in mesaji
// tekrar denemesine (ve mukerrer cevaba) yol acabilirdi; artik diger tum
// WhatsApp cagrilarindaki gibi zaman asimli (15sn) yapiliyor.
//
// 2026-09-05 IKINCI (KRITIK) DUZELTME: jsonFetch() basarisiz HTTP
// durumlarini (4xx/5xx) kontrol etmiyordu, bu yuzden /api/chat herhangi bir
// nedenle (Anthropic API hatasi, gecersiz cevap, coken istek) basarisiz
// oldugunda, gercek musteriye GUZEL "yogunluk" mesaji DEGIL, chat.js'in ic
// fallback metni olan cıplak "Yanıt oluşturulamadı." yazisi WHATSAPP
// CEVABI OLARAK gonderiliyordu. Artik jsonFetch basarisiz HTTP durumunda
// hata firlatiyor, boylece asagidaki catch bloku devreye girip dogru
// "yogunluk" mesajini gonderiyor. Ayrica bkz. api/chat.js'teki es zamanli
// duzeltme (Anthropic cevabini kontrol etme).
//
// 2026-09-08 DUZELTME (musteri cevabini ETKILEMEYEN, sadece kayit
// tarafinda gorulen "SHEETS LOG HATA: This operation was aborted" hatasi):
// logToSheets() musteriye WhatsApp cevabi zaten gonderildikten SONRA
// calisiyor, dolayisiyla bu hata musteri deneyimini hicbir zaman etkilemedi
// - sadece o mesajin Sheets'e (dashboard/log) dusmemesine yol aciyordu.
// Muhtemel sebep: Google Apps Script tarafinin ara sira gecici yavasligi/
// soguk baslangici, 8sn'lik zaman asimini asiyordu. Artik basarisiz olursa
// kisa bir bekleme sonrasi otomatik olarak toplam 3 kez denenir; ucu de
// basarisiz olursa yine akisi bozmadan (musteri etkilenmeden) sadece
// hatayi loglar.

const { Redis } = require("@upstash/redis");
const redis = Redis.fromEnv();
const yurtici = require("../lib/yurtici");

const BASE = "https://masajur-ai-proxy.vercel.app";
const SECRET = "masajur_yakkoholding_2128";

// ============================================================
// YURTICI KARGO SORGUSU (../lib/yurtici.js ile ORTAK istemci)
// ============================================================
// Musteri sohbeti oldugu icin teslim-kontrol.js/yorum.js'in arka plan
// devre kesicisinden AYRI anahtar kullanir - biri tikanirsa digeri etkilenmez.
const cb = yurtici.createCircuitBreaker("yurtici-cb-canli");

function ykParseXml(raw, key) {
  if (!raw) return { found: false, reason: "not_found", orderNumber: key };

  const operationMessage = raw.operationMessage;
  const operationStatus = raw.operationStatus;

  if (!operationMessage && !operationStatus && !raw.cargoEventExplanation) {
    return { found: false, reason: "not_found", orderNumber: key };
  }

  return {
    found: true, orderNumber: key,
    statusMessage: operationMessage, statusCode: operationStatus,
    lastEvent: raw.cargoEventExplanation || null,
    lastUnit: raw.deliveryUnitName || null,
    lastCity: null,
    lastDate: null,
    reasonId: raw.cargoReasonId || null,
    reasonExplanation: raw.cargoReasonExplanation || null,
    // 2026-09-02 DUZELTME: eskiden "operationStatus === 'DLV'" yeterli
    // sayiliyordu, ama Yurtici paket bize (sirkete) iade oldugunda da
    // DLV donduruyor - bu durumda receiverCustName musterinin degil KENDI
    // SIRKETIMIZIN adi oluyor. Musteriye yanlislikla kendi sirket adimizi
    // "teslim alan siz" gibi gostermemek icin, ve asagidaki gercekTeslim/
    // sirketeIadeEdildi alanlariyla dogru ayrimi yapabilmek icin bu iki alan
    // eklendi. deliveredTo artik SADECE gercek musteri teslimatinda dolduruluyor.
    gercekTeslim: raw.gercektenMusteriyeTeslimEdildi,
    sirketeIadeEdildi: raw.sirketeIadeEdildi,
    deliveredTo: raw.gercektenMusteriyeTeslimEdildi ? raw.receiverCustName : null,
    trackingUrl: raw.trackingUrl
  };
}

async function getKargoInfo(orderNumber) {
  const key = String(orderNumber).replace(/[^0-9]/g, "");
  if (!key) return { found: false, reason: "no_number" };

  const raw = await yurtici.queryShipment(key, cb, "WEBHOOK-PROCESS");
  if (!raw) return { found: false, reason: "error" };
  return ykParseXml(raw, key);
}
// ============================================================

// --- Konusma hafizasi + mukerrer isleme kilidi (Upstash Redis) ---
const HISTORY_MAX = 20;          // tutulacak son mesaj sayisi (user+assistant)
const HISTORY_TTL = 172800;      // 2 gun (saniye)

async function getHistory(phone) {
  try {
    const h = await redis.get("chat:" + phone);
    return Array.isArray(h) ? h : [];
  } catch (e) {
    console.error("HAFIZA OKUMA HATA:", e && e.message ? e.message : e);
    return [];
  }
}

async function saveHistory(phone, history) {
  try {
    const trimmed = history.slice(-HISTORY_MAX);
    await redis.set("chat:" + phone, trimmed, { ex: HISTORY_TTL });
  } catch (e) {
    console.error("HAFIZA YAZMA HATA:", e && e.message ? e.message : e);
  }
}

// Ayni WhatsApp mesajini (wamid) iki kere islemeyi engeller.
async function acquireMessageLock(messageId) {
  try {
    const result = await redis.set("wa-msg-lock:" + messageId, "1", { nx: true, ex: 3600 });
    return result !== null; // null donerse zaten islenmis/isleniyor demek
  } catch (e) {
    console.error("MESAJ KILIDI HATA, guvenli taraf - devam ediliyor:", e && e.message ? e.message : e);
    return true;
  }
}
// -----------------------------------------

// Sorun/sikayet sinyali veren kelimeler (kucuk harf, Turkce karakterli):
const ALERT_KEYWORDS = [
  "şikayet", "sikayet", "şikayetçi", "sikayetci", "şikayetçiyim", "sikayetciyim",
  "memnun değil", "memnun degil", "memnun kalmadım", "memnun kalmadim",
  "dolandırıcı", "dolandirici", "dolandırıldım", "dolandirildim",
  "avukat", "bozuk", "çalışmıyor", "calismiyor", "kırık", "kirik",
  "arızalı", "arizali", "para iadesi", "rezalet"
];

// Bildirim gidecek yetkili numaralar (90 formatinda):
const ALERT_NUMBERS = ["905530681619", "905511485344"];

const ALERT_TEMPLATE = "temsilci_bildirim";
const ALERT_TEMPLATE_LANG = "tr";

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function jsonFetch(url, body, ms) {
  const resp = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    },
    ms
  );
  // 2026-09-05 KRITIK DUZELTME: resp.ok kontrolu YOKTU - /api/chat hata
  // durumunda (Anthropic API'den 401/429/5xx veya kendi catch'inde 500)
  // yine de 200 sanip JSON'u okuyorduk. Ozellikle /api/chat cagrisinda bu,
  // musteriye asagidaki guzel "yogunluk" mesaji yerine chat.js'in ic
  // fallback metni olan cıplak "Yanıt oluşturulamadı." yazisinin GERCEK
  // WHATSAPP CEVABI olarak gitmesine yol aciyordu. Artik basarisiz HTTP
  // durumunda hata firlatiliyor, boylece asagidaki catch bloklari (ve
  // /api/chat cagrisi icin dogru "yogunluk" mesaji) devreye giriyor.
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error("HTTP " + resp.status + " " + url + ": " + errText.slice(0, 300));
  }
  return await resp.json();
}

function bekle(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Sohbeti Google Sheets'e yaz (hata olsa bile akisi bozma).
// 2026-09-08: Bu fonksiyon musteriye WhatsApp cevabi ZATEN gonderildikten
// sonra calisiyor - dolayisiyla basarisiz olsa bile musteri hicbir zaman
// etkilenmez, sadece o mesaj Sheets'teki log/dashboard'a dusmez. Ara sira
// gorulen "This operation was aborted" (zaman asimi) icin artik kisa bir
// bekleme ile toplam 3 kez deneniyor; hepsi basarisiz olursa sadece
// hatayi loglayip vazgeciyor.
// 2026-10-07 DUZELTME (MUKERRER SHEETS KAYDI - analizleri bozuyordu):
// Yukaridaki 3 denemeli yapi, Google Apps Script zaman asimina ugradiginda
// AYNI SATIRI tekrar gonderiyordu. Apps Script ise cevabi bize
// ulastiramasa bile satiri COGU ZAMAN ZATEN EKLEMIS oluyor - yani
// "cevap alamadim" ile "yazilamadi" ayirt edilemiyor. Sonuc: tek bir bot
// cevabi Sheets'e 2-3 kez dusuyordu (8sn zaman asimi + 1sn bekleme = tam
// 9 saniye arayla; 06.10'da tek mesaj 3 satir olarak gorundu).
//
// Bu sadece bir gorunum sorunu degil: "Musteri Konusmalari" sayfasi hem
// gunluk analiz botunun (analiz.js) hem de elle yapilan incelemelerin
// girdisi. Mukerrer satirlar mesaj sayilarini ve "bot kendini tekrar
// ediyor" turu tespitleri yanlis gosteriyor.
//
// fatura-kes.js'te ayni ders #12558 vakasinda ogrenilmis ve orada tekrar
// deneme KALDIRILMISTI. Burasi atlanmis. Artik burada da tek seferlik:
// nadiren kaybolan bir log satiri, sikca mukerrer gorunen satirdan cok
// daha az zararli.
//
// ==========================================================================
// 2026-10-07 (AKSAM) NIHAI COZUM - "ya mukerrer ya kayip" ikileminin sonu
// ==========================================================================
// 07.10 loglarinda olcum: tek gunde 43 istek zaman asimina ugrayip 2./3.
// denemede kurtarilmis (~50 fazladan satir), 16 istek ise 3 denemede de
// basarisiz olmus. Yani tekrar deneme VARKEN mukerrer satir, YOKKEN kayip
// satir uretiyorduk. Ayni dert kargo/fatura/sepet/yorum/teslim uclarinda da
// goruldu - sorun bu dosyada degil, ortak Apps Script ucunda.
//
// Cozum tek tarafli olamazdi, iki parcali:
//   1) Apps Script tarafi artik "id" alaninı taniyor. Ayni id ikinci kez
//      gelirse satiri YAZMIYOR, "mukerrer: true" deyip aninda donuyor.
//      (CacheService'te 6 saat tutuluyor; tekrar denemeler saniyeler icinde
//      oldugu icin fazlasiyla yeterli.)
//   2) Boylece tekrar deneme ARTIK GUVENLI: id sayesinde kac kez
//      denersek deneyelim en fazla tek satir olusur.
//
// id olarak WhatsApp'in kendi mesaj kimligi (wamid) kullaniliyor - zaten
// benzersiz ve mukerrer isleme kilidinde de ayni deger kullaniliyor.
//
// Sure butcesi: en fazla 2 deneme x 12sn + 0,5sn bekleme = ~24,5 saniye.
// Bu fonksiyon musteriye cevap GONDERILDIKTEN sonra calisiyor, yani bu
// bekleme musteriyi hicbir sekilde etkilemiyor.
const SHEETS_LOG_DENEME_SAYISI = 2;
const SHEETS_LOG_ZAMAN_ASIMI_MS = 12000;
const SHEETS_LOG_DENEME_ARASI_MS = 500;

async function logToSheets(phone, message, reply, kayitId) {
  if (!process.env.SHEETS_URL) return;

  const govde = JSON.stringify({
    id: kayitId || "",     // Apps Script bununla mukerreri eliyor
    phone: phone,
    message: message,
    reply: reply
  });

  for (let deneme = 1; deneme <= SHEETS_LOG_DENEME_SAYISI; deneme++) {
    const basladi = Date.now();
    try {
      const resp = await fetchWithTimeout(
        process.env.SHEETS_URL,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: govde
        },
        SHEETS_LOG_ZAMAN_ASIMI_MS
      );
      // Cevabi okuyoruz ki Apps Script'in kendi olctugu sureyi (ms) ve
      // satirin mukerrer sayilip sayilmadigini loga dusurebilelim.
      // Boylece "8 saniye nereye gidiyor" sorusu tahmin olmaktan cikiyor.
      const metin = await resp.text().catch(() => "");
      console.log(
        "SHEETS LOG OK (deneme " + deneme + ", " + (Date.now() - basladi) + "ms):",
        String(metin).slice(0, 200)
      );
      return;
    } catch (e) {
      const hataMetni = e && e.message ? e.message : e;
      const gecen = Date.now() - basladi;
      if (deneme < SHEETS_LOG_DENEME_SAYISI) {
        console.error(
          "SHEETS LOG ZAMAN ASIMI (deneme " + deneme + "/" + SHEETS_LOG_DENEME_SAYISI +
          ", " + gecen + "ms), tekrar deneniyor - id sayesinde mukerrer olusmaz:",
          hataMetni
        );
        await bekle(SHEETS_LOG_DENEME_ARASI_MS);
      } else {
        console.error(
          "SHEETS LOG BASARISIZ (son deneme " + deneme + "/" + SHEETS_LOG_DENEME_SAYISI +
          ", " + gecen + "ms), vazgeciliyor:",
          hataMetni
        );
      }
    }
  }
}

// Tek bir yetkiliye temsilci_bildirim sablonu gonder
async function sendAlertTo(toNumber, customerPhone, customerMessage) {
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
          to: toNumber,
          type: "template",
          template: {
            name: ALERT_TEMPLATE,
            language: { code: ALERT_TEMPLATE_LANG },
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: String(customerPhone) },
                  { type: "text", text: String(customerMessage).slice(0, 250) }
                ]
              }
            ]
          }
        })
      },
      6000
    );
    const data = await resp.json();
    console.log("ALERT SONUCU (" + toNumber + "):", JSON.stringify(data));
  } catch (e) {
    console.error("ALERT HATA (" + toNumber + "):", e && e.message ? e.message : e);
  }
}

// ============================================================
// VIDEO GONDERME (2026-09-29 EKLENDI)
// ------------------------------------------------------------
// chat.js, botun cevabini dondururken "medya" alanini da doldurabiliyor
// ("tanitim" veya "fizyoterapist"). Burada once yazili cevap gonderiliyor,
// hemen ardindan ilgili video WhatsApp uzerinden iletiliyor.
//
// Videolar deponun kokunde duruyor ve Vercel tarafindan halka acik servis
// ediliyor; WhatsApp linki kendisi indirip musteriye gonderiyor.
// WhatsApp video siniri: mp4, en fazla 16 MB.
//
// 2026-09-30: 24 SAATLIK KILIT KALDIRILDI.
// Eskiden her numara+video icin Redis'te 24 saatlik bir isaret
// birakiliyordu ve ayni video bir daha gonderilmiyordu. Sonuc: video bir
// kez gidemediginde (ya da test sirasinda gittiginde) gercek musteriye
// 24 saat boyunca hic gitmiyordu - bot "paylasiyorum" diyor, hicbir sey
// gelmiyordu. Artik bot video gondermeye karar verdiyse video GIDER.
// Ayni mesajin iki kez islenmesi zaten acquireMessageLock ile engelli.
// ============================================================
const MEDYA = {
  tanitim: {
    link: BASE + "/masajur-tanitim.mp4",
    aciklama: "Masajur — kullanım ve özellikler"
  },
  fizyoterapist: {
    link: BASE + "/masajur-fizyoterapist.mp4",
    aciklama: "Masajur — uzman anlatımı"
  }
};

// ============================================================
// VIDEO GARANTISI (2026-10-01)
// ------------------------------------------------------------
// Sorun: musteri "urun hakkinda bilgi almak istiyorum" dediginde videonun
// GITMESI gerekiyordu, ama karar modele (prompt'a) birakilmisti. Veriye
// baktik: bilgi isteyen 234 mesajin sadece 64'unde video isareti vardi.
// Yani musterilerin ~%70'i urunu HIC GORMEDEN fiyati duydu.
//
// Cozum: karari koda aliyoruz. Musterinin mesaji bilgi/gorme talebiyse ve
// model isaret koymayi atladiysa, videoyu BIZ ekliyoruz. Prompt'a guvenmek
// yerine garanti.
// ============================================================

// Bilgi / gorme talebi kaliplari. Reklamin hazir butonu da burada.
const BILGI_TALEBI_KALIPLARI = [
  "hakkında bilgi", "hakkinda bilgi", "bilgi almak", "bilgi alabilir",
  "bilgi verir", "bilgi verebilir", "bilgi istiyorum", "bilgi rica",
  "masajur nedir", "nedir bu", "ne işe yar", "ne ise yar",
  "anlatır mısın", "anlatir misin", "tanıtır mısın", "tanitir misin",
  "detay", "video", "videosu", "görsel", "gorsel", "fotoğraf", "fotograf",
  "resmini", "resim", "nasıl bir şey", "nasil bir sey", "neye benziyor",
  "görebilir miyim", "gorebilir miyim", "göster", "goster"
];

// Satin almis musteriler: bunlar satis konusmasi degil, destek konusmasi.
// Kargo/iade/fatura derdi olan birine tanitim videosu atmak sacma durur.
const MEDYA_ZORLAMA_HARIC = [
  "kargo", "iade", "fatura", "değişim", "degisim", "garanti", "arıza", "ariza",
  "bozuk", "çalışmıyor", "calismiyor", "şikayet", "sikayet", "nerede",
  "teslim", "gelmedi", "para", "ödeme yaptım", "odeme yaptim", "sipariş no",
  "siparis no", "takip", "geri gönder", "geri gonder",
  "sipariş detay", "siparis detay", "siparişim", "siparisim",
  "siparişimi", "siparisimi", "aldığım ürün", "aldigim urun"
];

function bilgiTalebiMi(mesaj) {
  const s = String(mesaj || "").toLowerCase();
  if (!s) return false;
  if (MEDYA_ZORLAMA_HARIC.some(function (k) { return s.includes(k); })) return false;
  return BILGI_TALEBI_KALIPLARI.some(function (k) { return s.includes(k); });
}

// Bu numaraya bu video bu sohbette BASARIYLA gonderildi mi?
// Not: isaret SADECE basarili gonderimden SONRA birakiliyor. Basarisiz
// gonderim hicbir seyi kilitlemiyor - eski hata tam buydu.
const MEDYA_SOHBET_TTL = 21600; // 6 saat ~ bir sohbet oturumu

function medyaIsaretAnahtari(phone, anahtar) {
  return "medya-gonderildi:" + phone + ":" + anahtar;
}

async function medyaZatenGittiMi(phone, anahtar) {
  try {
    const v = await redis.get(medyaIsaretAnahtari(phone, anahtar));
    return !!v;
  } catch (e) {
    // Redis okunamiyorsa gondermeyi tercih ediyoruz: eksik video,
    // tekrar eden videodan daha kotu.
    console.error("MEDYA ISARET OKUNAMADI, gonderime devam:", e && e.message ? e.message : e);
    return false;
  }
}

async function medyaIsaretiBirak(phone, anahtar) {
  try {
    await redis.set(medyaIsaretAnahtari(phone, anahtar), "1", { ex: MEDYA_SOHBET_TTL });
  } catch (e) {
    console.error("MEDYA ISARETI YAZILAMADI:", e && e.message ? e.message : e);
  }
}

// Video gonderir. Basarili olursa true doner.
// WhatsApp basarili gonderimde messages[0].id donuyor; hata durumunda
// HTTP 200 ile bile "error" alani gelebiliyor - ikisine de bakiyoruz.
async function sendMedya(phone, anahtar) {
  const medya = MEDYA[anahtar];
  if (!medya) {
    console.error("MEDYA: taninmayan anahtar:", anahtar);
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
          type: "video",
          video: { link: medya.link, caption: medya.aciklama }
        })
      },
      25000
    );
    const data = await resp.json().catch(function () { return {}; });
    console.log("MEDYA SONUCU (" + anahtar + "):", JSON.stringify(data).slice(0, 400));
    const basarili = !!(
      data && data.messages && data.messages[0] && data.messages[0].id
    ) && !(data && data.error);
    if (!basarili) {
      console.error("MEDYA GONDERILEMEDI (" + anahtar + "), HTTP " + resp.status);
    }
    return basarili;
  } catch (e) {
    // Video gidemezse musteri yazili cevabi zaten aldi - akisi bozma.
    console.error("MEDYA GONDERME HATA (" + anahtar + "):", e && e.message ? e.message : e);
    return false;
  }
}

// Video gidemediginde ya da 24 saat kilidi yuzunden atlandiginda musteri
// bos kalmasin: bot "paylasiyorum" dedi, elinde bir sey olmali. Videonun
// linkini yaziyla gonderiyoruz - 12 MB'lik dosyayi tekrar atmadan.
async function sendMedyaLinki(phone, anahtar) {
  const medya = MEDYA[anahtar];
  if (!medya) return;
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
          type: "text",
          text: {
            preview_url: true,
            body: "Videoyu buradan izleyebilirsiniz:\n" + medya.link
          }
        })
      },
      15000
    );
    const data = await resp.json().catch(function () { return {}; });
    console.log("MEDYA LINKI SONUCU (" + anahtar + "):", JSON.stringify(data).slice(0, 300));
  } catch (e) {
    console.error("MEDYA LINKI HATA (" + anahtar + "):", e && e.message ? e.message : e);
  }
}

// Mesajda riskli kelime var mi?
function needsAlert(message) {
  const lower = String(message).toLowerCase();
  return ALERT_KEYWORDS.some(function (k) { return lower.includes(k); });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("OK");

  const secret = req.query && req.query.secret;
  if (secret !== SECRET) {
    console.error("WEBHOOK-PROCESS: gecersiz secret");
    return res.status(401).send("Unauthorized");
  }

  console.log("WEBHOOK-PROCESS TETIKLENDI");

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0]?.text?.body;
    const phone = value?.messages?.[0]?.from;
    const messageId = value?.messages?.[0]?.id;

    console.log("MESAJ:", message);
    console.log("TELEFON:", phone);

    if (!message || !phone) {
      console.log("MESAJ VEYA TELEFON YOK");
      return res.status(200).send("OK");
    }

    // Mukerrer isleme korumasi - ayni mesaj (wamid) daha once islendiyse dur.
    if (messageId) {
      const kilitAlindi = await acquireMessageLock(messageId);
      if (!kilitAlindi) {
        console.log("WEBHOOK-PROCESS: bu mesaj zaten islendi, atlaniyor:", messageId);
        return res.status(200).send("OK - zaten islendi");
      }
    }

    // Bu musterinin gecmis konusmasini Redis'ten cek
    const history = await getHistory(phone);
    console.log("HAFIZA UZUNLUGU:", history.length);

    // ---------------------------------------------------------
    // SIPARIS + KARGO SORGUSU
    // ---------------------------------------------------------
    let orderNote = "";

    const lower = message.toLowerCase();
    const orderIntent =
      lower.includes("sipariş") ||
      lower.includes("siparis") ||
      lower.includes("kargo") ||
      lower.includes("takip") ||
      lower.includes("nerede");

    const hashMatch = message.match(/#\s*(\d{3,})/);
    const numMatch = message.match(/\b(\d{3,})\b/);
    const orderNumber = hashMatch ? hashMatch[1] : (numMatch ? numMatch[1] : null);

    if (orderNumber) {
      console.log("SIPARIS SORGUSU:", orderNumber);

      const sipPromise = jsonFetch(BASE + "/api/siparis", { orderNumber }, 8000)
        .then((d) => { console.log("SIPARIS SONUCU:", JSON.stringify(d)); return d; })
        .catch((e) => { console.error("SIPARIS HATA:", e?.message || e); return null; });

      // Artik ayri bir HTTP cagrisi degil, dogrudan yukaridaki getKargoInfo()
      // fonksiyonu cagriliyor - hem daha hizli hem daha guvenilir.
      const kargoPromise = getKargoInfo(orderNumber)
        .then((d) => { console.log("KARGO SONUCU:", JSON.stringify(d)); return d; })
        .catch((e) => { console.error("KARGO HATA:", e?.message || e); return null; });

      const [sip, kargo] = await Promise.all([sipPromise, kargoPromise]);

      if ((sip && sip.found) || (kargo && kargo.found)) {
        orderNote =
          "[SİPARİŞ & KARGO BİLGİSİ - Aşağıdaki gerçek bilgileri kullanarak müşteriye doğal, sıcak ve net bir dille cevap ver. Asla bilgi uydurma, sadece bunları kullan. Kargo GERÇEKTEN müşteriye teslim edildiyse bunu olumlu söyle; yoldaysa nerede olduğunu ve güncel durumunu söyle. Aşağıda başka bir yönlendirme varsa (örn. şirkete iade notu) onu MUTLAKA önceliklendir ve 'teslim edildi' diye olumlu sunma.]\n";

        if (sip && sip.found) {
          orderNote += "Sipariş No: " + sip.orderName + "\n";
          orderNote += "Sipariş Durumu: " + sip.status + "\n";
          orderNote += "Ödeme: " + sip.payment + "\n";
        } else {
          orderNote += "Sipariş No: " + orderNumber + "\n";
        }

        if (kargo && kargo.found && kargo.sirketeIadeEdildi) {
          // 2026-09-02 KRITIK DUZELTME: Yurtici, paket musteriye ulasmadan
          // bize (sirkete) geri dondugunde de operationStatus="DLV" ("teslim
          // edildi") donduruyor. Bunu duzeltmeden once bot musteriye "kargonuz
          // teslim edildi" diye YANLISLIKLA olumlu haber veriyordu, oysa paket
          // hicbir zaman musteriye ulasmamisti. Artik bu durumda net ve
          // dogru bir aciklama + acik bir "olumlu sunma" talimati veriliyor.
          orderNote += "Kargo Durumu: Paket müşteriye ulaştırılamadı, kargo firması tarafından şirketimize iade edildi.\n";
          orderNote += "[ÖNEMLİ SİSTEM NOTU: Bu siparişi KESİNLİKLE 'teslim edildi' diye olumlu sunma - paket müşteriye ulaşmadan bize geri döndü. Müşteriye durumu nazik ve net biçimde açıkla, yeniden gönderim veya iade konusunda ekibimizin ilgileneceğini belirt; gerekirse 0553 068 16 19 / 0551 148 53 44 numaralarını paylaş.]\n";
          if (kargo.lastEvent) orderNote += "Son Hareket: " + kargo.lastEvent + "\n";
          if (kargo.lastUnit) orderNote += "Bulunduğu Yer: " + kargo.lastUnit + "\n";
          if (kargo.reasonExplanation) orderNote += "Not: " + kargo.reasonExplanation + "\n";
          if (kargo.trackingUrl) orderNote += "Takip Linki: " + kargo.trackingUrl + "\n";
        } else if (kargo && kargo.found) {
          if (kargo.statusMessage) orderNote += "Kargo Durumu: " + kargo.statusMessage + "\n";
          if (kargo.lastEvent) orderNote += "Son Hareket: " + kargo.lastEvent + "\n";
          if (kargo.lastUnit) orderNote += "Bulunduğu Yer: " + kargo.lastUnit + (kargo.lastCity ? " (" + kargo.lastCity + ")" : "") + "\n";
          if (kargo.reasonExplanation) orderNote += "Not: " + kargo.reasonExplanation + "\n";
          if (kargo.lastDate) orderNote += "Son Güncelleme: " + kargo.lastDate + "\n";
          if (kargo.gercekTeslim && kargo.deliveredTo) orderNote += "Teslim Alan: " + kargo.deliveredTo + "\n";
          if (kargo.trackingUrl) orderNote += "Takip Linki: " + kargo.trackingUrl + "\n";
        } else {
          // ONEMLI: Yurtici'den anlik cevap gelmedi diye "henuz kargoya
          // verilmedi" diye TAHMIN YURUTME - sip.status (yukarida) zaten
          // dogru bilgiyi veriyor olabilir, onunla celismesin.
          orderNote += "Kargo Durumu: Şu an Yurtiçi Kargo sisteminden anlık takip bilgisine ulaşılamadı (sistem yoğun olabilir). Yukarıdaki Sipariş Durumu bilgisi geçerlidir; 'henüz kargoya verilmedi' gibi kesin bir iddia kullanma, sadece canlı takip verisinin şu an çekilemediğini söyle.\n";
        }
      } else if ((sip && sip.reason === "not_found") && (!kargo || !kargo.found)) {
        orderNote =
          "[SİSTEM NOTU: " + orderNumber + " numaralı sipariş bulunamadı. Müşteriye nazikçe sipariş numarasını kontrol etmesini söyle; emin değilse 0553 068 16 19 veya 0551 148 53 44 numaralarından yardımcı olunabileceğini belirt. Numara uydurma.]";
      } else {
        orderNote =
          "[SİSTEM NOTU: Sipariş/kargo bilgisine şu an ulaşılamadı. Müşteriye nazikçe biraz sonra tekrar denemesini ya da 0553 068 16 19 / 0551 148 53 44 numaralarından ulaşmasını söyle.]";
      }
    } else if (orderIntent) {
      orderNote =
        "[SİSTEM NOTU: Müşteri siparişini/kargosunu soruyor ama sipariş numarası vermedi. Ondan sipariş numarasını (#1234 gibi) iste ki kargo durumunu kontrol edebilesin. Doğal ve samimi bir dille sor.]";
    }
    // ---------------------------------------------------------

    console.log("CLAUDE'A GONDERILIYOR");

    const claudeMessage = orderNote
      ? orderNote + "\n\nMüşteri mesajı: " + message
      : message;

    let reply = "Yanıt oluşturulamadı.";
    let medyaAnahtari = null;
    try {
      // 2026-09-05 DUZELTME: 9sn -> 40sn. Eskiden Claude'un cevabi 9 saniyeyi
      // gecerse (yogun saatlerde/uzun cevaplarda sik oluyordu) musteri GERCEK
      // bir yogunluk olmasa bile asagidaki hazir "yogunluk" mesajini goruyordu.
      // Hesap artik Vercel Pro'da ve bu fonksiyonun toplam suresi 90sn oldugu
      // icin 40sn'lik bir bekleme rahatlikla sigiyor.
      // 2026-09-05 UCUNCU (ASIL) DUZELTME: chat.js'e daha once eklenen
      // ?secret=... korumasi bu cagriya hic eklenmemisti - bu yuzden HER
      // musteri mesajinda chat.js 401 "gecersiz secret" donuyor, bot da
      // (yukaridaki iki duzeltmeden once) bunu sessizce "Yanıt
      // oluşturulamadı." olarak musteriye yolluyordu. Asil kok sebep
      // buydu - Anthropic API ile ilgisi yoktu.
      const claudeData = await jsonFetch(
        BASE + "/api/chat?secret=" + SECRET,
        // 2026-10-01: telefon da gidiyor. chat.js bunu sistem notu olarak
        // bota veriyor, bot artik musteriden telefon numarasi istemiyor -
        // siparis akisinda bir adim eksildi.
        { message: claudeMessage, history: history, phone: phone },
        40000
      );
      reply = claudeData.reply || reply;
      medyaAnahtari = claudeData.medya || null;
    } catch (e) {
      console.error("CLAUDE HATA:", e?.message || e);
      reply = "Şu an kısa bir yoğunluk yaşıyoruz, birkaç dakika sonra tekrar yazabilir misiniz? Acil ise 0553 068 16 19 veya 0551 148 53 44 numaralarından bize ulaşabilirsiniz 🙂";
    }

    console.log("WHATSAPP'A GONDERILIYOR:", reply);

    // 2026-09-05 DUZELTME: bu istek eskiden zaman asimi OLMADAN (ciplak
    // fetch) yapiliyordu - teorik olarak sonsuza kadar askida kalip
    // fonksiyonu (ve dolayisiyla QStash'in mesaji tekrar denemesini,
    // mukerrer cevap riskini) tetikleyebilirdi. Artik dosyadaki diger tum
    // WhatsApp cagrilariyla ayni desende, zaman asimli.
    const whatsappResponse = await fetchWithTimeout(
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
          type: "text",
          text: { body: reply }
        })
      },
      15000
    );

    const whatsappData = await whatsappResponse.json();
    console.log("WHATSAPP SONUCU:", JSON.stringify(whatsappData));

    // Bot video gondermeye karar verdiyse, yazili cevabin HEMEN ardindan gonder.
    // Once yazi, sonra video - dogal sira bu.
    // --- VIDEO ---
    // Model isaret koyduysa onu kullan. Koymadiysa ve musteri bilgi/gorme
    // talebinde bulunduysa videoyu BIZ ekliyoruz (yukaridaki VIDEO GARANTISI).
    let medyaZorlandi = false;
    if (!medyaAnahtari && bilgiTalebiMi(message)) {
      medyaAnahtari = "fizyoterapist";
      medyaZorlandi = true;
      console.log("MEDYA ZORLANDI (model isaret koymamis, mesaj bilgi talebi):", medyaAnahtari);
    }

    if (medyaAnahtari && MEDYA[medyaAnahtari]) {
      // Model kendi karariyla isaret koyduysa kilit dinlemiyoruz: musteri
      // "video gelmedi", "tekrar atar misin" demis olabilir, o zaman gitmeli.
      // Sadece BIZIM zorladigimiz gonderim, ayni sohbette tekrar etmesin
      // diye isarete bakiyor.
      const atla = medyaZorlandi && (await medyaZatenGittiMi(phone, medyaAnahtari));
      if (atla) {
        console.log("MEDYA ATLANDI (bu sohbette zaten gonderilmis):", medyaAnahtari);
      } else {
        console.log("MEDYA GONDERILIYOR:", medyaAnahtari, medyaZorlandi ? "(zorlandi)" : "(model)");
        const gitti = await sendMedya(phone, medyaAnahtari);
        if (gitti) {
          await medyaIsaretiBirak(phone, medyaAnahtari);
        } else {
          // Video gercekten gidemedi (WhatsApp dosyayi cekemedi, token,
          // zaman asimi...). Isaret BIRAKILMIYOR - tekrar denenebilsin.
          // Musteri de bos kalmasin: linki yaziyla ver.
          await sendMedyaLinki(phone, medyaAnahtari);
        }
      }
    }

    // Bu turu hafizaya ekle (ham musteri mesaji + botun cevabi)
    history.push({ role: "user", content: message });
    history.push({ role: "assistant", content: reply });
    await saveHistory(phone, history);

    // Sohbeti Sheets'e kaydet
    // 2026-10-07: wamid artik Sheets'e de gonderiliyor - Apps Script ayni
    // kimlikli ikinci istegi yazmadan geri ceviriyor (mukerrer satir sonu).
    await logToSheets(phone, message, reply, messageId);

    // Riskli kelime varsa yetkililere bildir
    if (needsAlert(message)) {
      console.log("ALERT TETIKLENDI");
      for (const num of ALERT_NUMBERS) {
        await sendAlertTo(num, phone, message);
      }
    }

    return res.status(200).send("OK");
  } catch (error) {
    console.error("WEBHOOK-PROCESS HATA:", error);
    return res.status(200).send("OK");
  }
};
