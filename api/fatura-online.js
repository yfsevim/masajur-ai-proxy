// api/fatura-online.js
// BAGIMSIZ webhook giris noktasi. Online odeme (kredi karti / PayTR vb.)
// ile odenen siparislerde, TESLIMATI BEKLEMEDEN aninda fatura kesilmesi icin.
//
// Shopify'da AYRI bir webhook olarak tanimlanir:
//   Olay: Order payment / orders/paid
//   URL:  https://masajur-ai-proxy.vercel.app/api/fatura-online?secret=masajur_yakkoholding_2128
//
// 2026-09-03 GUVENLIK DUZELTMESI: bu dosyada digerlerinin (fulfillment.js,
// fatura-baslat.js, teslim-kontrol.js) aksine HICBIR secret/yetki kontrolu
// yoktu - URL'yi bilen HERKES, gercek bir odeme olmadan, istedigi siparis
// numarasi icin fatura-kes.js'i dogrudan tetikleyebilirdi. Bu, "asla yanlis
// fatura kesilmesin" kuralini dogrudan tehdit ediyordu. Artik diger
// dosyalarla AYNI ?secret=... kontrolu yapiliyor - Shopify'daki webhook
// URL'sinin sonuna ?secret=masajur_yakkoholding_2128 eklenmesi GEREKIR,
// aksi halde Shopify'in gercek "odeme yapildi" bildirimleri de 401 ile
// reddedilir.
//
// NOT: Kapida odeme (COD) siparisleri bu webhook'u tetiklemez (COD'da odeme
// online tahsil edilmedigi icin Shopify "orders/paid" olayini COD siparisler
// icin genelde gec veya hic tetiklemez). COD siparisler fatura-baslat.js +
// teslim-kontrol.js zinciriyle, teslim edilince faturalanmaya devam eder.
//
// Guvenlik icin ekstra bir kontrol de yapiyoruz: gelen siparisin odeme tipi
// gercekten "kapida odeme" ise (COD), YANLISLIKLA hemen fatura KESMIYORUZ -
// COD siparislerin faturasi sadece teslim-kontrol.js zincirinden gecmeli.
//
// 2026-09-05 DUZELTME: fatura-kes.js'e giden istegin HICBIR zaman asimi
// yoktu (ciplak fetch) - hesap artik Vercel Pro'da ve fatura-kes.js'in
// kendisi (yeni, bollastirilmis haliyle) en kotu senaryoda ~60sn surebiliyor;
// bu dosyanin da o kadar sabirli olmasi ve kendi calisma suresinin
// (vercel.json'da artik acikca 70sn) buna yetecek kadar olmasi gerekiyor -
// aksi halde Vercel bu fonksiyonu fatura-kes.js daha cevap vermeden
// oldurebilir (fatura-kes.js kendi basina calismaya devam eder, bu yuzden
// mukerrer fatura riski yok, ama "FATURA-ONLINE HATA" gibi gereksiz log
// gurultusune yol acabilir).

const SECRET = "masajur_yakkoholding_2128";

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isKapidaOdeme(order) {
  const gateways = (order.payment_gateway_names || []).join(" ").toLowerCase();
  return gateways.includes("cash on delivery") || gateways.includes("kapida") || gateways.includes("cod");
}

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

async function triggerFaturaHemen(orderNumber) {
  const url = "https://masajur-ai-proxy.vercel.app/api/fatura-kes?secret=" + SECRET;
  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderNumber: orderNumber })
  }, 60000);
  const data = await resp.json().catch(() => ({}));
  console.log("FATURA-ONLINE: fatura-kes tetiklendi:", JSON.stringify(data));
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("OK");

  const secret = req.query && req.query.secret;
  if (secret !== SECRET) {
    console.error("FATURA-ONLINE: gecersiz secret");
    return res.status(401).send("Unauthorized");
  }

  try {
    const order = req.body || {};
    const orderNumber = extractOrderNumber(order);

    if (!orderNumber) {
      console.error("FATURA-ONLINE: siparis numarasi cikarilamadi");
      return res.status(200).send("OK");
    }

    if (isKapidaOdeme(order)) {
      console.log("FATURA-ONLINE: siparis kapida odeme, atlaniyor (teslim-kontrol zincirine birakiliyor):", orderNumber);
      return res.status(200).send("OK - COD, atlandi");
    }

    console.log("FATURA-ONLINE: online odeme tespit edildi, hemen faturalaniyor:", orderNumber);
    await triggerFaturaHemen(orderNumber);

    return res.status(200).send("OK");
  } catch (error) {
    console.error("FATURA-ONLINE HATA:", error && error.message ? error.message : error);
    return res.status(200).send("OK");
  }
};
