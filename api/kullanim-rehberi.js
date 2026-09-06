// api/kullanim-rehberi.js
// 2026-09-06: fulfillment.js'in scheduleKullanimRehberi() fonksiyonu bu
// endpoint'i QStash uzerinden 1 GUN (ertesi gun ayni saat) GECIKMELI olarak
// cagirir. Amac: kargo bildirimi ile kullanim rehberi mesajinin ayni anda/
// arka arkaya gitmesini engellemek (ilk canli testte musteri bunu istemedi).
//
// Bu dosya SADECE bu tek gorevi yapar: kendisine QStash'ten gelen
// {orderNumber, phone, firstName} bilgisiyle onayli WhatsApp sablonunu
// gonderir. fulfillment.js'deki kargoBildirimKilidiAl() zaten siparis basina
// bu gorevin SADECE BIR KERE olusturulmasini garantiledigi icin burada ayrica
// bir mukerrer-onleme kontrolune gerek yok.
const SECRET = "masajur_yakkoholding_2128";
const KULLANIM_TEMPLATE_NAME = "urun_kullanim_rehberi_v1";
const TEMPLATE_LANG = "tr";

// WhatsApp API cevabindan gercek gonderim durumunu cikar.
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

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(200).send("OK");
  }
  const secret = req.query && req.query.secret;
  if (secret !== SECRET) {
    console.error("KULLANIM-REHBERI: gecersiz secret");
    return res.status(401).send("Unauthorized");
  }
  try {
    const body = req.body || {};
    const orderNumber = body.orderNumber;
    const phone = body.phone;
    const firstName = body.firstName || "Merhaba";

    if (!phone) {
      console.error("KULLANIM-REHBERI: telefon yok, mesaj gonderilemedi", orderNumber);
      return res.status(200).send("OK");
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
            name: KULLANIM_TEMPLATE_NAME,
            language: { code: TEMPLATE_LANG },
            components: [
              {
                type: "body",
                parameters: [{ type: "text", text: String(firstName) }]
              }
            ]
          }
        })
      }
    );
    const waData = await waResp.json();
    console.log("KULLANIM REHBERI WHATSAPP SONUCU (siparis " + orderNumber + "):", JSON.stringify(waData));
    console.log("KULLANIM REHBERI WA DURUM:", readWaStatus(waData));

    return res.status(200).send("OK");
  } catch (error) {
    console.error("KULLANIM-REHBERI HATA:", error && error.message ? error.message : error);
    return res.status(200).send("OK");
  }
};
