// api/fatura-kes.js
// teslim-kontrol.js tarafindan (siparis teslim edildiginde) VEYA fatura-online.js
// tarafindan (online odeme aninda) cagrilir. Shopify'dan siparis detayini ceker,
// Mysoft e-Arsiv API'sine (REST + OAuth2) fatura olusturur, siparisi
// "fatura-kesildi" etiketiyle isaretler.
//
// Mysoft.EDocumentApi (v8) OpenAPI semasina gore yazildi.
// Kullanilan endpoint: POST /api/InvoiceOutbox/invoiceOutbox (Giden Fatura Ekleme)

const SECRET = "masajur_yakkoholding_2128";
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const API_VERSION = "2026-04";
const INVOICED_TAG = "fatura-kesildi";

const { Redis } = require("@upstash/redis");
const redis = Redis.fromEnv();

async function acquireFaturaLock(orderNumber) {
  try {
    const result = await redis.set("fatura-lock:" + orderNumber, "1", { nx: true, ex: 3600 });
    return result !== null;
  } catch (e) {
    console.error("FATURA-KES: Redis kilit hatasi, guvenli taraf - devam ediliyor:", e && e.message ? e.message : e);
    return true;
  }
}

async function releaseFaturaLock(orderNumber) {
  try {
    await redis.del("fatura-lock:" + orderNumber);
  } catch (e) {}
}

const VKN_TCKN_ATTRIBUTE_NAMES = [
  "Vergi No", "VKN", "TC Kimlik No", "TCKN", "Vergi Kimlik No", "Kimlik No"
];
const VERGI_DAIRESI_ATTRIBUTE_NAMES = ["Vergi Dairesi"];
const UNVAN_ATTRIBUTE_NAMES = ["Firma Unvanı", "Şirket Unvanı", "Unvan"];

function findAttr(order, names) {
  const attrs = Array.isArray(order.note_attributes) ? order.note_attributes : [];
  for (const n of names) {
    const found = attrs.find(a => a.name && a.name.trim().toLowerCase() === n.toLowerCase());
    if (found && found.value) return String(found.value).trim();
  }
  return null;
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

async function getShopifyOrder(orderNumber) {
  const clean = String(orderNumber).replace(/[^0-9]/g, "");
  const fields = "id,name,email,phone,financial_status,fulfillment_status,cancelled_at," +
    "total_price,subtotal_price,total_tax,total_discounts,currency,tags,note_attributes," +
    "customer,billing_address,shipping_address,line_items,fulfillments," +
    "created_at,processed_at,payment_gateway_names";
  const base = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/orders.json`;

  async function fetchByName(name) {
    const url = `${base}?status=any&name=${encodeURIComponent(name)}&fields=${fields}`;
    const r = await fetchWithTimeout(url, {
      headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" }
    }, 8000);
    if (!r.ok) return null;
    const data = await r.json().catch(() => ({}));
    return (data.orders && data.orders[0]) || null;
  }

  let order = await fetchByName(`#${clean}`);
  if (!order) order = await fetchByName(clean);
  return order;
}

async function tagOrderAsInvoiced(order) {
  const existingTags = order.tags ? order.tags.split(",").map(t => t.trim()).filter(Boolean) : [];
  if (existingTags.includes(INVOICED_TAG)) return;
  existingTags.push(INVOICED_TAG);
  const url = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/orders/${order.id}.json`;
  await fetchWithTimeout(url, {
    method: "PUT",
    headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ order: { id: order.id, tags: existingTags.join(", ") } })
  }, 8000);
}

async function logFaturaToSheets(orderNumber, tip, aliciAdi, tutar, status) {
  try {
    if (!process.env.SHEETS_URL) return;
    await fetchWithTimeout(process.env.SHEETS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "fatura",
        orderNumber: orderNumber,
        faturaTipi: tip,
        aliciAdi: aliciAdi,
        tutar: tutar,
        status: status
      })
    }, 8000);
  } catch (e) {
    console.error("FATURA SHEETS LOG HATA:", e && e.message ? e.message : e);
  }
}

const MYSOFT_API_BASE_URL = process.env.MYSOFT_API_BASE_URL || "https://edocumentapi.mysoft.com.tr";

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getMysoftAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt) {
    return cachedToken;
  }

  if (!process.env.MYSOFT_CLIENT_ID || !process.env.MYSOFT_CLIENT_SECRET) {
    throw new Error("MYSOFT_CLIENT_ID / MYSOFT_CLIENT_SECRET tanimli degil");
  }

  const params = new URLSearchParams();
  params.append("client_id", process.env.MYSOFT_CLIENT_ID);
  params.append("client_secret", process.env.MYSOFT_CLIENT_SECRET);
  params.append("grant_type", "client_credentials");

  const resp = await fetchWithTimeout(MYSOFT_API_BASE_URL + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  }, 8000);

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    throw new Error("Mysoft token alinamadi: " + JSON.stringify(data));
  }

  cachedToken = data.access_token;
  cachedTokenExpiresAt = now + (5 * 60 - 30) * 1000;
  return cachedToken;
}

const VARSAYILAN_KDV_ORANI = 20;
const YURTICI_KARGO_VKN = "9860008925"; // Yurtici Kargo A.S.'nin kendi VKN'si - tum gonderilerde sabit
const STORE_WEBSITE_URL = "https://masajur.com";

async function mysoftFaturaOlustur(payload) {
  if (!process.env.MYSOFT_CLIENT_ID || !process.env.MYSOFT_CLIENT_SECRET) {
    console.log("MYSOFT BAGLANTI BILGISI YOK - TEST MODU, GERCEK FATURA KESILMEDI");
    console.log("Kesilecek fatura (simulasyon):", JSON.stringify(payload, null, 2));
    return { basarili: false, testModu: true, mesaj: "Mysoft API bilgisi henuz tanimlanmadi" };
  }

  const token = await getMysoftAccessToken();

  const now = new Date();
  const isoNow = now.toISOString();

  const kdvDahilSatirlarHam = (payload.urunler || []).map(u => {
    const qty = Number(u.miktar) || 0;
    const vatRate = Number(u.kdvOrani) || VARSAYILAN_KDV_ORANI;
    const kdvDahilBirimFiyat = Number(u.birimFiyat) || 0;
    const kdvDahilSatirToplam = Math.round(qty * kdvDahilBirimFiyat * 100) / 100;
    return { ad: u.ad, qty, vatRate, kdvDahilSatirToplam };
  });
  const toplamKdvDahilUrunler = kdvDahilSatirlarHam.reduce((s, u) => s + u.kdvDahilSatirToplam, 0);

  const genelToplam = Number(payload.genelToplam) || 0;

  const ANA_URUN_INDEX = 0;
  const indirimKdvDahil = Math.max(0, Math.round((toplamKdvDahilUrunler - genelToplam) * 100) / 100);
  const digerUrunlerToplami = kdvDahilSatirlarHam.reduce(
    (s, u, i) => (i === ANA_URUN_INDEX ? s : s + u.kdvDahilSatirToplam), 0
  );

  const urunlerNumeric = kdvDahilSatirlarHam.map((u, i) => {
    let kdvDahilSatirIndirimli;
    if (i === ANA_URUN_INDEX) {
      kdvDahilSatirIndirimli = digerUrunlerToplami > 0
        ? u.kdvDahilSatirToplam
        : Math.max(0, Math.round((u.kdvDahilSatirToplam - indirimKdvDahil) * 100) / 100);
    } else if (u.kdvDahilSatirToplam > 0 && digerUrunlerToplami > 0) {
      const oran = u.kdvDahilSatirToplam / digerUrunlerToplami;
      kdvDahilSatirIndirimli = Math.max(0, Math.round((u.kdvDahilSatirToplam - indirimKdvDahil * oran) * 100) / 100);
    } else {
      kdvDahilSatirIndirimli = u.kdvDahilSatirToplam;
    }
    const amtTra = Math.round((kdvDahilSatirIndirimli / (1 + u.vatRate / 100)) * 100) / 100;
    const amtVatTra = Math.round((kdvDahilSatirIndirimli - amtTra) * 100) / 100;
    const unitPrice = u.qty > 0 ? Math.round((amtTra / u.qty) * 100) / 100 : 0;
    return { ad: u.ad, qty: u.qty, unitPrice, vatRate: u.vatRate, amtTra, amtVatTra };
  });

  const lineExtensionAmount = urunlerNumeric.reduce((s, u) => s + u.amtTra, 0);
  const kdvToplam = urunlerNumeric.reduce((s, u) => s + u.amtVatTra, 0);
  const vergisizToplam = Math.round((genelToplam - kdvToplam) * 100) / 100;

  const invoiceOutboxModel = {
    eDocumentType: "EARSIVFATURA",
    profile: "EARSIVFATURA",
    invoiceType: "SATIS",
    docDate: isoNow,
    docTime: isoNow,
    currencyCode: payload.paraBirimi || "TRY",
    currencyRate: 1,
    senderType: "ELEKTRONIK",
    orderNo: payload.siparisNo,
    orderDate: isoNow,
    isManuelCalculation: true,
    isSaveAsDraft: false,
    isAddPayableAmountString: true,
    cargoAccountName: "Yurtiçi Kargo",
    cargoNumber: payload.kargoTakipNo || undefined,
    waybillInfo: payload.kargoTakipNo ? [{
      waybillNo: payload.kargoTakipNo,
      waybillDate: payload.kargoTarihi || isoNow
    }] : undefined,
    internetShipmentInfo: {
      webSiteUrl: STORE_WEBSITE_URL,
      paymentType: payload.odemeSekli || "DIGER",
      paymentDate: payload.odemeTarihi || isoNow,
      shippingDate: payload.kargoTarihi || undefined,
      shippingAccountName: payload.kargoTakipNo ? "Yurtiçi Kargo" : undefined,
      shippingAccountVknTckn: payload.kargoTakipNo ? YURTICI_KARGO_VKN : undefined
    },
    invoiceAccount: {
      vknTckn: payload.aliciVknTckn || "11111111111",
      accountName: payload.aliciUnvanAdSoyad,
      cityName: payload.aliciIl || undefined,
      citySubdivision: payload.aliciIlce || undefined,
      streetName: payload.aliciAdres || undefined,
      countryName: "TÜRKİYE",
      telephone1: payload.aliciTelefon || undefined,
      email1: payload.aliciEmail || undefined
    },
    invoiceCalculation: {
      lineExtensionAmount: lineExtensionAmount,
      taxExclusiveAmount: vergisizToplam,
      taxInclusiveAmount: genelToplam,
      payableAmount: genelToplam,
      allowanceTotalAmount: 0,
      chargeTotalAmount: 0
    },
    invoiceDetail: urunlerNumeric.map(u => ({
      productName: u.ad,
      unitCode: "C62",
      qty: u.qty,
      unitPriceTra: u.unitPrice,
      amtTra: u.amtTra,
      vatRate: u.vatRate,
      amtVatTra: u.amtVatTra
    }))
  };

  const resp = await fetchWithTimeout(MYSOFT_API_BASE_URL + "/api/InvoiceOutbox/invoiceOutbox", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(invoiceOutboxModel)
  }, 15000);

  const result = await resp.json().catch(() => ({}));

  if (!resp.ok || !result.succeed) {
    return {
      basarili: false,
      mesaj: (result && (result.message || result.errorCode)) || ("HTTP " + resp.status),
      detay: result
    };
  }

  return {
    basarili: true,
    faturaId: result.data && result.data.invoiceId,
    faturaEttn: result.data && result.data.invoiceETTN,
    faturaNo: result.data && result.data.docNo
  };
}

function isKapidaOdemeSiparis(order) {
  const gateways = (order.payment_gateway_names || []).join(" ").toLowerCase();
  return gateways.includes("cash on delivery") || gateways.includes("kapida") || gateways.includes("cod");
}

function buildFaturaPayload(order, faturaTipi, vkn, vergiDairesi, unvan) {
  const addr = order.billing_address || order.shipping_address || {};
  const musteriAdi = unvan ||
    ((order.customer && (order.customer.first_name + " " + order.customer.last_name)) ||
      addr.name || "Belirtilmemis");

  const fulfillment = (order.fulfillments && order.fulfillments[0]) || null;
  const kargoTakipNo = fulfillment ? fulfillment.tracking_number : null;
  const kargoTarihi = fulfillment ? fulfillment.created_at : null;

  const kapidaOdeme = isKapidaOdemeSiparis(order);

  return {
    faturaTipi: faturaTipi,
    siparisNo: order.name,
    faturaTarihi: new Date().toISOString().slice(0, 10),
    aliciUnvanAdSoyad: musteriAdi,
    aliciVknTckn: vkn || null,
    aliciVergiDairesi: vergiDairesi || null,
    aliciAdres: [addr.address1, addr.address2].filter(Boolean).join(" "),
    aliciIl: addr.province || addr.city || null,
    aliciIlce: addr.province ? (addr.city || null) : null,
    aliciEmail: order.email || null,
    aliciTelefon: order.phone || addr.phone || null,
    paraBirimi: order.currency || "TRY",
    araToplam: order.subtotal_price,
    kdvToplam: order.total_tax,
    genelToplam: order.total_price,
    kargoTakipNo: kargoTakipNo,
    kargoTarihi: kargoTarihi,
    odemeTarihi: order.processed_at || order.created_at,
    odemeSekli: kapidaOdeme ? "KAPIDAODEME" : "KREDIKARTI/BANKAKARTI",
    urunler: (order.line_items || []).map(li => ({
      ad: li.title,
      miktar: li.quantity,
      birimFiyat: li.price,
      kdvOrani: 20
    }))
  };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("OK");

  const secret = req.query && req.query.secret;
  if (secret !== SECRET) {
    console.error("FATURA-KES: gecersiz secret");
    return res.status(401).send("Unauthorized");
  }

  try {
    const body = req.body || {};
    const orderNumber = body.orderNumber ? String(body.orderNumber) : "";
    if (!orderNumber) return res.status(200).json({ ok: false, reason: "no_order_number" });

    const kilitAlindi = await acquireFaturaLock(orderNumber);
    if (!kilitAlindi) {
      console.log("FATURA-KES: baska bir istek bu siparisi zaten isliyor, atlaniyor:", orderNumber);
      return res.status(200).json({ ok: true, reason: "locked_duplicate" });
    }

    const order = await getShopifyOrder(orderNumber);
    if (!order) {
      console.error("FATURA-KES: siparis bulunamadi:", orderNumber);
      await logFaturaToSheets(orderNumber, "-", "-", "-", "ALARM: Shopify'da siparis bulunamadi - manuel kontrol gerekli");
      await releaseFaturaLock(orderNumber);
      return res.status(200).json({ ok: false, reason: "order_not_found" });
    }

    const existingTags = order.tags ? order.tags.split(",").map(t => t.trim()) : [];
    if (existingTags.includes(INVOICED_TAG)) {
      console.log("FATURA-KES: zaten faturali, atlaniyor:", orderNumber);
      await releaseFaturaLock(orderNumber);
      return res.status(200).json({ ok: true, reason: "already_invoiced" });
    }

    if (order.cancelled_at) {
      console.log("FATURA-KES: siparis iptal edilmis, atlaniyor:", orderNumber);
      await logFaturaToSheets(orderNumber, "-", "-", "-", "ATLANDI: siparis iptal edilmis");
      await releaseFaturaLock(orderNumber);
      return res.status(200).json({ ok: true, reason: "cancelled" });
    }

    const vkn = findAttr(order, VKN_TCKN_ATTRIBUTE_NAMES);
    const vergiDairesi = findAttr(order, VERGI_DAIRESI_ATTRIBUTE_NAMES);
    const unvan = findAttr(order, UNVAN_ATTRIBUTE_NAMES);
    const faturaTipi = "BIREYSEL";

    const payload = buildFaturaPayload(order, faturaTipi, vkn, vergiDairesi, unvan);
    console.log("FATURA-KES: hazirlanan fatura:", JSON.stringify(payload));

    const sonuc = await mysoftFaturaOlustur(payload);

    if (sonuc.basarili) {
      await tagOrderAsInvoiced(order);
      await logFaturaToSheets(orderNumber, faturaTipi, payload.aliciUnvanAdSoyad, payload.genelToplam,
        "KESILDI OK - Fatura No: " + (sonuc.faturaNo || "-") + " ETTN: " + (sonuc.faturaEttn || "-"));
      return res.status(200).json({ ok: true, sonuc });
    } else {
      await logFaturaToSheets(orderNumber, faturaTipi, payload.aliciUnvanAdSoyad, payload.genelToplam,
        "KESILEMEDI: " + (sonuc.mesaj || "bilinmeyen"));
      await releaseFaturaLock(orderNumber);
      return res.status(200).json({ ok: false, sonuc });
    }
  } catch (error) {
    console.error("FATURA-KES HATA:", error && error.message ? error.message : error);
    try {
      const body = req.body || {};
      if (body.orderNumber) {
        await logFaturaToSheets(String(body.orderNumber), "-", "-", "-",
          "ALARM: beklenmeyen hata - " + (error && error.message ? error.message : "bilinmeyen") + " - manuel kontrol gerekli");
        await releaseFaturaLock(String(body.orderNumber));
      }
    } catch (e2) {}
    return res.status(200).json({ ok: false, reason: "error", detail: error.message });
  }
};
