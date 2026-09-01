// api/webhook.js
// Meta WhatsApp webhook alicisi. Sadece HIZLI ACK verir; asil is (Shopify
// siparis + Yurtici kargo + Claude -> WhatsApp cevabi) QStash uzerinden
// api/webhook-process.js'e devredilir. Boylece Meta, yavas Yurtici/Claude
// cevaplarini beklerken zaman asimina ugrayip ayni mesaji tekrar tekrar
// gondermez (bu, botun ayni soruya birden fazla kez cevap yazmasina
// sebep oluyordu - webhook-process.js'deki mesaj kilidi de ekstra guvence).

const BASE = "https://masajur-ai-proxy.vercel.app";
const SECRET = "masajur_yakkoholding_2128";

module.exports = async (req, res) => {
  const VERIFY_TOKEN = "masajur123";

  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  if (req.method === "POST") {
    try {
      const value = req.body?.entry?.[0]?.changes?.[0]?.value;
      const message = value?.messages?.[0]?.text?.body;
      const phone = value?.messages?.[0]?.from;

      if (!message || !phone) {
        console.log("MESAJ VEYA TELEFON YOK - islenmeyecek webhook (durum/okundu bildirimi olabilir)");
        return res.status(200).send("OK");
      }

      console.log("MESAJ GELDI, webhook-process'e devrediliyor:", message);

      if (!process.env.QSTASH_TOKEN) {
        console.error("QSTASH_TOKEN yok, webhook-process tetiklenemiyor");
        return res.status(200).send("OK");
      }

      const targetUrl = BASE + "/api/webhook-process?secret=" + SECRET;
      await fetch("https://qstash.upstash.io/v2/publish/" + targetUrl, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + process.env.QSTASH_TOKEN,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(req.body)
      });

      return res.status(200).send("OK");
    } catch (error) {
      console.error("HATA:", error);
      return res.status(200).send("OK");
    }
  }

  return res.status(200).send("OK");
};
