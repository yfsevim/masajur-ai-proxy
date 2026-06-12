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

    console.log("MESAJ GELDI");
    console.log("BODY:");
    console.log(JSON.stringify(req.body, null, 2));

    try {
      const value =
        req.body?.entry?.[0]?.changes?.[0]?.value;

      const message =
        value?.messages?.[0]?.text?.body;

      const phone =
        value?.messages?.[0]?.from;

      console.log("MESAJ:", message);
      console.log("TELEFON:", phone);

      if (!message || !phone) {
        console.log("MESAJ VEYA TELEFON YOK");
        return res.status(200).send("OK");
      }

      console.log("CLAUDE'A GONDERILIYOR");

      const claudeResponse = await fetch(
        "https://masajur-ai-proxy.vercel.app/api/chat",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            message
          })
        }
      );

      const claudeData = await claudeResponse.json();

      console.log("CLAUDE CEVABI:");
      console.log(claudeData);

      const reply =
        claudeData.reply || "Yanıt oluşturulamadı.";

      console.log("WHATSAPP'A GONDERILIYOR:");
      console.log(reply);

      const whatsappResponse = await fetch(
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
              body: reply
            }
          })
        }
      );

      const whatsappData = await whatsappResponse.json();

      console.log("WHATSAPP SONUCU:");
      console.log(whatsappData);

      return res.status(200).send("OK");

    } catch (error) {

      console.error("HATA:");
      console.error(error);

      return res.status(200).send("OK");
    }
  }

  return res.status(200).send("OK");
};
