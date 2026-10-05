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
// numarasi icin fatura-kes.js'i dogrudan tetikleyebilirdi. Artik diger
// dosyalarla AYNI ?secret=... kontrolu yapiliyor - Shopify'daki webhook
// URL'sinin sonuna ?secret=masajur_yakkoholding_2128 eklenmesi GEREKIR.
//
// NOT: Kapida odeme (COD) siparisleri bu webhook'u tetiklemez; tetiklese bile
// burada tespit edilip atlanir - COD siparislerin faturasi sadece
// fatura-baslat.js + teslim-kontrol.js zincirinden, teslim edilince kesilir.
//
// ==========================================================================
// 2026-10-05 KRITIK DUZELTME (22 online siparisin faturasiz kalmasi)
// ==========================================================================
// Eski akis: bu dosya fatura-kes.js'i DOGRUDAN cagirip cevabini 60 saniyeye
// kadar bekliyordu. Iki ayri soruna yol aciyordu:
//
//   1) Shopify'in "orders/paid" webhook'u cevabi 5 SANIYE icinde bekler.
//      Bizim islem ~7 saniye surunce Shopify "basarisiz" sayip AYNI olayi
//      TEKRAR gonderiyordu. Ikinci istek, birincinin aldigi Redis kilidini
//      dolu buluyor ve "locked_duplicate" deyip hicbir sey yapmadan
//      cekiliyordu (Vercel loglarinda gorulen tablo tam olarak buydu).
//
//   2) fatura-kes.js "siparis bulunamadi" dedigi anda (Shopify kota asimi
//      veya siparisin arama indeksine henuz dusmemis olmasi) bu dosyanin
//      yapacagi hicbir sey yoktu - online odemede COD'daki teslim-kontrol
//      zincirinin karsiligi olmadigi icin siparis KALICI olarak faturasiz
//      kaliyordu.
//
// Yeni akis: Shopify'a ANINDA cevap veriyoruz, isi QStash'e birakiyoruz.
// QStash gorevi fatura-kes.js'i cagirir; fatura-kes.js de gecici bir sorun
// olursa kendi icinde artan araliklarla tekrar dener. Mukerrer fatura riski
// yok: fatura-kes.js Redis "fatura-kesildi" bayragina ve Shopify etiketine
// bakip zaten faturaliysa cikiyor.
//
// QSTASH_TOKEN tanimli degilse eski davranisa (dogrudan cagri) donuyor ki
// sistem her halukarda calismaya devam etsin.

const SECRET = "masajur_yakkoholding_2128";
const FATURA_KES_URL = "https://masajur-ai-proxy.vercel.app/api/fatura-kes?secret=" + SECRET;

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

function isKapidaOdeme(order) {
  const gateways = trSadelestir((order.payment_gateway_names || []).join(" "));
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

// QStash'e birak: Shopify'a aninda cevap verebilmek icin.
// "Upstash-Delay: 30s" bilerek kondu - siparis Shopify'in arama indeksine
// dussun diye kisa bir nefes payi. (fatura-kes.js bulamazsa zaten kendi
// icinde 2dk/5dk/15dk... seklinde tekrar deneyecek.)
async function kuyrugaBirak(orderNumber) {
  const resp = await fetchWithTimeout("https://qstash.upstash.io/v2/publish/" + FATURA_KES_URL, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + process.env.QSTASH_TOKEN,
      "Content-Type": "application/json",
      "Upstash-Delay": "30s"
    },
    body: JSON.stringify({ orderNumber: String(orderNumber), deneme: 1, sebep: "online_odeme" })
  }, 8000);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error("QStash HTTP " + resp.status + " " + JSON.stringify(data));
  console.log("FATURA-ONLINE: fatura-kes gorevi kuyruga birakildi:", orderNumber, JSON.stringify(data));
}

// QStash yoksa eski yontem - dogrudan cagri (yedek yol)
async function dogrudanTetikle(orderNumber) {
  const resp = await fetchWithTimeout(FATURA_KES_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderNumber: String(orderNumber), deneme: 1, sebep: "online_odeme" })
  }, 60000);
  const data = await resp.json().catch(() => ({}));
  console.log("FATURA-ONLINE: fatura-kes dogrudan tetiklendi:", orderNumber, JSON.stringify(data));
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

    console.log("FATURA-ONLINE: online odeme tespit edildi:", orderNumber);

    if (process.env.QSTASH_TOKEN) {
      await kuyrugaBirak(orderNumber);
    } else {
      console.error("FATURA-ONLINE: QSTASH_TOKEN yok, yedek yol kullaniliyor (dogrudan cagri)");
      await dogrudanTetikle(orderNumber);
    }

    return res.status(200).send("OK");
  } catch (error) {
    console.error("FATURA-ONLINE HATA:", error && error.message ? error.message : error);
    // Shopify'a 500 donersek webhook'u tekrar gonderir - burada bunu BILEREK
    // istiyoruz: gorev kuyruga hic birakilamadiysa tek sansimiz Shopify'in
    // tekrar denemesi. (Kuyruga birakildiysa zaten bu satira hic gelinmiyor.)
    return res.status(500).send("HATA");
  }
};
