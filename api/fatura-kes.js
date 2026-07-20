// api/fatura-kes.js
// teslim-kontrol.js tarafindan (siparis teslim edildiginde) VEYA fatura-online.js
// tarafindan (online odeme aninda) cagrilir. Shopify'dan siparis detayini ceker,
// Mysoft e-Arsiv API'sine (REST + OAuth2) fatura olusturur, siparisi
// "fatura-kesildi" etiketiyle isaretler.
//
// Mysoft.EDocumentApi (v8) OpenAPI semasina gore yazildi.
// Kullanilan endpoint: POST /api/InvoiceOutbox/invoiceOutbox (Giden Fatura Ekleme)
//
// Gerekli env degiskenleri:
//   SHOPIFY_STORE, SHOPIFY_TOKEN   -> zaten mevcut (siparis.js ile ayni)
//   MYSOFT_CLIENT_ID, MYSOFT_CLIENT_SECRET -> Mysoft Portal > Firma Bilgileri >
//                                      Entegrasyon > Erisim Anahtari'ndan alinan degerler
//   MYSOFT_API_BASE_URL            -> orn: https://edocumentapi.mysoft.com.tr
//                                      (test ortami icin farkli bir domain verilmis olabilir,
//                                      Mysoft'un sana soylediginle degistir)
//   MYSOFT_VKN                     -> sirket VKN'niz (satici VKN, invoiceAccount degil,
//                                      servis kullanicisina tanimli hesap zaten biliniyor,
//                                      birden fazla musteri/hesap varsa tenantIdentifierNumber
//                                      olarak kullanilir - tek hesap oldugu icin genelde bos birakilir)
//   SHEETS_URL                     -> zaten mevcut (loglama icin, opsiyonel)

const SECRET = "masajur_yakkoholding_2128";
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const API_VERSION = "2026-04";
const INVOICED_TAG = "fatura-kesildi";

// ---- VKN/TCKN'in checkout formunda hangi alanda geldigini burada TANIMLA ----
// EasySell COD Form'da bu bilgiyi hangi custom field/note_attribute adiyla
// topluyorsan asagidaki listeye ekle. Birden fazla olasi isim deneniyor.
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

// Siparisi Shopify'dan tam detayiyla cek (fatura icin gereken tum alanlar)
async function getShopifyOrder(orderNumber) {
  const clean = String(orderNumber).replace(/[^0-9]/g, "");
  const fields = "id,name,email,phone,financial_status,fulfillment_status,cancelled_at," +
    "total_price,subtotal_price,total_tax,total_discounts,currency,tags,note_attributes," +
    "customer,billing_address,shipping_address,line_items";
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

// Siparise "fatura-kesildi" etiketi ekle (tekrar fatura kesilmesini onlemek icin)
async function tagOrderAsInvoiced(order) {
  const existingTags = order.tags ? order.tags.split(",").map(t => t.trim()).filter(Boolean) : [];
  if (existingTags.includes(INVOICED_TAG)) return; // zaten isaretli
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

// ============================================================
// MYSOFT E-ARSIV FATURA OLUSTURMA (REST + OAuth2)
// Mysoft.EDocumentApi v8 semasina gore yazildi.
// ============================================================

const MYSOFT_API_BASE_URL = process.env.MYSOFT_API_BASE_URL || "https://edocumentapi.mysoft.com.tr";

// Token 5 dakika gecerli, fonksiyonlar arasi cache icin modul seviyesinde tutuluyor.
// NOT: Vercel serverless fonksiyonlari "cold start" oldugunda bu cache sifirlanir,
// yani cogu cagrida yeni token alinacak - bu normal, sorun degil (token almak hizli).
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
  // Token 5 dakika gecerli - guvenlik payi icin 30 saniye erken suresi dolmus say
  cachedTokenExpiresAt = now + (5 * 60 - 30) * 1000;
  return cachedToken;
}

// KDV orani genelde %20 (standart oran). Farkli oranli urunlerin varsa
// bu fonksiyonu urun bazli bir haritaya cevirebiliriz.
const VARSAYILAN_KDV_ORANI = 20;

async function mysoftFaturaOlustur(payload) {
  if (!process.env.MYSOFT_CLIENT_ID || !process.env.MYSOFT_CLIENT_SECRET) {
    console.log("MYSOFT BAGLANTI BILGISI YOK - TEST MODU, GERCEK FATURA KESILMEDI");
    console.log("Kesilecek fatura (simulasyon):", JSON.stringify(payload, null, 2));
    return { basarili: false, testModu: true, mesaj: "Mysoft API bilgisi henuz tanimlanmadi" };
  }

  const token = await getMysoftAccessToken();

  const now = new Date();
  const isoNow = now.toISOString();

  // --- TUM TUTARLARI GERCEK SAYIYA CEVIR ---
  // Shopify fiyatlari string olarak gelir ("5699.00"), Mysoft sayi (number)
  // bekliyor - string gonderilirse KDV/tutar hesaplamalari sessizce 0 kaliyordu.
  const urunlerNumeric = (payload.urunler || []).map(u => {
    const qty = Number(u.miktar) || 0;
    const unitPrice = Number(u.birimFiyat) || 0;
    const vatRate = Number(u.kdvOrani) || VARSAYILAN_KDV_ORANI;
    const amtTra = Math.round(qty * unitPrice * 100) / 100;         // mal/hizmet tutari (KDV haric)
    const amtVatTra = Math.round(amtTra * (vatRate / 100) * 100) / 100; // KDV tutari
    return { ad: u.ad, qty, unitPrice, vatRate, amtTra, amtVatTra };
  });

  // Satirlarin (indirimsiz) toplami - faturada "Mal Hizmet Toplam Tutari" olarak gorunur
  const lineExtensionAmount = urunlerNumeric.reduce((s, u) => s + u.amtTra, 0);

  // Shopify siparisinin gercek toplamlari (musterinin gercekten odedigi/borclu oldugu)
  const genelToplam = Number(payload.genelToplam) || 0;   // KDV dahil, indirim sonrasi nihai tutar
  const kdvToplam = Number(payload.kdvToplam) || 0;        // Shopify'in hesapladigi toplam KDV
  const vergisizToplam = Math.round((genelToplam - kdvToplam) * 100) / 100; // KDV haric nihai tutar

  // Indirim = satirlarin ham toplami ile KDV haric nihai tutar arasindaki fark.
  // Boylece: lineExtensionAmount - indirim = vergisizToplam, vergisizToplam + kdv = genelToplam
  // matematiksel olarak her zaman tutarli olur.
  const indirimTutari = Math.round((lineExtensionAmount - vergisizToplam) * 100) / 100;

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
    isManuelCalculation: true,   // Toplamlari biz hesaplayip kesin gonderiyoruz (auto-calc hatali cikiyordu)
    isSaveAsDraft: false,        // dogrudan GIB'e gonder, taslakta birakma
    cargoAccountName: "Yurtiçi Kargo",
    invoiceAccount: {
      // VKN/TCKN bilinmiyorsa GIB standardi geregi "11111111111" (11 tane 1)
      // placeholder'i gonderilir - bos/null gonderilirse Mysoft SQL hatasi veriyor.
      vknTckn: payload.aliciVknTckn || "11111111111",
      accountName: payload.aliciUnvanAdSoyad,
      cityName: payload.aliciIl || undefined,
      citySubdivision: payload.aliciIlce || undefined,
      streetName: payload.aliciAdres || undefined,
      countryName: "TÜRKİYE",
      telephone1: payload.aliciTelefon || undefined,
      email1: payload.aliciEmail || undefined
    },
    // Fatura genel toplamlari - isManuelCalculation:true oldugu icin bu degerler
    // aynen kullanilir, Shopify siparisindeki gercek tutarlarla birebir eslesir.
    invoiceCalculation: {
      lineExtensionAmount: lineExtensionAmount,
      taxExclusiveAmount: vergisizToplam,
      taxInclusiveAmount: genelToplam,
      payableAmount: genelToplam,
      allowanceTotalAmount: indirimTutari > 0 ? indirimTutari : 0,
      chargeTotalAmount: 0
    },
    // Indirim varsa fatura uzerinde ayri, seffaf bir kalem olarak goster
    allowanceCharge: indirimTutari > 0 ? [{
      chargeIndicator: false, // false = iskonto
      allowanceChargeReason: "İndirim",
      amount: indirimTutari,
      baseAmount: lineExtensionAmount
    }] : undefined,
    invoiceDetail: urunlerNumeric.map(u => ({
      productName: u.ad,
      unitCode: "C62", // adet
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

function buildFaturaPayload(order, faturaTipi, vkn, vergiDairesi, unvan) {
  const addr = order.billing_address || order.shipping_address || {};
  const musteriAdi = unvan ||
    ((order.customer && (order.customer.first_name + " " + order.customer.last_name)) ||
      addr.name || "Belirtilmemis");

  return {
    faturaTipi: faturaTipi,              // "KURUMSAL" (e-Fatura) | "BIREYSEL" (e-Arsiv)
    siparisNo: order.name,
    faturaTarihi: new Date().toISOString().slice(0, 10),
    aliciUnvanAdSoyad: musteriAdi,
    aliciVknTckn: vkn || null,
    aliciVergiDairesi: vergiDairesi || null,
    aliciAdres: [addr.address1, addr.address2].filter(Boolean).join(" "),
    // Checkout formu genelde tek bir "sehir" alani topluyor, bu Shopify'da
    // addr.city olarak geliyor ve aslinda IL bilgisidir (ör. "Balikesir"),
    // ILCE degildir. addr.province genelde bos geliyor. Bu yuzden province
    // varsa onu il olarak kullan, yoksa city'yi il say ve ilceyi bos birak
    // (yanlislikla il adini ilce alanina yazip GIB hatasi almamak icin).
    aliciIl: addr.province || addr.city || null,
    aliciIlce: addr.province ? (addr.city || null) : null,
    aliciEmail: order.email || null,
    aliciTelefon: order.phone || addr.phone || null,
    paraBirimi: order.currency || "TRY",
    araToplam: order.subtotal_price,
    kdvToplam: order.total_tax,
    genelToplam: order.total_price,
    urunler: (order.line_items || []).map(li => ({
      ad: li.title,
      miktar: li.quantity,
      birimFiyat: li.price,
      kdvOrani: 20 // TODO: gercek KDV oranini urun/vergi satirindan al
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

    const order = await getShopifyOrder(orderNumber);
    if (!order) {
      console.error("FATURA-KES: siparis bulunamadi:", orderNumber);
      await logFaturaToSheets(orderNumber, "-", "-", "-", "ALARM: Shopify'da siparis bulunamadi - manuel kontrol gerekli");
      return res.status(200).json({ ok: false, reason: "order_not_found" });
    }

    // Zaten faturalandiysa tekrar kesme
    const existingTags = order.tags ? order.tags.split(",").map(t => t.trim()) : [];
    if (existingTags.includes(INVOICED_TAG)) {
      console.log("FATURA-KES: zaten faturali, atlaniyor:", orderNumber);
      return res.status(200).json({ ok: true, reason: "already_invoiced" });
    }

    // Iptal/iade edilmisse fatura kesme
    if (order.cancelled_at) {
      console.log("FATURA-KES: siparis iptal edilmis, atlaniyor:", orderNumber);
      await logFaturaToSheets(orderNumber, "-", "-", "-", "ATLANDI: siparis iptal edilmis");
      return res.status(200).json({ ok: true, reason: "cancelled" });
    }

    const vkn = findAttr(order, VKN_TCKN_ATTRIBUTE_NAMES);
    const vergiDairesi = findAttr(order, VERGI_DAIRESI_ATTRIBUTE_NAMES);
    const unvan = findAttr(order, UNVAN_ATTRIBUTE_NAMES);
    // Kurumsal/bireysel ayrimi yok - hepsi BIREYSEL (e-Arsiv) kesiliyor
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
      return res.status(200).json({ ok: false, sonuc });
    }
  } catch (error) {
    console.error("FATURA-KES HATA:", error && error.message ? error.message : error);
    try {
      const body = req.body || {};
      if (body.orderNumber) {
        await logFaturaToSheets(String(body.orderNumber), "-", "-", "-",
          "ALARM: beklenmeyen hata - " + (error && error.message ? error.message : "bilinmeyen") + " - manuel kontrol gerekli");
      }
    } catch (e2) {}
    return res.status(200).json({ ok: false, reason: "error", detail: error.message });
  }
};
