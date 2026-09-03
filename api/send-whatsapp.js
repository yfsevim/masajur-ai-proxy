// api/sendwhatsapp.js
// 2026-09-03 GUVENLIK DUZELTMESI: bu uc noktada hicbir secret/yetki kontrolu
// yoktu - URL'yi bilen HERKES, istedigi telefon numarasina istedigi metni,
// bizim WhatsApp Business hesabimizdan gonderebilirdi (para + itibar riski).
// Artik diger dosyalarla AYNI ?secret=... kontrolu yapiliyor.
const SECRET = "masajur_yakkoholding_2128";

module.exports = async (req, res) => {

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method Not Allowed"
    });
  }

  const secret = req.query && req.query.secret;
  if (secret !== SECRET) {
    console.error("SENDWHATSAPP: gecersiz secret");
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {

    const { phone, message } = req.body;

    const response = await fetch(
      `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: phone,
          type: "text",
          text: {
            body: message
          }
        })
      }
    );

    const data = await response.json();

    return res.status(200).json(data);

  } catch (error) {

    return res.status(500).json({
      error: error.message
    });

  }

};
