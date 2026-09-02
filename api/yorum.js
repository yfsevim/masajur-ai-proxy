// api/yorum.js
// QStash tarafindan (kargodan ~4 gun sonra) tetiklenir.
// Gonderim ONCESI Yurtici Kargo'dan gercek teslim durumu kontrol edilir:
// sadece DLV (teslim edildi) ise yorum_istek gonderilir. Kapidan donen
// (AAB/MSA gibi) veya hala yolda olan siparislere yorum istegi GITMEZ.
// Yurtici'ye ulasilamazsa (gecici hata/devre kesici acik) eski davranisa
// donulur: yine de gonderilir - boylece bir API kesintisi butun yorum
// akisini durdurmaz.
//
// Yurtici Kargo sorgusu artik ../lib/yurtici.js'deki ORTAK istemciyi kullanir
// (webhook-process.js, teslim-kontrol.js ve yorum.js ayni koddan besleniyor).

const yurtici = require("../lib/yurtici");

const SECRET = "masajur_yakkoholding_2128";
const TEMPLATE_NAME = "yorum_istek";
const TEMPLATE_LANG = "tr";

// Arka plan/batch isi oldugu icin teslim-kontrol.js ile AYNI ortak devre
// kesici anahtarini kullanir.
const cb = yurtici.createCircuitBreaker("yurtici-cb");

// Siparisin gercek teslim durumunu getirir. null donerse (devre kesici acik
// veya sorgu basarisiz) durum BILINMIYOR demektir - cagiran taraf bu durumda
// eski davranisa (yorum gonder) donmeli.
async function getTeslimDurumu(orderNumber) {
  const raw = await yurtici.queryShipment(orderNumber, cb, "YORUM");
  if (!raw) return null;
  return {
    status: raw.operationStatus, // HAM Yurtici kodu - loglama icin, karar icin KULLANMA
    gercekTeslim: raw.gercektenMusteriyeTeslimEdildi, // DOGRU alan - yorum gonderme karari bunu kullanmali
    sirketeIadeEdildi: raw.sirketeIadeEdildi,
    reasonId: raw.cargoReasonId,
    reasonExplanation: raw.cargoReasonExplanation
  };
}

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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

// Yorum mesaji kaydini Google Sheets'e yaz (type:yorum -> "Yorum Mesajları" sekmesi)
async function logYorumToSheets(phone, name, orderNumber, status) {
  try {
    if (!process.env.SHEETS_URL) return;
    await fetchWithTimeout(
      process.env.SHEETS_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "yorum",
          phone: phone,
          name: name,
          orderNumber: orderNumber,
          status: status
        })
      },
      8000
    );
  } catch (e) {
    console.error("YORUM SHEETS LOG HATA:", e && e.message ? e.message : e);
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(200).send("OK");
  }

  // Gizli anahtar kontrolu (QStash cagrisinda ?secret=... ile gelir)
  const secret = req.query && req.query.secret;
  if (secret !== SECRET) {
    console.error("YORUM: gecersiz secret");
    return res.status(401).send("Unauthorized");
  }

  try {
    // QStash gorevinde gonderdigimiz veri: { orderNumber, phone, name }
    const body = req.body || {};
    const orderNumber = body.orderNumber ? String(body.orderNumber) : "";
    const phone = body.phone ? String(body.phone) : "";
    const name = body.name ? String(body.name) : "Merhaba";

    console.log("YORUM TETIKLENDI:", JSON.stringify({ orderNumber, phone, name }));

    if (!phone) {
      console.error("YORUM: phone yok, mesaj gonderilemedi");
      await logYorumToSheets("", name, orderNumber, "GITMEDI: telefon yok");
      return res.status(200).send("OK");
    }

    // Once gercekten teslim edilmis mi kontrol et. Durum bilinmiyorsa
    // (Yurtici'ye ulasilamadi / devre kesici acik) eski davranisa don:
    // yine de gonder - bir API kesintisi butun yorum akisini durdurmasin.
    const detail = await getTeslimDurumu(orderNumber);
    console.log("YORUM TESLIM DURUMU:", orderNumber, "->", JSON.stringify(detail));

    if (detail && detail.status && !detail.gercekTeslim) {
      // 2026-09-02 DUZELTME: eskiden burada "detail.status !== 'DLV'" kontrol
      // ediliyordu. Ama Yurtici, paket musteriye ulasmadan bize (sirkete)
      // iade oldugunda da operationStatus="DLV" donduruyor - bu yuzden
      // sadece DLV olup olmadigina degil, gercekten musteriye teslim edilip
      // edilmedigine (gercekTeslim) bakiyoruz. Boylece sirkete iade olan
      // siparislere de (once DLV oldugu icin gecen) artik yanlislikla
      // "yorum yapar misiniz" mesaji GITMIYOR.
      const not = detail.sirketeIadeEdildi
        ? "SIRKETE-IADE (musteriye ulasmadi)"
        : (detail.reasonId ? detail.status + "/" + detail.reasonId : detail.status);
      console.log("YORUM: siparis teslim edilmemis (" + not + "), yorum istegi ATLANIYOR:", orderNumber);
      await logYorumToSheets(phone, name, orderNumber, "ATLANDI: teslim edilmemis (" + not + ")");
      return res.status(200).send("OK - teslim edilmemis, yorum istegi gonderilmedi");
    }

    // detail null (durum bilinmiyor) VEYA detail.gercekTeslim === true -> gonder
    const waResp = await fetchWithTimeout(
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
                  { type: "text", text: name }
                ]
              }
            ]
          }
        })
      },
      8000
    );
    const waData = await waResp.json();
    console.log("YORUM WHATSAPP SONUCU:", JSON.stringify(waData));

    // Gercek gonderim durumunu Sheets'e yaz
    const waStatus = readWaStatus(waData);
    await logYorumToSheets(phone, name, orderNumber, waStatus);

    return res.status(200).send("OK - sent");
  } catch (error) {
    console.error("YORUM HATA:", error && error.message ? error.message : error);
    return res.status(200).send("OK");
  }
};
