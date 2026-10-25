// ============================================================
// api/siparis-onay.js  -  SIPARIS ONAY MESAJI (2026-10-25)
// ------------------------------------------------------------
// NE YAPAR: Siteden bir siparis olustugu anda musteriye WhatsApp'tan
// "siparisiniz olusturuldu" bilgilendirme mesaji gonderir.
//
// NEDEN AYRI DOSYA: api/siparis-kayit.js zaten orders/create webhook'unu
// aliyor ve muhasebe Sheets'ine yaziyor. O dosyaya dokunmuyoruz - orada
// cikacak bir hata muhasebe kaydini bozardi. Shopify ayni konuya BIRDEN
// FAZLA webhook tanimlamaya izin veriyor, bu yuzden bu dosya kendi
// webhook'uyla besleniyor. Biri patlarsa digeri calismaya devam eder.
//
// KURULUM (Shopify yoneticisi > Ayarlar > Bildirimler > Webhook'lar):
//   Konu     : Siparis olusturma (orders/create)
//   Format   : JSON
//   URL      : https://masajur-ai-proxy.vercel.app/api/siparis-onay?secret=masajur_yakkoholding_2128
//   Versiyon : 2026-04
//
// META SABLONU (Bilgilendirme / Turkce, 4 parametre):
//   {{1}} ad, {{2}} siparis no, {{3}} urun, {{4}} tutar
//
// TEST:
//   GET ?mod=test&secret=...                  -> ayarlari gosterir, mesaj GONDERMEZ
//   GET ?mod=dene&telefon=905...&secret=...   -> o numaraya ornek mesaj gonderir
// ============================================================

const { Redis } = require("@upstash/redis");
const redis = Redis.fromEnv();

const SECRET = "masajur_yakkoholding_2128";

// 2026-10-25: "siparis_alindi" ve "siparis_alindi_v2" ayni anda
// incelemeye girdi; once v2 onaylandi, onu kullaniyoruz.
const TEMPLATE = "siparis_alindi_v2";
const TEMPLATE_LANG = "tr";

// Ayni siparis icin ikinci kez mesaj gitmesin. Shopify webhook'u
// cevap alamazsa TEKRAR DENIYOR - bu bayrak olmazsa musteri ayni
// mesaji iki kez alir.
const GONDERILDI = "siparis-onay:";
const GONDERILDI_OMRU = 30 * 24 * 3600;   // 30 gun

// Kendi numaralarimiz - test siparislerinde kendimize mesaj atmayalim
const ALERT_NUMBERS = ["905530681619", "905511485344"];

// Isim bulunamazsa
const AD_YEDEK = "değerli müşterimiz";

function normalizeTelefon(ham) {
  if (!ham) return "";
  let d = String(ham).replace(/[^0-9]/g, "");
  if (!d) return "";
  if (d.startsWith("0")) d = "90" + d.slice(1);
  if (!d.startsWith("90")) d = "90" + d;
  // 90 + 10 hane = 12
  return d.length === 12 ? d : "";
}

// Telefon birden fazla yerde olabiliyor; EasySell kapida odeme formu
// shipping_address.phone'a yaziyor, kartli odeme customer.phone'a.
function telefonBul(siparis) {
  const adaylar = [
    siparis && siparis.shipping_address && siparis.shipping_address.phone,
    siparis && siparis.customer && siparis.customer.phone,
    siparis && siparis.billing_address && siparis.billing_address.phone,
    siparis && siparis.phone
  ];
  for (const a of adaylar) {
    const n = normalizeTelefon(a);
    if (n) return n;
  }
  return "";
}

function adBul(siparis) {
  const s = siparis || {};
  const kaynaklar = [
    s.shipping_address && s.shipping_address.first_name,
    s.customer && s.customer.first_name,
    s.billing_address && s.billing_address.first_name
  ];
  for (const k of kaynaklar) {
    const t = String(k || "").trim();
    if (t) {
      // "AHMET" -> "Ahmet"
      return t.charAt(0).toLocaleUpperCase("tr-TR") +
             t.slice(1).toLocaleLowerCase("tr-TR");
    }
  }
  return AD_YEDEK;
}

// Hediye kalemleri (0 TL) urun adinda gorunmesin - musteri "ne siparis
// ettim" diye bakiyor, hediyeler zaten pakette.
function urunBul(siparis) {
  const kalemler = (siparis && siparis.line_items) || [];
  const ucretli = kalemler.filter(function (k) {
    return Number(k && k.price ? k.price : 0) > 0;
  });
  const secili = ucretli.length ? ucretli : kalemler;
  const adlar = secili.map(function (k) {
    const ad = String((k && k.title) || "").trim();
    const adet = Number((k && k.quantity) || 1);
    return adet > 1 ? ad + " x" + adet : ad;
  }).filter(Boolean);
  if (!adlar.length) return "Masajur";
  // Sablon parametresinde satir sonu YASAK, tek satirda birlestiriyoruz
  return adlar.join(" + ").slice(0, 120);
}

function tutarBul(siparis) {
  const s = siparis || {};
  const ham = s.current_total_price || s.total_price || "";
  const sayi = Number(String(ham).replace(",", "."));
  if (!isFinite(sayi) || sayi <= 0) return "";
  // 5699 -> "5.699 TL"
  return sayi.toLocaleString("tr-TR", { maximumFractionDigits: 0 }) + " TL";
}

function siparisNoBul(siparis) {
  const s = siparis || {};
  if (s.name) return String(s.name);
  if (s.order_number) return "#" + s.order_number;
  return "";
}

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, ms || 12000);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

// WhatsApp HTTP 200 dondurup icinde "error" verebiliyor - ikisine de bak.
function durumOku(data) {
  if (data && data.messages && data.messages[0] && data.messages[0].id && !data.error) {
    return "Gonderildi OK (" + data.messages[0].id + ")";
  }
  if (data && data.error) {
    return "GITMEDI: " + (data.error.message || JSON.stringify(data.error)).slice(0, 200);
  }
  return "GITMEDI: beklenmeyen cevap";
}

async function sablonGonder(telefon, ad, no, urun, tutar) {
  try {
    const resp = await fetchWithTimeout(
      "https://graph.facebook.com/v23.0/" + process.env.WHATSAPP_PHONE_NUMBER_ID + "/messages",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + process.env.WHATSAPP_TOKEN,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: telefon,
          type: "template",
          template: {
            name: TEMPLATE,
            language: { code: TEMPLATE_LANG },
            components: [{
              type: "body",
              parameters: [
                { type: "text", text: ad },
                { type: "text", text: no },
                { type: "text", text: urun },
                { type: "text", text: tutar }
              ]
            }]
          }
        })
      },
      15000
    );
    const data = await resp.json().catch(function () { return {}; });
    return durumOku(data);
  } catch (e) {
    return "GITMEDI HATA: " + (e && e.message ? e.message : e);
  }
}

// Sheets'e iz birak. Apps Script'te "siparis_onay" dali yoksa kayit
// "Bilinmeyen Kayitlar" guvenlik agina duser - veri kaybolmaz.
async function sheetsYaz(no, telefon, durum) {
  try {
    if (!process.env.SHEETS_URL) return;
    await fetchWithTimeout(process.env.SHEETS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "siparis_onay",
        id: "siparis-onay-" + no,
        siparisNo: String(no || ""),
        phone: String(telefon || ""),
        status: String(durum || "")
      })
    }, 12000);
  } catch (e) {
    console.error("SIPARIS ONAY: Sheets yazilamadi:", e && e.message ? e.message : e);
  }
}

// Bu siparis icin daha once mesaj gitti mi? Gitmediyse isaretle.
// Donen: true = ILK kez, gonderebilirsin. false = zaten gitmis.
async function ilkKezMi(anahtar) {
  try {
    const sonuc = await redis.set(GONDERILDI + anahtar, "1", {
      nx: true, ex: GONDERILDI_OMRU
    });
    return sonuc === "OK";
  } catch (e) {
    // Redis okunamiyorsa gondermemeyi tercih ediyoruz: mukerrer mesaj,
    // eksik mesajdan daha kotu (musteri "siparisim iki kere mi dustu"
    // diye paniklyor ve destek yukü aciyor).
    console.error("SIPARIS ONAY: Redis hatasi, gonderim atlandi:", e && e.message ? e.message : e);
    return false;
  }
}

// ============ TEST MODLARI ============
async function handleTest(req, res) {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  return res.status(200).send(
    "=== SIPARIS ONAY (TEST MODU - MESAJ GONDERILMEDI) ===\n" +
    "Sablon        : " + TEMPLATE + " (" + TEMPLATE_LANG + ")\n" +
    "Parametreler  : {{1}} ad, {{2}} siparis no, {{3}} urun, {{4}} tutar\n" +
    "WhatsApp ID   : " + (process.env.WHATSAPP_PHONE_NUMBER_ID ? "tanimli" : ">>> EKSIK <<<") + "\n" +
    "WhatsApp Token: " + (process.env.WHATSAPP_TOKEN ? "tanimli" : ">>> EKSIK <<<") + "\n" +
    "Sheets URL    : " + (process.env.SHEETS_URL ? "tanimli" : "yok (log yazilmaz)") + "\n" +
    "Mukerrer kilit: " + GONDERILDI + "<siparis no>, " + (GONDERILDI_OMRU / 86400) + " gun\n\n" +
    "Gercek gonderim icin Shopify webhook'u su adrese baglanmali:\n" +
    "  POST /api/siparis-onay?secret=...   (konu: orders/create)\n\n" +
    "Tek numaraya ornek mesaj:\n" +
    "  ?mod=dene&telefon=905551112233&secret=...\n"
  );
}

async function handleDene(req, res) {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  const telefon = normalizeTelefon((req.query && req.query.telefon) || "");
  if (!telefon) {
    return res.status(200).send("telefon parametresi gerekli.\nOrnek: ?mod=dene&telefon=905551112233&secret=...");
  }
  const durum = await sablonGonder(
    telefon, "Test", "#TEST", "Evdeki Terapistiniz Original V1", "5.699 TL"
  );
  return res.status(200).send(
    "DENEME GONDERIMI\n  telefon: " + telefon + "\n  durum  : " + durum + "\n\n" +
    "'durum' OK degilse sablon henuz onaylanmamis olabilir.\n"
  );
}

// ============ GERCEK CALISMA ============
module.exports = async (req, res) => {
  const secret = req.query && req.query.secret;
  if (secret !== SECRET) {
    console.error("SIPARIS ONAY: gecersiz secret");
    return res.status(401).send("Unauthorized");
  }

  if (req.method === "GET") {
    const mod = (req.query && req.query.mod) || "test";
    if (mod === "dene") return handleDene(req, res);
    return handleTest(req, res);
  }

  if (req.method !== "POST") return res.status(200).send("OK");

  // Shopify webhook'u cevap gecikirse TEKRAR GONDERIYOR. Isi bitirip
  // 200 donuyoruz; hata olsa bile 200 doneriz, yoksa Shopify ayni
  // siparisi saatlerce yeniden dener.
  try {
    const siparis = req.body || {};
    const no = siparisNoBul(siparis);
    const telefon = telefonBul(siparis);

    if (!no) {
      console.error("SIPARIS ONAY: siparis no yok, atlandi");
      return res.status(200).send("OK - siparis no yok");
    }
    if (!telefon) {
      console.log("SIPARIS ONAY ATLANDI (" + no + "): telefon bulunamadi");
      await sheetsYaz(no, "", "ATLANDI: telefon yok");
      return res.status(200).send("OK - telefon yok");
    }
    if (ALERT_NUMBERS.includes(telefon)) {
      console.log("SIPARIS ONAY ATLANDI (" + no + "): kendi numaramiz");
      return res.status(200).send("OK - kendi numaramiz");
    }

    const ilk = await ilkKezMi(no);
    if (!ilk) {
      console.log("SIPARIS ONAY ATLANDI (" + no + "): zaten gonderilmis");
      return res.status(200).send("OK - zaten gonderilmis");
    }

    const ad = adBul(siparis);
    const urun = urunBul(siparis);
    const tutar = tutarBul(siparis);

    if (!urun || !tutar) {
      console.error("SIPARIS ONAY (" + no + "): urun/tutar eksik, gonderilmedi");
      await sheetsYaz(no, telefon, "ATLANDI: urun/tutar eksik");
      return res.status(200).send("OK - eksik veri");
    }

    const durum = await sablonGonder(telefon, ad, no, urun, tutar);
    console.log("SIPARIS ONAY (" + no + " / " + telefon + "):", durum);
    await sheetsYaz(no, telefon, durum);

    return res.status(200).send("OK - " + durum);
  } catch (error) {
    console.error("SIPARIS ONAY HATA:", error && error.message ? error.message : error);
    return res.status(200).send("OK - hata loglandi");
  }
};
