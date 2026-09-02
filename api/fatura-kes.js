// api/fatura-kes.js
// teslim-kontrol.js tarafindan (siparis teslim edildiginde) VEYA fatura-online.js
// tarafindan (online odeme aninda) cagrilir. Shopify'dan siparis detayini ceker,
// Mysoft e-Arsiv API'sine (REST + OAuth2) fatura olusturur, siparisi
// "fatura-kesildi" etiketiyle isaretler.
//
// Mysoft.EDocumentApi (v8) OpenAPI semasina gore yazildi.
// Kullanilan endpoint: POST /api/InvoiceOutbox/invoiceOutbox (Giden Fatura Ekleme)
//
// 2026-09-02 DUZELTME: Shopify'a "fatura-kesildi" etiketini yazan istek
// (PUT) daha once sonucu hic kontrol etmiyordu - basarisiz olsa bile
// sessizce kayboluyordu (gercek vaka: #12642, fatura basariyla kesildi
// ama Shopify'da etiket hic gorunmedi). Artik: (1) bu istegin sonucu
// kontrol edilip loglaniyor, (2) "zaten faturalandi mi" kontrolu ARTIK
// Shopify etiketine ek olarak Redis'teki KALICI bir bayraga da bakiyor -
// boylece Shopify etiketleme basarisiz olsa bile mukerrer fatura kesilmez.

const SECRET = "masajur_yakkoholding_2128";
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const API_VERSION = "2026-04";
const INVOICED_TAG = "fatura-kesildi";
const FATURALANDI_REDIS_PREFIX = "fatura-kesildi:"; // Shopify etiketinden BAGIMSIZ, kalici kayit

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

// Redis'teki kalici "faturalandi" bayragi - Shopify etiketinden bagimsiz,
// Shopify'a yazma basarisiz olsa bile bu kayit dogru kalir.
async function faturalandiMi(orderNumber) {
  try {
    const v = await redis.get(FATURALANDI_REDIS_PREFIX + orderNumber);
    return !!v;
  } catch (e) {
    return false; // Redis erisilemezse guvenli taraf: eskisi gibi devam et (Shopify etiketine bak)
  }
}
async function isaretleFaturalandi(orderNumber) {
  try {
    await redis.set(FATURALANDI_REDIS_PREFIX + orderNumber, "1"); // suresiz, hic silinmez
  } catch (e) {
    console.error("FATURA-KES: Redis 'faturalandi' bayragi yazilamadi:", orderNumber, e && e.message ? e.message : e);
  }
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

// DUZELTME: artik PUT istegin sonucunu kontrol edip logluyor - once sessizce
// basarisiz olabiliyordu (gercek vaka: #12642).
async function tagOrderAsInvoiced(order) {
  const existingTags = order.tags ? order.tags.split(",").map(t => t.trim()).filter(Boolean) : [];
  if (existingTags.includes(INVOICED_TAG)) return;
  existingTags.push(INVOICED_TAG);
  const url = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/orders/${order.id}.json`;
  try {
    const r = await fetchWithTimeout(url, {
      method: "PUT",
      headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ order: { id: order.id, tags: existingTags.join(", ") } })
    }, 8000);
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.error("FATURA-KES: Shopify etiketleme basarisiz HTTP " + r.status + ": " + errText.slice(0, 300));
    }
  } catch (e) {
    console.error("FATURA-KES: Shopify etiketleme HATA:", e && e.message ? e.message : e);
  }
}

async function logFaturaToSheets(orderNumber, tip, aliciAdi, tutar, status) {
  try {
    if (!process.env.SHEETS_URL) return;
    const body = JSON.stringify({ type: "fatura", orderNumber, faturaTipi: tip, aliciAdi, tutar, status });
    const MAX_TRIES = 3;
    for (let i = 1; i <= MAX_TRIES; i++) {
      try {
        // 2026-09-02 DUZELTME (12384/12409/12415 Sheets'te 2-3 kez gorundugu
        // vaka): eskiden 8000ms'de zaman asimi olursa "basarisiz" sayilip
        // AYNI satir tekrar gonderiliyordu. Ama Google Apps Script tarafinda
        // satir EKLEME islemi cogu zaman zaten TAMAMLANMIS oluyor, sadece HTTP
        // cevabi gecikiyor - yani zaman asimi "basarisiz oldu" anlamina
        // gelmez, "cevabi goremedim" anlamina gelir. Bunu "basarisiz" sayip
        // tekrar denemek, ayni satirin Sheets'e 2-3 kez yazilmasina yol
        // aciyordu (fatura numarasi/ETTN hep AYNIYDI - yani mukerrer fatura
        // KESILMEDI, sadece log satiri mukerrer yazildi - yine de kafa
        // karistirici ve yanlis). Zaman asimini biraz uzattik VE zaman
        // asiminda ARTIK TEKRAR DENEMIYORUZ - sadece net baglanti hatalarinda
        // (DNS, ag koptu vb.) veya sunucunun acikca hata dondurdugu (HTTP
        // 4xx/5xx) durumlarda tekrar deniyoruz.
        const resp = await fetchWithTimeout(process.env.SHEETS_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body }, 15000);
        if (resp.ok) return;
        console.error("FATURA SHEETS LOG: HTTP " + resp.status + " (deneme " + i + "/" + MAX_TRIES + ")");
      } catch (e) {
        const zamanAsimiMi = e && (e.name === "AbortError" || /abort/i.test(e.message || ""));
        if (zamanAsimiMi) {
          console.error("FATURA SHEETS LOG: zaman asimi - Sheets tarafinda islem TAMAMLANMIS OLABILIR, mukerrer kayit riski yuzunden TEKRAR DENENMIYOR:", orderNumber);
          return;
        }
        console.error("FATURA SHEETS LOG HATA (deneme " + i + "/" + MAX_TRIES + "):", e && e.message ? e.message : e);
      }
      if (i < MAX_TRIES) await new Promise(r => setTimeout(r, 1000 * i));
    }
    console.error("FATURA SHEETS LOG: 3 denemede de basarisiz, kayit Sheets'e dusmedi:", orderNumber);
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
      shippingDate: payload.kargoTarihi || payload.odemeTarihi || isoNow,
      shippingAccountName: "Yurtiçi Kargo",
      shippingAccountVknTckn: YURTICI_KARGO_VKN
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

// ============ BIR KEREYE MAHSUS BACKFILL (2026-09-02) ============
// NOT: Tarama modu artik sadece son 15 gune bakiyor (gecmise kasitli olarak
// dokunmuyor - kullanici gecmis eksik faturalari kendisi manuel halledecek).
// Bu backfill de sadece o pencereyle uyumlu olacak sekilde SON 15 GUNDE
// Sheets'te "KESILDI OK" gorunen siparisleri isaretliyor - amaci, tarama ilk
// calistiginda bu YAKIN GECMIS siparisleri (Shopify etiketi yazilmamis olsa
// bile, bkz. #12642 vakasi) yanlislikla "eksik" sanip yeniden faturalamasini
// onlemek. GET ?mod=backfill ile bir KEZ calistirilmasi yeterli, tekrar
// calistirmak zararsizdir.
const BACKFILL_SIPARISLER = [
  12094, 12099, 12116, 12129, 12131, 12139, 12142, 12144, 12157, 12168, 12172, 12179, 12180, 12182, 12189,
  12195, 12199, 12202, 12235, 12239, 12252, 12255, 12269, 12273, 12274, 12277, 12279, 12282, 12286, 12291,
  12308, 12324, 12328, 12338, 12367, 12369, 12371, 12376, 12377, 12378, 12379, 12381, 12382, 12383, 12385,
  12386, 12387, 12388, 12389, 12390, 12392, 12393, 12394, 12395, 12396, 12397, 12398, 12399, 12400, 12401,
  12403, 12404, 12405, 12406, 12407, 12408, 12410, 12411, 12413, 12414, 12416, 12418, 12419, 12420, 12421,
  12422, 12423, 12424, 12425, 12426, 12428, 12429, 12430, 12431, 12432, 12433, 12436, 12437, 12438, 12440,
  12441, 12442, 12444, 12445, 12446, 12448, 12451, 12452, 12453, 12454, 12455, 12456, 12457, 12458, 12460,
  12461, 12462, 12464, 12465, 12466, 12467, 12468, 12469, 12470, 12471, 12472, 12473, 12475, 12476, 12477,
  12479, 12481, 12482, 12483, 12484, 12486, 12487, 12488, 12489, 12490, 12492, 12495, 12496, 12497, 12498,
  12499, 12500, 12505, 12507, 12509, 12515, 12516, 12519, 12520, 12522, 12523, 12526, 12527, 12534, 12537,
  12538, 12542, 12543, 12544, 12546, 12547, 12549, 12550, 12556, 12557, 12569, 12570, 12571, 12572, 12573,
  12575, 12576, 12577, 12578, 12580, 12581, 12582, 12588, 12589, 12591, 12592, 12594, 12596, 12597, 12598,
  12599, 12600, 12601, 12602, 12605, 12606, 12607, 12608, 12609, 12610, 12612, 12613, 12616, 12617, 12618,
  12621, 12622, 12623, 12626, 12628, 12631, 12632, 12633, 12634, 12637, 12638, 12639, 12640, 12641, 12642,
  12644, 12645, 12646, 12647, 12648, 12649, 12650, 12652, 12653, 12655, 12657, 12658, 12659, 12660, 12662,
  12664, 12666, 12667, 12669, 12670, 12674, 12682, 12685, 12687, 12692, 12694
];

async function handleBackfill(req, res) {
  const secret = req.query && req.query.secret;
  if (secret !== SECRET) {
    console.error("FATURA-KES BACKFILL: gecersiz secret");
    return res.status(401).send("Unauthorized");
  }
  let sayac = 0;
  for (const no of BACKFILL_SIPARISLER) {
    await isaretleFaturalandi(String(no));
    sayac++;
  }
  console.log("FATURA-KES BACKFILL: " + sayac + " siparis Redis'te faturalandi olarak isaretlendi");
  return res.status(200).send("OK - " + sayac + " siparis isaretlendi");
}
// ============ /BACKFILL ============

module.exports = async (req, res) => {
  if (req.method === "GET" && req.query && req.query.mod === "backfill") {
    return handleBackfill(req, res);
  }

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

    // DUZELTME: Shopify etiketine ek olarak Redis'teki kalici bayraga da bak -
    // Shopify etiketleme gecmiste sessizce basarisiz olabiliyordu (#12642 vakasi).
    if (await faturalandiMi(orderNumber)) {
      console.log("FATURA-KES: Redis kaydina gore zaten faturali, atlaniyor:", orderNumber);
      await releaseFaturaLock(orderNumber);
      return res.status(200).json({ ok: true, reason: "already_invoiced_redis" });
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
      console.log("FATURA-KES: zaten faturali (Shopify etiketi), atlaniyor:", orderNumber);
      await isaretleFaturalandi(orderNumber); // Redis kaydi da eksikse tamamla
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
      await isaretleFaturalandi(orderNumber); // Redis'teki kalici kayit - once bu, Shopify'a ne olursa olsun garanti
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
