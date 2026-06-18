// api/yorum.js
// QStash tarafindan (kargodan ~3 gun sonra) tetiklenir.
// Siparisi Yurtici'den kontrol eder; SADECE teslim edildiyse (DLV) yorum mesaji atar.
// Teslim edilmedi / iade / donen / timeout -> mesaj ATMAZ.

const BASE = "https://masajur-ai-proxy.vercel.app";
const SECRET = "masajur_yakkoholding_2128";
const TEMPLATE_NAME = "yorum_istek";
const TEMPLATE_LANG = "tr";

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
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

    if (!orderNumber || !phone) {
      console.error("YORUM: orderNumber veya phone yok");
      return res.status(200).send("OK");
    }

    // 1) Yurtici'den kargo durumunu sor
    let kargo = null;
    try {
      const kargoResp = await fetchWithTimeout(
        BASE + "/api/kargo",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderNumber })
        },
        9000
      );
      kargo = await kargoResp.json();
      console.log("YORUM KARGO SONUCU:", JSON.stringify(kargo));
    } catch (e) {
      console.error("YORUM KARGO HATA:", e && e.message ? e.message : e);
    }

    // 2) Teslim edildi mi? SADECE DLV ise mesaj at.
    if (!kargo || !kargo.found || kargo.statusCode !== "DLV") {
      console.log("YORUM: teslim edilmemis veya kontrol edilemedi, mesaj ATILMADI. statusCode=" + (kargo && kargo.statusCode));
      var atlandiDurum = (kargo && kargo.statusCode) ? ("Atlandi - " + kargo.statusCode) : "Atlandi - kontrol edilemedi";
      await logYorumToSheets(phone, name, orderNumber, atlandiDurum);
      return res.status(200).send("OK - not delivered");
    }

    // 3) Teslim edilmis -> yorum mesaji gonder
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

    // Yorum mesaji kaydini Sheets'e yaz
    await logYorumToSheets(phone, name, orderNumber, "Yorum mesaji gonderildi");

    return res.status(200).send("OK - sent");
  } catch (error) {
    console.error("YORUM HATA:", error && error.message ? error.message : error);
    return res.status(200).send("OK");
  }
};
