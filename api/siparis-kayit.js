// api/siparis-kayit.js
// Shopify "Siparis olusturuldu" (orders/create) webhook'u tarafindan cagrilir.
// Tek isi var: siparis Shopify'a duser dusmez yeni muhasebe Google Sheets
// dosyasindaki "Siparis Ozet" sekmesine bir satir actirmak (Durum: Bekliyor).
//
// Bu dosya FATURA AKISINA HIC DOKUNMAZ. Fatura kesme, teslim kontrolu, Mysoft,
// Redis bayraklari - hicbiriyle ilgisi yok. Sadece muhasebe raporlamasi icin
// veri topluyor. Patlasa, yavaslasa veya hic calismasa bile fatura sistemi
// aynen calismaya devam eder.
//
// Siparis satiri daha sonra kendiliginden guncellenir:
//   - fatura-kes.js fatura kesince      -> Durum "Faturalandi" + fatura tarihi/no
//   - teslim-kontrol.js kapidan donunce -> Durum "Kapidan Dondu"
// Yani burada sadece satirin ACILMASI yapiliyor.
//
// TEKRAR DENEME YOK (#12558 dersi): Apps Script cevabi bize ulasmasa bile
// satiri cogu zaman ZATEN eklemis oluyor. Ayrica Apps Script tarafinda siparis
// numarasi bazli mukerrer kontrolu var - Shopify webhook'u tekrar gonderse
// bile ikinci satir acilmaz.

// 2026-09-18 EKLENDI - HEDIYE KREM ETIKETI
// sepet-kurtarma.js, yarim kalan sepete "479 TL'lik ari zehri kremi hediye"
// mesaji gonderdiginde Redis'e "hediye-sozu:<telefon>" isareti birakiyor (48 saat).
// O musteri siparis verdiginde burada o isaret kontrol edilip Shopify'daki
// siparise "hediye-krem" etiketi ekleniyor. Boylece paketleme sirasinda
// Shopify'da etikete bakip krem konulacak siparisler goruluyor - musteriye
// kod girdirmeye veya sepete 0 TL'lik urun eklemeye gerek kalmiyor.
//
// GUVENLI: butun bu blok kendi try/catch'i icinde. Redis erisilemese,
// Shopify etiketleme basarisiz olsa bile muhasebe kaydi ve webhook cevabi
// AYNEN calisiyor - Shopify'a her zaman 200 donuluyor.
const { Redis } = require("@upstash/redis");
const redis = Redis.fromEnv();

const SECRET = "masajur_yakkoholding_2128";
const SHOPIFY_API_VERSION = "2026-04";      // diger dosyalarla ayni
const HEDIYE_ETIKETI = "hediye-krem";

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// fatura-kes.js'teki isKapidaOdemeSiparis ile AYNI mantik - iki taraf ayni
// siparis icin ayni odeme tipini uretsin diye birebir kopyalandi.
function isKapidaOdemeSiparis(order) {
  const gateways = (order.payment_gateway_names || []).join(" ").toLowerCase();
  return gateways.includes("cash on delivery") || gateways.includes("kapida") || gateways.includes("cod");
}

function musteriAdiCikar(order) {
  const c = order.customer || {};
  const ad = ((c.first_name || "") + " " + (c.last_name || "")).trim();
  if (ad) return ad;
  const addr = order.shipping_address || order.billing_address || {};
  return addr.name || "";
}

// teslim-kontrol.js ve sepet-kurtarma.js'teki ile AYNI mantik
function normalizeTelefon(raw) {
  if (!raw) return "";
  let d = String(raw).replace(/[^0-9]/g, "");
  if (!d) return "";
  if (d.startsWith("0")) d = "90" + d.slice(1);
  if (!d.startsWith("90")) d = "90" + d;
  return d;
}

function telefonCikar(order) {
  const cust = order.customer || {};
  const ship = order.shipping_address || {};
  const bill = order.billing_address || {};
  return normalizeTelefon(order.phone || ship.phone || bill.phone || cust.phone);
}

// Siparise "hediye-krem" etiketi ekle (mevcut etiketleri KORUYARAK).
async function hediyeEtiketiEkle(order, no) {
  try {
    const telefon = telefonCikar(order);
    if (!telefon) return false;
    if (!process.env.SHOPIFY_STORE || !process.env.SHOPIFY_TOKEN) return false;

    // Bu telefona hediye sozu verilmis mi?
    let sozVar = false;
    try {
      sozVar = !!(await redis.get("hediye-sozu:" + telefon));
    } catch (e) {
      console.error("HEDIYE: Redis okunamadi, etiketleme atlandi:", no, e && e.message ? e.message : e);
      return false;
    }
    if (!sozVar) return false;

    if (!order.id) {
      console.error("HEDIYE: siparis id yok, etiketlenemedi:", no);
      return false;
    }

    // Mevcut etiketleri koru, sonuna ekle. Zaten varsa tekrar ekleme.
    const mevcut = String(order.tags || "").trim();
    const liste = mevcut ? mevcut.split(",").map(function (t) { return t.trim(); }).filter(Boolean) : [];
    if (liste.indexOf(HEDIYE_ETIKETI) !== -1) return true;
    liste.push(HEDIYE_ETIKETI);

    const url = "https://" + process.env.SHOPIFY_STORE + "/admin/api/" + SHOPIFY_API_VERSION +
      "/orders/" + order.id + ".json";
    const r = await fetchWithTimeout(url, {
      method: "PUT",
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ order: { id: order.id, tags: liste.join(", ") } })
    }, 10000);

    if (!r.ok) {
      const govde = await r.text().catch(function () { return ""; });
      console.error("HEDIYE: Shopify etiketleme HTTP " + r.status + ":", no, govde.slice(0, 200));
      return false;
    }

    // Soz kullanildi - bayragi sil ki ayni musterinin sonraki siparisine
    // yanlislikla tekrar hediye etiketi dusmesin.
    try { await redis.del("hediye-sozu:" + telefon); } catch (e) {}

    console.log("HEDIYE: siparis etiketlendi (" + HEDIYE_ETIKETI + "):", no, telefon);
    return true;
  } catch (e) {
    console.error("HEDIYE: beklenmeyen hata (SIPARIS AKISI ETKILENMEDI):", no, e && e.message ? e.message : e);
    return false;
  }
}

module.exports = async (req, res) => {
  // Shopify bazen dogrulama icin GET atabiliyor - sessizce OK don.
  if (req.method !== "POST") return res.status(200).send("OK");

  const secret = req.query && req.query.secret;
  if (secret !== SECRET) {
    console.error("SIPARIS-KAYIT: gecersiz secret");
    return res.status(401).send("Unauthorized");
  }

  try {
    const order = req.body || {};
    const no = String(order.name || order.order_number || "").replace(/[^0-9]/g, "");

    if (!no) {
      console.error("SIPARIS-KAYIT: siparis numarasi cikarilamadi");
      return res.status(200).json({ ok: false, reason: "no_order_number" });
    }

    // 2026-09-18: hediye etiketi. Muhasebe kaydindan ONCE cagriliyor cunku
    // asagidaki MUHASEBE_SHEETS_URL kontrolu erken return edebiliyor -
    // o durumda bile etiketin atilmasi gerekiyor.
    await hediyeEtiketiEkle(order, no);

    if (!process.env.MUHASEBE_SHEETS_URL) {
      console.log("SIPARIS-KAYIT: MUHASEBE_SHEETS_URL tanimli degil, atlaniyor:", no);
      return res.status(200).json({ ok: true, reason: "no_sheets_url" });
    }

    const body = JSON.stringify({
      type: "siparis_yeni",
      siparisNo: no,
      tarih: order.created_at || new Date().toISOString(),
      musteri: musteriAdiCikar(order),
      odemeTipi: isKapidaOdemeSiparis(order) ? "kapida" : "online",
      tutar: Number(order.total_price) || 0
    });

    try {
      const resp = await fetchWithTimeout(process.env.MUHASEBE_SHEETS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body
      }, 10000);
      const metin = await resp.text().catch(() => "");
      console.log("SIPARIS-KAYIT:", no, "->", String(metin).slice(0, 200));
    } catch (e) {
      // Bilerek tekrar denemiyoruz - satir yazilmis olabilir, mukerrer riski var.
      // Shopify zaten 200 almazsa kendisi tekrar gonderecek, Apps Script tarafindaki
      // mukerrer kontrolu de ikinci satir acilmasini engelliyor.
      console.error("SIPARIS-KAYIT: muhasebe sheets'e yazilamadi (TEKRAR DENENMIYOR):", no, e && e.message ? e.message : e);
    }

    return res.status(200).json({ ok: true, siparisNo: no });
  } catch (error) {
    console.error("SIPARIS-KAYIT HATA:", error && error.message ? error.message : error);
    // Shopify'a her zaman 200 donuyoruz ki webhook'u devre disi birakmasin.
    return res.status(200).json({ ok: false, reason: "error" });
  }
};
