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
// Gorevi:
//   - KAPIDA ODEME (COD) siparislerde: teslim-kontrol.js zincirini baslatir,
//     fatura teslim onaylanınca kesilir.
//   - ONLINE ODEME siparislerde: faturanin GERCEKTEN kesilip kesilmedigini
//     fatura-kes.js'e sordurur (asagidaki 2026-10-05 notuna bakin).
//
// ==========================================================================
// 2026-10-05 KRITIK DUZELTME (22 online siparisin faturasiz kalmasi)
// ==========================================================================
// Eski kod online odemeli siparisleri "fatura-online.js zaten faturaladi"
// diyerek ATLIYORDU. Bu bir VARSAYIMDI, dogrulama degildi. fatura-online.js
// herhangi bir sebeple basarisiz olduysa (Shopify kota asimi, siparisin
// arama indeksine henuz dusmemis olmasi, Vercel kesintisi) siparisin
// faturalanmasi icin BASKA HICBIR SANS kalmiyordu - kargoya verilme ani
// (yani burasi) o siparisi kurtarabilecek son noktaydi ve onu da harciyorduk.
// Sonuc: 13520, 13521, 13525, 13529, 13537, 13545, 13546, 13552, 13554,
// 13555, 13556, 13557, 13560 ... kalici olarak faturasiz kaldi.
//
// Artik online odemede de fatura-kes.js tetikleniyor. MUKERRER FATURA RISKI
// YOK: fatura-kes.js once Redis'teki "fatura-kesildi" bayragina ve Shopify
// etiketine bakiyor, zaten faturaliysa hicbir sey yapmadan cikiyor.
// Yani bu cagri "kesilmediyse kes, kesildiyse dokunma" anlamina geliyor.

const SECRET = "masajur_yakkoholding_2128";
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const API_VERSION = "2026-04";
const FATURA_KES_URL = "https://masajur-ai-proxy.vercel.app/api/fatura-kes?secret=" + SECRET;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Turkce kucultme tuzagi: "Kapıda Ödeme".toLowerCase() icinde ASCII "kapida"
// GECMEZ (ı ile i ayri harf). Once Turkce harfleri ASCII'ye ceviriyoruz.
function trSadelestir(s) {
  return String(s || "")
    .replace(/[İIı]/g, "i").replace(/[Şş]/g, "s").replace(/[Ğğ]/g, "g")
    .replace(/[Üü]/g, "u").replace(/[Öö]/g, "o").replace(/[Çç]/g, "c")
    .toLowerCase();
}

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

// Telefon numarasini Meta WhatsApp API'nin bekledigi formata cevir (90XXXXXXXXXX)
function normalizePhone(raw) {
  if (!raw) return null;
  let p = String(raw).replace(/[^0-9]/g, "");
  if (p.startsWith("90") && p.length === 12) return p;
  if (p.startsWith("0") && p.length === 11) return "9" + p;
  if (p.length === 10) return "90" + p;
  if (p.startsWith("90")) return p;
  return p;
}

// Fulfillment webhook payload'inda odeme bilgisi guvenilir gelmeyebilir,
// bu yuzden Shopify'dan siparisin gercek odeme tipini dogruluyoruz.
//
// 2026-10-05: eski hali ciplak fetch kullaniyordu - ne zaman asimi vardi
// ne de 429/5xx durumunda tekrar deneme. Artik fatura-kes.js ile ayni
// dayanikli yontem kullaniliyor.
async function isKapidaOdeme(orderNumber) {
  const clean = String(orderNumber).replace(/[^0-9]/g, "");
  const fields = "payment_gateway_names";
  const base = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/orders.json`;

  async function fetchByName(name) {
    const url = `${base}?status=any&name=${encodeURIComponent(name)}&fields=${fields}`;
    for (let deneme = 1; deneme <= 3; deneme++) {
      try {
        const r = await fetchWithTimeout(url, {
          headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" }
        }, 10000);
        if (r.ok) {
          const data = await r.json().catch(() => ({}));
          return (data.orders && data.orders[0]) || null;
        }
        if ((r.status === 429 || r.status >= 500) && deneme < 3) {
          console.error("FATURA-BASLAT: Shopify HTTP " + r.status + " (deneme " + deneme + "/3)");
          await sleep(1500 * deneme);
          continue;
        }
        return null;
      } catch (e) {
        console.error("FATURA-BASLAT: Shopify baglanti hatasi (deneme " + deneme + "/3):", e && e.message ? e.message : e);
        if (deneme < 3) { await sleep(1500 * deneme); continue; }
        return null;
      }
    }
    return null;
  }

  const [byHash, byPlain] = await Promise.all([
    fetchByName(`#${clean}`),
    fetchByName(clean)
  ]);
  const order = byHash || byPlain;
  if (!order) return null; // bulunamadi - emin olamiyoruz

  const gateways = trSadelestir((order.payment_gateway_names || []).join(" "));
  return gateways.includes("cash on delivery") || gateways.includes("kapida") || gateways.includes("cod");
}

async function scheduleTeslimKontrol(orderNumber, phone, name) {
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
    body: JSON.stringify({ orderNumber: orderNumber, deneme: 1, phone: phone, name: name })
  });
  const data = await resp.json().catch(() => ({}));
  console.log("FATURA-BASLAT: teslim-kontrol gorevi birakildi:", JSON.stringify(data));
}

// 2026-10-05 EKLENDI: online odemeli siparis icin "kesilmediyse kes" cagrisi.
// fatura-kes.js idempotent oldugu icin (Redis bayragi + Shopify etiketi
// kontrolu) bu cagri zaten faturali bir siparise ikinci fatura kesemez.
async function faturaGuvenlikAgi(orderNumber) {
  if (!process.env.QSTASH_TOKEN) {
    console.error("FATURA-BASLAT: QSTASH_TOKEN yok, online guvenlik agi calistirilamadi:", orderNumber);
    return;
  }
  try {
    const resp = await fetchWithTimeout("https://qstash.upstash.io/v2/publish/" + FATURA_KES_URL, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.QSTASH_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ orderNumber: String(orderNumber), deneme: 1, sebep: "kargo_aninda_online_kontrol" })
    }, 10000);
    const data = await resp.json().catch(() => ({}));
    console.log("FATURA-BASLAT: online odeme - fatura kontrolu kuyruga birakildi:", orderNumber, JSON.stringify(data));
  } catch (e) {
    console.error("FATURA-BASLAT: online guvenlik agi HATASI:", orderNumber, e && e.message ? e.message : e);
  }
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
    const phone = normalizePhone(rawPhone);

    const kapida = await isKapidaOdeme(orderNumber);

    if (kapida === false) {
      // 2026-10-05 DUZELTME: eskiden burada "atlaniyor" deyip cikiliyordu.
      // Artik faturanin gercekten kesilip kesilmedigini fatura-kes.js'e
      // sorduruyoruz (kesilmisse hicbir sey yapmaz).
      console.log("FATURA-BASLAT: online odeme - fatura durumu dogrulanacak:", orderNumber);
      await faturaGuvenlikAgi(orderNumber);
      return res.status(200).send("OK - online odeme, fatura kontrolu kuyruga birakildi");
    }

    // kapida === true VEYA null (emin olunamadi) -> guvenli taraf: teslim takibini baslat.
    // (Online oldugu halde buraya dusse bile fatura-kes.js zaten "fatura-kesildi"
    // etiketi varsa tekrar fatura kesmiyor, yani cift fatura riski yok.)
    console.log("FATURA-BASLAT TETIKLENDI (COD veya belirsiz):", orderNumber, "telefon:", phone);
    await scheduleTeslimKontrol(orderNumber, phone, firstName);

    return res.status(200).send("OK");
  } catch (error) {
    console.error("FATURA-BASLAT HATA:", error && error.message ? error.message : error);
    return res.status(200).send("OK");
  }
};
