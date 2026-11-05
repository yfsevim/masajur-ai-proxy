// api/siparis.js
// Shopify'dan sipariş numarasına göre sipariş bilgisi çeker.
// Döndürdüğü bilgiler: durum, kargo takip no, ödeme tipi.
//
// 2026-11-05 GUVENLIK DUZELTMESI (SAHIPLIK DOGRULAMASI):
//   Eskiden bu endpoint SADECE sipariş numarası istiyordu ve hiçbir sahiplik
//   kontrolü yapmıyordu. Bu yüzden WhatsApp'ta herhangi bir müşteri rastgele
//   bir sayı yazdığında (örn. ürün fiyatı "5699") o numaraya denk gelen BAŞKA
//   bir müşterinin sipariş durumu, ödeme tipi, kargo takip numarası ve teslim
//   alan kişinin adı kendisine okunuyordu.
//   Artik: istek "phone" (musterinin WhatsApp numarasi) ile geliyorsa ve
//   siparisin uzerinde de kullanilabilir bir telefon varsa, ikisi
//   karsilastirilir. Tutmuyorsa HICBIR bilgi donmez.
//   Musterinin telefonu yoksa (WhatsApp kullanici adi) veya siparisin
//   uzerinde telefon yoksa, dogrulama yapilamaz; bu durumda eski davranis
//   korunur (sipariş numarası yeterli) ve durum log'a yazilir.
//
// Gerekli env değişkenleri:
//   SHOPIFY_STORE  -> myqsfi-29.myshopify.com
//   SHOPIFY_TOKEN  -> Admin API access token

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const API_VERSION = "2026-04";

// Telefonu karsilastirilabilir hale getir: sadece rakamlar, son 10 hane.
// "+90 532 123 45 67", "0532 123 45 67", "905321234567" -> "5321234567"
function telefonNormalize(raw) {
  const d = String(raw || "").replace(/[^0-9]/g, "");
  if (d.length < 10) return null;
  return d.slice(-10);
}

// Siparis uzerindeki tum olasi telefonlari topla
function siparisTelefonlari(order) {
  const adaylar = [
    order.phone,
    order.shipping_address && order.shipping_address.phone,
    order.billing_address && order.billing_address.phone,
    order.customer && order.customer.phone,
    order.customer && order.customer.default_address && order.customer.default_address.phone
  ];
  const liste = [];
  for (const a of adaylar) {
    const n = telefonNormalize(a);
    if (n && liste.indexOf(n) === -1) liste.push(n);
  }
  return liste;
}

// Ödeme tipini Türkçe ve sade hale getir
function paymentLabel(order) {
  const gateways = (order.payment_gateway_names || []).join(" ").toLowerCase();
  const financial = (order.financial_status || "").toLowerCase();

  if (gateways.includes("cash on delivery") || gateways.includes("kapida") || gateways.includes("cod")) {
    return "Kapıda ödeme";
  }
  if (financial === "paid") {
    return "Ödendi (kredi kartı / online)";
  }
  if (financial === "pending") {
    return "Ödeme bekliyor";
  }
  return order.gateway || "Belirtilmemiş";
}

// Sipariş + kargo durumunu sade Türkçe metne çevir
function statusLabel(order) {
  const fulfillment = (order.fulfillment_status || "").toLowerCase();
  if (fulfillment === "fulfilled") return "Kargoya verildi";
  if (fulfillment === "partial") return "Kısmen kargoya verildi";
  if (order.cancelled_at) return "İptal edildi";
  return "Hazırlanıyor";
}

// Kargo takip numarası ve linki (varsa)
function trackingInfo(order) {
  const fulfillments = order.fulfillments || [];
  for (const f of fulfillments) {
    if (f.tracking_number) {
      return {
        number: f.tracking_number,
        url: f.tracking_url || (Array.isArray(f.tracking_urls) ? f.tracking_urls[0] : null),
        company: f.tracking_company || null
      };
    }
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    let { orderNumber, phone } = req.body || {};
    if (!orderNumber) {
      return res.status(200).json({ found: false, reason: "no_number" });
    }

    // # ve boşlukları temizle, sadece rakamları al
    const clean = String(orderNumber).replace(/[^0-9]/g, "");
    if (!clean) {
      return res.status(200).json({ found: false, reason: "no_number" });
    }

    const soranTelefon = telefonNormalize(phone);

    // Shopify'da sipariş "name" alanı genelde #1001 formatındadır.
    // name=#1001 ile arıyoruz, bulunamazsa #-siz de deniyoruz.
    const base = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/orders.json`;
    const fields = "id,name,financial_status,fulfillment_status,cancelled_at,payment_gateway_names,gateway,fulfillments,phone,shipping_address,billing_address,customer";

    async function fetchByName(name) {
      const url = `${base}?status=any&name=${encodeURIComponent(name)}&fields=${fields}`;
      const r = await fetch(url, {
        headers: {
          "X-Shopify-Access-Token": SHOPIFY_TOKEN,
          "Content-Type": "application/json"
        }
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        console.error("SHOPIFY ERROR:", r.status, text);
        return null;
      }
      const data = await r.json().catch(() => ({}));
      return (data.orders && data.orders[0]) || null;
    }

    // Önce "#1001", sonra "1001" dene
    let order = await fetchByName(`#${clean}`);
    if (!order) order = await fetchByName(clean);

    if (!order) {
      return res.status(200).json({ found: false, reason: "not_found", orderNumber: clean });
    }

    // ---------------------------------------------------------
    // SAHIPLIK DOGRULAMASI
    // ---------------------------------------------------------
    const siparisTelefonlariListesi = siparisTelefonlari(order);
    let dogrulandi = false;
    let dogrulamaAtlandi = false;

    if (soranTelefon && siparisTelefonlariListesi.length > 0) {
      if (siparisTelefonlariListesi.indexOf(soranTelefon) !== -1) {
        dogrulandi = true;
      } else {
        // Sipariş var ama soran kişi sahibi değil. Siparişin varlığı hakkında
        // bile bilgi vermiyoruz - sadece "dogrulanamadi" donuyoruz.
        console.warn(
          "SAHIPLIK REDDI: siparis=" + clean +
          " soran=" + soranTelefon +
          " (siparisteki telefon sayisi=" + siparisTelefonlariListesi.length + ")"
        );
        return res.status(200).json({
          found: false,
          reason: "baska_musteri",
          orderNumber: clean
        });
      }
    } else {
      // Dogrulama yapilamadi: ya soranin telefonu yok (WhatsApp kullanici adi)
      // ya da siparisin uzerinde hic telefon yok. Eski davranis korunuyor.
      dogrulamaAtlandi = true;
      console.warn(
        "SAHIPLIK DOGRULANAMADI (bilgi yine de verildi): siparis=" + clean +
        " soranTelefonVar=" + (soranTelefon ? "evet" : "hayir") +
        " siparisTelefonVar=" + (siparisTelefonlariListesi.length > 0 ? "evet" : "hayir")
      );
    }

    const tracking = trackingInfo(order);

    return res.status(200).json({
      found: true,
      dogrulandi: dogrulandi,
      dogrulamaAtlandi: dogrulamaAtlandi,
      orderName: order.name,
      status: statusLabel(order),
      payment: paymentLabel(order),
      tracking: tracking
        ? {
            number: tracking.number,
            company: tracking.company,
            url: tracking.url
          }
        : null
    });
  } catch (error) {
    console.error("SIPARIS HANDLER ERROR:", error?.message || error);
    return res.status(200).json({ found: false, reason: "error" });
  }
};
