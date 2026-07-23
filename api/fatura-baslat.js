// api/fatura-baslat.js
// BAGIMSIZ webhook giris noktasi. Mevcut fulfillment.js'e HICBIR DOKUNMA YOK.
//
// Shopify'da AYRI bir webhook olarak tanimlanir:
//   Olay: Order fulfillment created / order/fulfilled (ayni "kargoya verildi" olayi)
//   URL:  https://masajur-ai-proxy.vercel.app/api/fatura-baslat?secret=...
//
// Shopify ayni olay icin birden fazla webhook'u ayni anda cagirabilir,
// yani fulfillment.js (WhatsApp mesaji icin) ve bu dosya (fatura icin)
// birbirinden habersiz, paralel calisir. Biri bozulursa digeri etkilenmez.
//
// SADECE KAPIDA ODEME (COD) siparisler icin teslimat takibini baslatir.
// Online odeme (kredi karti vb.) ile odenen siparisler zaten fatura-online.js
// tarafindan odeme aninda faturalanmis olur - burada tekrar baslatilmaz.
//
// Gorevi: siparis numarasini cikar, siparisin odeme tipini Shopify'dan
// dogrula, COD ise teslim-kontrol.js'e ilk QStash gorevini birak.

const SECRET = "masajur_yakkoholding_2128";
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const API_VERSION = "2026-04";

// Siparis numarasini guvenli cikar: "#11742-F5" -> "11742"
function extractOrderNumber(order) {
  if (order.name) {
    const firstPart = String(order.name).split(/[.\-_\s]/)[0];
    const digits = firstPart.replace(/[^0-9]/g, "");
    if (digits) return digits;
    const m = String(order.name).match(/\d+/);
    if (m) return m[0];
  }
  if (order.order_number != null && String(order.order_number).trim() !== "") {
    return String(order.order_number).replace(/[^0-9]/g, "");
  }
  return "";
}

// Fulfillment webhook payload'inda odeme bilgisi guvenilir gelmeyebilir,
// bu yuzden Shopify'dan siparisin gercek odeme tipini dogruluyoruz.
async function isKapidaOdeme(orderNumber) {
  const clean = String(orderNumber).replace(/[^0-9]/g, "");
  const fields = "payment_gateway_names";
  const base = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/orders.json`;

  async function fetchByName(name) {
    const url = `${base}?status=any&name=${encodeURIComponent(name)}&fields=${fields}`;
    const r = await fetch(url, {
      headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" }
    });
    if (!r.ok) return null;
    const data = await r.json().catch(() => ({}));
    return (data.orders && data.orders[0]) || null;
  }

  let order = await fetchByName(`#${clean}`);
  if (!order) order = await fetchByName(clean);
  if (!order) return null; // bulunamadi - emin olamiyoruz

  const gateways = (order.payment_gateway_names || []).join(" ").toLowerCase();
  return gateways.includes("cash on delivery") || gateways.includes("kapida") || gateways.includes("cod");
}

async function scheduleTeslimKontrol(orderNumber) {
  if (!process.env.QSTASH_TOKEN) {
    console.log("QSTASH_TOKEN yok, teslim kontrolu baslatilamadi");
    return;
  }
  const targetUrl = "https://masajur-ai-proxy.vercel.app/api/teslim-kontrol?secret=" + SECRET;
  const resp = await fetch("https://qstash.upstash.io/v2/publish/" + targetUrl, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + process.env.QSTASH_TOKEN,
      "Content-Type": "application/json",
      "Upstash-Delay": "1d"   // kargoya verildikten ~1 gun sonra ilk kontrol
    },
    body: JSON.stringify({ orderNumber: orderNumber, deneme: 1 })
  });
  const data = await resp.json().catch(() => ({}));
  console.log("FATURA-BASLAT: teslim-kontrol gorevi birakildi:", JSON.stringify(data));
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("OK");

  const secret = req.query && req.query.secret;
  if (secret !== SECRET) {
    console.error("FATURA-BASLAT: gecersiz secret");
    return res.status(401).send("Unauthorized");
  }

  try {
    const order = req.body || {};
    const orderNumber = extractOrderNumber(order);

    if (!orderNumber) {
      console.error("FATURA-BASLAT: siparis numarasi cikarilamadi");
      return res.status(200).send("OK");
    }

    const kapida = await isKapidaOdeme(orderNumber);

    if (kapida === false) {
      console.log("FATURA-BASLAT: online odeme, atlaniyor (fatura-online.js zaten faturaladi):", orderNumber);
      return res.status(200).send("OK - online odeme, atlandi");
    }

    // kapida === true VEYA null (emin olunamadi) -> guvenli taraf: teslim takibini baslat.
    // (Online oldugu halde buraya dusse bile fatura-kes.js zaten "fatura-kesildi"
    // etiketi varsa tekrar fatura kesmiyor, yani cift fatura riski yok.)
    console.log("FATURA-BASLAT TETIKLENDI (COD veya belirsiz):", orderNumber);
    await scheduleTeslimKontrol(orderNumber);

    return res.status(200).send("OK");
  } catch (error) {
    console.error("FATURA-BASLAT HATA:", error && error.message ? error.message : error);
    return res.status(200).send("OK");
  }
};
