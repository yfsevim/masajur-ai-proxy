module.exports = async (req, res) => {

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method Not Allowed"
    });
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
