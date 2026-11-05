// api/kargo-takip.js
//
// 2026-11-05 YENI: KARGO TAKIP NUMARASI MESAJI
//
// NE YAPAR:
//   Shopify'da bir gonderiye TAKIP NUMARASI islendiginde musteriye
//   "kargo_takip_v1" sablonuyla takip numarasini ve takip linkini gonderir.
//
// NEDEN AYRI DOSYA (api/fulfillment.js'e eklenmedi):
//   fulfillment.js'te siparis basina tek seferlik bir Redis kilidi var
//   ("kargo-bildirimi-yapildi:<siparis no>", 90 gun). Shopify takip
//   numarasini sonradan ekledigi icin ikinci bir fulfillment olayi doguyor,
//   ama o olay bu kilide takilip sessizce eleniyor. Takip mesajini oraya
//   eklesek HIC GONDERILMEZDI. Bu yuzden burasi kendi kilidiyle, kendi
//   webhook'uyla (Shopify "Gonderim guncellemesi" / fulfillments/update)
//   calisan ayri bir akis.
//
// KILIT:
//   "kargo-takip-gonderildi:<siparis no>:<takip no>" (NX, 90 gun).
//   Takip numarasi da anahtara dahil - boylece fulfillments/update her
//   durum degisikliginde (yola cikti, dagitimda, teslim edildi) tekrar
//   tetiklense bile mesaj BIR KERE gider; ama kargo degisip YENI bir takip
//   numarasi verilirse musteri yeni numarayi alir.
//
// SABLON (kargo_takip_v1, tr) - Meta'da onayli:
//   Govde: "Merhaba {{1}}, kargo takip numaraniz hazir.
//           Siparis No: {{2}}  /  Takip No: {{3}} ..."
//   Dugme: dinamik URL, "Kargomu Takip Et"
//          https://www.yurticikargo.com/tr/online-servisler/gonderi-sorgula?code={{1}}
//          -> dugme parametresi olarak SADECE takip numarasi gonderilir.
//   Parametre sayisi birebir tutmali; eksik/fazla gonderirsek Meta reddeder.
//
// SESSIZ SAAT: 22:00 - 09:00 arasi gonderilmez, istek QStash ile sabah
//   09:00'a ertelenir (fulfillment.js ile ayni desen). Erteleme kilitten
//   ONCE yapilir, yoksa sabah gelen istek "zaten gonderildi" diye elenir.
//
// TEST: ?simdi=1 eklenirse sessiz saat atlanir, mesaj hemen gider.
//
// KURULUM SARTI: Vercel ortam degiskenlerinde API_SECRET tanimli olmali.
// Shopify webhook adresi: .../api/kargo-takip?secret=<API_SECRET ile ayni>

const { Redis } = require("@upstash/redis");
const redis = Redis.fromEnv();

// SIFRE: kod icine YAZILMIYOR - Vercel ortam degiskeninden (API_SECRET)
// okunuyor. Tanimli degilse endpoint hicbir istegi kabul etmez.
const SECRET = process.env.API_SECRET || null;
const TEMPLATE_NAME = "kargo_takip_v1";
const TEMPLATE_LANG = "tr";

const SESSIZ_BASLANGIC = 22;
const SESSIZ_BITIS = 9;

function turkiyeSaati() {
  return (new Date().getUTCHours() + 3) % 24;
}

function sessizSaatteMiyiz() {
  const s = turkiyeSaati();
  return s >= SESSIZ_BASLANGIC || s < SESSIZ_BITIS;
}

function sabahaKalanSn() {
  const simdi = new Date();
  const saat = (simdi.getUTCHours() + 3) % 24;
  const dakika = simdi.getUTCMinutes();
  const kalanDakika = saat >= SESSIZ_BASLANGIC
    ? (24 - saat + SESSIZ_BITIS) * 60 - dakika
    : (SESSIZ_BITIS - saat) * 60 - dakika;
  return Math.max(60, kalanDakika * 60);
}

// Istegi sabaha ertele. true = ertelendi. false donerse cagiran normal
// akisa devam etmeli - mesaji tamamen kaybetmektense gec gondermek yeglenir.
async function sabahaErtele(govde) {
  try {
    if (!process.env.QSTASH_TOKEN) {
      console.log("KARGO-TAKIP: QSTASH_TOKEN yok, ertelenemedi - normal gonderime devam");
      return false;
    }
    const sn = sabahaKalanSn();
    const hedef = "https://masajur-ai-proxy.vercel.app/api/kargo-takip?secret=" + SECRET;
    const resp = await fetch("https://qstash.upstash.io/v2/publish/" + hedef, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.QSTASH_TOKEN,
        "Content-Type": "application/json",
        "Upstash-Delay": sn + "s"
      },
      body: JSON.stringify(Object.assign({}, govde, { _ertelendi: true }))
    });
    const data = await resp.json().catch(function () { return {}; });
    if (data && data.messageId) {
      console.log("KARGO-TAKIP: sessiz saat, " + Math.round(sn / 60) + " dk sonraya ertelendi:", data.messageId);
      return true;
    }
    console.error("KARGO-TAKIP: erteleme basarisiz, normal gonderime devam:", JSON.stringify(data).slice(0, 200));
    return false;
  } catch (e) {
    console.error("KARGO-TAKIP: erteleme HATA, normal gonderime devam:", e && e.message ? e.message : e);
    return false;
  }
}

async function takipKilidiAl(orderNumber, trackingNumber) {
  try {
    const anahtar = "kargo-takip-gonderildi:" + orderNumber + ":" + trackingNumber;
    const result = await redis.set(anahtar, "1", { nx: true, ex: 90 * 24 * 3600 });
    return result !== null;
  } catch (e) {
    console.error("KARGO-TAKIP: Redis kilit hatasi, guvenli taraf - devam ediliyor:", e && e.message ? e.message : e);
    return true;
  }
}

// Google Sheets'e yaz ("Kargo Bildirimleri" sekmesi - fulfillment.js ile ayni)
async function logToSheets(phone, name, orderNumber, trackingNumber, status) {
  try {
    if (!process.env.SHEETS_URL) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      await fetch(process.env.SHEETS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "kargo",
          phone: phone,
          name: name,
          orderNumber: orderNumber,
          product: "Takip No: " + trackingNumber,
          status: "TAKIP MESAJI - " + status
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.error("KARGO-TAKIP SHEETS LOG HATA:", e && e.message ? e.message : e);
  }
}

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

function normalizePhone(raw) {
  if (!raw) return null;
  let p = String(raw).replace(/[^0-9]/g, "");
  if (p.startsWith("90") && p.length === 12) return p;
  if (p.startsWith("0") && p.length === 11) return "9" + p;
  if (p.length === 10) return "90" + p;
  if (p.startsWith("90")) return p;
  return p;
}

// "#14495.1" -> "14495"   (fulfillment.js'teki ile ayni mantik)
function extractOrderNumber(govde) {
  if (govde.name) {
    const firstPart = String(govde.name).split(/[.\-_\s]/)[0];
    const digits = firstPart.replace(/[^0-9]/g, "");
    if (digits) return digits;
    const m = String(govde.name).match(/\d+/);
    if (m) return m[0];
  }
  if (govde.order_number != null && String(govde.order_number).trim() !== "") {
    return String(govde.order_number).replace(/[^0-9]/g, "");
  }
  return "";
}

function takipNumarasiCikar(f) {
  if (f.tracking_number) return String(f.tracking_number).trim();
  if (Array.isArray(f.tracking_numbers) && f.tracking_numbers[0]) {
    return String(f.tracking_numbers[0]).trim();
  }
  return "";
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(200).send("OK");
  }
  if (!SECRET) {
    console.error("KARGO-TAKIP: API_SECRET ortam degiskeni TANIMLI DEGIL - istek reddedildi. Vercel > Settings > Environment Variables'den eklenmeli.");
    return res.status(500).send("API_SECRET tanimsiz");
  }
  const secret = req.query && req.query.secret;
  if (secret !== SECRET) {
    console.error("KARGO-TAKIP: gecersiz secret");
    return res.status(401).send("Unauthorized");
  }

  try {
    const f = req.body || {};
    const simdiGonder = req.query && req.query.simdi === "1";

    const trackingNumber = takipNumarasiCikar(f);
    const orderNumber = extractOrderNumber(f);

    console.log("KARGO-TAKIP GELDI:", JSON.stringify({
      name: f.name,
      orderNumber: orderNumber,
      trackingNumber: trackingNumber,
      status: f.status,
      shipment_status: f.shipment_status
    }));

    // Takip numarasi yoksa yapacak bir sey yok - Shopify gonderiyi takip
    // numarasiz olusturdugunda da bu webhook tetiklenebiliyor.
    if (!trackingNumber) {
      console.log("KARGO-TAKIP: takip numarasi yok, atlandi");
      return res.status(200).send("OK - takip numarasi yok");
    }

    // Iptal edilmis gonderi icin mesaj gonderme
    if (String(f.status || "").toLowerCase() === "cancelled") {
      console.log("KARGO-TAKIP: gonderi iptal edilmis, atlandi");
      return res.status(200).send("OK - iptal");
    }

    if (!orderNumber) {
      console.error("KARGO-TAKIP: siparis numarasi cikarilamadi, atlandi");
      return res.status(200).send("OK - siparis numarasi yok");
    }

    // Sessiz saat: kilitten ONCE ertele
    if (sessizSaatteMiyiz() && !f._ertelendi && !simdiGonder) {
      const ertelendi = await sabahaErtele(f);
      if (ertelendi) {
        return res.status(200).send("OK - sessiz saat, sabaha ertelendi");
      }
    }

    // Mukerrer koruma
    const izinVerildi = await takipKilidiAl(orderNumber, trackingNumber);
    if (!izinVerildi) {
      console.log("KARGO-TAKIP: bu siparis+takip no icin mesaj zaten gonderilmis, atlandi:", orderNumber, trackingNumber);
      return res.status(200).send("OK - zaten gonderildi");
    }

    const firstName =
      (f.destination && f.destination.first_name) ||
      (f.customer && f.customer.first_name) ||
      (f.billing_address && f.billing_address.first_name) ||
      (f.shipping_address && f.shipping_address.first_name) ||
      "Merhaba";

    const rawPhone =
      (f.destination && f.destination.phone) ||
      (f.shipping_address && f.shipping_address.phone) ||
      (f.billing_address && f.billing_address.phone) ||
      (f.customer && f.customer.phone) ||
      f.phone ||
      (Array.isArray(f.note_attributes) &&
        (f.note_attributes.find(a => a.name === "Telefon numarası") || {}).value) ||
      null;

    const phone = normalizePhone(rawPhone);

    if (!phone) {
      console.error("KARGO-TAKIP: telefon yok, mesaj gonderilemedi");
      await logToSheets("", firstName, orderNumber, trackingNumber, "GITMEDI: telefon numarasi yok");
      return res.status(200).send("OK - telefon yok");
    }

    const waResp = await fetch(
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
            name: TEMPLATE_NAME,
            language: { code: TEMPLATE_LANG },
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: String(firstName) },
                  { type: "text", text: String(orderNumber) },
                  { type: "text", text: String(trackingNumber) }
                ]
              },
              {
                // Dinamik URL dugmesi: sablondaki link
                // ...gonderi-sorgula?code={{1}} seklinde, yani buraya
                // SADECE takip numarasi gidiyor, tam URL degil.
                type: "button",
                sub_type: "url",
                index: "0",
                parameters: [
                  { type: "text", text: String(trackingNumber) }
                ]
              }
            ]
          }
        })
      }
    );

    const waData = await waResp.json();
    console.log("KARGO-TAKIP WHATSAPP SONUCU:", JSON.stringify(waData));

    const waStatus = readWaStatus(waData);
    console.log("KARGO-TAKIP WA DURUM:", waStatus);

    await logToSheets(phone, firstName, orderNumber, trackingNumber, waStatus);

    return res.status(200).send("OK");
  } catch (error) {
    console.error("KARGO-TAKIP HATA:", error && error.message ? error.message : error);
    return res.status(200).send("OK");
  }
};
