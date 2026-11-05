// lib/siparis.js
// Shopify'dan siparis numarasina gore siparis bilgisi ceker + SAHIPLIK DOGRULAMASI.
//
// 2026-11-05 NEDEN BU DOSYA VAR:
//   Bu mantik eskiden api/siparis.js icindeydi ve bot ona HTTP ile
//   (POST /api/siparis) ulasiyordu. O adres internete tamamen acikti: adresi
//   bilen herkes telefon gondermeden siparis numaralarini tek tek deneyip
//   durum / odeme / kargo takip bilgisi cekebiliyordu.
//   Artik mantik burada, ortak bir modulde. webhook-process.js bunu DOGRUDAN
//   cagiriyor (tipki lib/yurtici.js gibi) - arada HTTP yok, disariya acik
//   kapi yok, ayrica bir HTTP atlamasi eksildigi icin daha hizli.
//
// SAHIPLIK KURALI:
//   Soranin telefonu VE siparisin uzerindeki telefon birlikte varsa
//   karsilastirilir; tutmuyorsa hicbir bilgi donmez (reason: "baska_musteri")
//   ve siparisin var oldugu bile sizdirilmaz.
//   Soranin telefonu yoksa (WhatsApp kullanici adi) veya siparisin uzerinde
//   telefon yoksa dogrulama yapilamaz; bu durumda bilgi verilir
//   (dogrulamaAtlandi: true) ve durum log'a yazilir.
//
// Gerekli env degiskenleri:
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

// Odeme tipini Turkce ve sade hale getir
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

// Siparis + kargo durumunu sade Turkce metne cevir
function statusLabel(order) {
  const fulfillment = (order.fulfillment_status || "").toLowerCase();
  if (fulfillment === "fulfilled") return "Kargoya verildi";
  if (fulfillment === "partial") return "Kısmen kargoya verildi";
  if (order.cancelled_at) return "İptal edildi";
  return "Hazırlanıyor";
}

// Kargo takip numarasi ve linki (varsa)
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

// Ana fonksiyon. Eskiden /api/siparis'in JSON olarak dondurdugu nesnenin
// AYNISINI dondurur, boylece cagiran taraf degismek zorunda kalmaz.
async function siparisBilgisi(opts) {
  const o = opts || {};
  try {
    if (!o.orderNumber) {
      return { found: false, reason: "no_number" };
    }

    // # ve bosluklari temizle, sadece rakamlari al
    const clean = String(o.orderNumber).replace(/[^0-9]/g, "");
    if (!clean) {
      return { found: false, reason: "no_number" };
    }

    const soranTelefon = telefonNormalize(o.phone);

    // Shopify'da siparis "name" alani genelde #1001 formatindadir.
    // name=#1001 ile ariyoruz, bulunamazsa #-siz de deniyoruz.
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

    // Once "#1001", sonra "1001" dene
    let order = await fetchByName(`#${clean}`);
    if (!order) order = await fetchByName(clean);

    if (!order) {
      return { found: false, reason: "not_found", orderNumber: clean };
    }

    // ---------------------------------------------------------
    // SAHIPLIK DOGRULAMASI
    // ---------------------------------------------------------
    const telefonlar = siparisTelefonlari(order);
    let dogrulandi = false;
    let dogrulamaAtlandi = false;

    if (soranTelefon && telefonlar.length > 0) {
      if (telefonlar.indexOf(soranTelefon) !== -1) {
        dogrulandi = true;
      } else {
        console.warn(
          "SAHIPLIK REDDI: siparis=" + clean +
          " soran=" + soranTelefon +
          " (siparisteki telefon sayisi=" + telefonlar.length + ")"
        );
        return { found: false, reason: "baska_musteri", orderNumber: clean };
      }
    } else {
      dogrulamaAtlandi = true;
      console.warn(
        "SAHIPLIK DOGRULANAMADI (bilgi yine de verildi): siparis=" + clean +
        " soranTelefonVar=" + (soranTelefon ? "evet" : "hayir") +
        " siparisTelefonVar=" + (telefonlar.length > 0 ? "evet" : "hayir")
      );
    }

    const tracking = trackingInfo(order);

    return {
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
    };
  } catch (error) {
    console.error("SIPARIS MODUL HATASI:", (error && error.message) || error);
    return { found: false, reason: "error" };
  }
}

module.exports = {
  siparisBilgisi,
  telefonNormalize,
  siparisTelefonlari
};
