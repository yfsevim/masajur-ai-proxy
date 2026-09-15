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
