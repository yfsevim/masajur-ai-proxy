// api/fulfillment.js
const SECRET = "masajur_yakkoholding_2128";
const TEMPLATE_NAME = "kargo_verildi_v3";
const TEMPLATE_LANG = "tr";

// 3 gun sonra yorum kontrolu icin QStash'e gorev birak
async function scheduleYorum(orderNumber, phone, name) {
  try {
    if (!process.env.QSTASH_TOKEN) {
      console.log("QSTASH_TOKEN yok, yorum gorevi birakilamadi");
      return;
    }
    // QStash, hedef URL'i Upstash-Delay kadar sonra cagirir.
    const targetUrl = "https://masajur-ai-proxy.vercel.app/api/yorum?secret=" + SECRET;
    const resp = await fetch("https://qstash.upstash.io/v2/publish/" + targetUrl, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.QSTASH_TOKEN,
        "Content-Type": "application/json",
        "Upstash-Delay": "3d"
      },
      body: JSON.stringify({ orderNumber: orderNumber, phone: phone, name: name })
    });
    const data = await resp.json();
    console.log("QSTASH YORUM GOREVI:", JSON.stringify(data));
  } catch (e) {
    console.error("QSTASH YORUM GOREVI HATA:", e && e.message ? e.message : e);
  }
}

// Kargo bildirimini Google Sheets'e yaz (type:kargo -> "Kargo Bildirimleri" sekmesi)
async function logKargoToSheets(phone, name, orderNumber, product, status) {
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
          product: product,
          status: status
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.error("KARGO SHEETS LOG HATA:", e && e.message ? e.message : e);
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

// Siparis numarasini guvenli cikar: "#11742-F5" -> "11742"
// Once order_number, yoksa name'in ILK parcasinin rakamlari (-, _, bosluk, F oncesi).
function extractOrderNumber(order) {
  // ONCELIK: name (musteriye gosterilen numara, orn "#11742-F6" -> "11742").
  // order_number Shopify ic sirasi olabilir ve name'den farkli cikiyor; kullanmiyoruz.
  if (order.name) {
    // "#11742.7" veya "#11742-F7" -> ilk parca "#11742" -> "11742"
    const firstPart = String(order.name).split(/[.\-_\s]/)[0];
    const digits = firstPart.replace(/[^0-9]/g, "");
    if (digits) return digits;
    // son care: name icindeki ilk ardisik rakam grubu
    const m = String(order.name).match(/\d+/);
    if (m) return m[0];
  }
  // name hic yoksa order_number'a dus
  if (order.order_number != null && String(order.order_number).trim() !== "") {
    return String(order.order_number).replace(/[^0-9]/g, "");
  }
  return "";
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

    const orderNumber = extractOrderNumber(order);

    const productName =
      (order.line_items && order.line_items[0] && order.line_items[0].title) ||
      "Ürün";
    const phone = normalizePhone(rawPhone);
    console.log("FULFILLMENT GELDI:", JSON.stringify({ firstName, rawPhone, phone, orderName: order.name, orderNumber, productName }));
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
                  { type: "text", text: String(productName) },
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

    // Kargo bildirimini Sheets'e kaydet
    await logKargoToSheets(phone, firstName, orderNumber, productName, "Kargoya verildi");

    // 3 gun sonra yorum kontrolu icin QStash'e gorev birak
    await scheduleYorum(orderNumber, phone, firstName);

    return res.status(200).send("OK");
  } catch (error) {
    console.error("FULFILLMENT HATA:", error && error.message ? error.message : error);
    return res.status(200).send("OK");
  }
};
