// api/fulfillment.js
const SECRET = "masajur_yakkoholding_2128";
const TEMPLATE_NAME = "kargo_verildi";
const TEMPLATE_LANG = "tr";

function normalizePhone(raw) {
  if (!raw) return null;
  let p = String(raw).replace(/[^0-9]/g, "");
  if (p.startsWith("90") && p.length === 12) return p;
  if (p.startsWith("0") && p.length === 11) return "9" + p;
  if (p.length === 10) return "90" + p;
  if (p.startsWith("90")) return p;
  return p;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(200).send("OK");
  }

  const secret = req.query && req.query.secret;
  if (secret !== SECRET) {
    console.error("FULFILLMENT: gecersiz secret");
    return res.status(401).send("Unauthorized");
  }

  try {
    const order = req.body || {};

    const firstName =
      (order.destination && order.destination.first_name) ||
      (order.customer && order.customer.first_name) ||
      (order.billing_address && order.billing_address.first_name) ||
      (order.shipping_address && order.shipping_address.first_name) ||
      "Merhaba";

    const rawPhone =
      (order.destination && order.destination.phone) ||
      (order.shipping_address && order.shipping_address.phone) ||
      (order.billing_address && order.billing_address.phone) ||
      (order.customer && order.customer.phone) ||
      order.phone ||
      (Array.isArray(order.note_attributes) &&
        order.note_attributes.find(a => a.name === "Telefon numarası")?.value) ||
      null;

    const orderNumber =
      (order.order_number != null ? String(order.order_number) : null) ||
      (order.name ? String(order.name).replace(/[^0-9]/g, "") : null) ||
      "";

    const phone = normalizePhone(rawPhone);
    console.log("FULFILLMENT GELDI:", JSON.stringify({ firstName, rawPhone, phone, orderNumber }));

    if (!phone) {
      console.error("FULFILLMENT: telefon yok, mesaj gonderilemedi");
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
            name: TEMPLATE_NAME,
            language: { code: TEMPLATE_LANG },
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: String(firstName) },
                  { type: "text", text: String(orderNumber) }
                ]
              }
            ]
          }
        })
      }
    );

    const waData = await waResp.json();
    console.log("FULFILLMENT WHATSAPP SONUCU:", JSON.stringify(waData));
    return res.status(200).send("OK");

  } catch (error) {
    console.error("FULFILLMENT HATA:", error && error.message ? error.message : error);
    return res.status(200).send("OK");
  }
};
