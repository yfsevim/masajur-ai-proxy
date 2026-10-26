// ============================================================
// api/video-teklifi.js  -  MEMNUNIYET VIDEOSU TEKLIFI (2026-10-26)
// ------------------------------------------------------------
// NE YAPAR: Cihazi ~12 gundur kullanan musteriye WhatsApp'tan video
// teklifi gonderir. Musteri "Katilmak istiyorum" dugmesine basarsa
// webhook-process.js isletme numaralarina bildirim dusuyor.
//
// NEDEN TARAMA, NEDEN QSTASH GECIKMESI DEGIL:
// Ilk tasarim fulfillment.js'ten 12 gunluk bir QStash gorevi birakmakti
// (yorum.js'teki 4d deseninin aynisi). Vazgecildi:
//   - QStash'in gecikme ust siniri plana gore degisiyor, 12 gun sinira
//     takilabilir ve gorev sessizce dusebilir.
//   - Tek seferlik gorev kaybolursa o musteriye teklif HIC gitmez.
// Tarama kendi kendini onariyor: bir gun calismazsa ertesi gun ayni
// siparisler hala pencerede oldugu icin yakalaniyorlar.
//
// PENCERE: siparis tarihi 13-16 gun once olanlar. Kargo genelde ayni
// gun/ertesi gun cikiyor, teslimat 1-3 is gunu - yani musteri cihazi
// ~10-14 gundur kullaniyor oluyor.
//
// GUVENLIK RAYLARI:
// - GERCEKTEN TESLIM EDILMIS MI: Yurtici'den dogrulaniyor (yorum.js ile
//   ayni ortak istemci). Kapidan donene ya da hala yoldakine gitmiyor.
// - Telefon basina SADECE BIR teklif (Redis bayragi, 180 gun).
// - "Simdilik istemiyorum" diyene bir daha gitmiyor.
// - Sessiz saat: 22:00-09:00 arasi gonderim yok.
// - PARTI_LIMITI: tek calismada en fazla 10 mesaj.
// - Kendi numaralarimiz atlaniyor.
//
// TEST   : GET  ?mod=test&secret=...                 -> hicbir mesaj gondermez
// DENEME : GET  ?mod=dene&telefon=905...&secret=...  -> tek numaraya ornek
// GERCEK : POST ?secret=...   (QStash Schedule ile gunde bir, 11:00)
// ============================================================

const { Redis } = require("@upstash/redis");
const redis = Redis.fromEnv();
const yurtici = require("../lib/yurtici");

const SECRET = "masajur_yakkoholding_2128";
const API_VERSION = "2026-04";

const TEMPLATE = "video_teklifi";
const TEMPLATE_LANG = "tr";

// --- Pencere (siparis tarihi) ---
const PENCERE_BAS_GUN = 13;
const PENCERE_SON_GUN = 16;

// BASLANGIC TARIHI (2026-10-26)
// Sistem bugun kuruldu ve penceresinde HAZIRDA ~73 eski siparis vardi.
// Onlara toplu teklif gitmesi istenmedi: bu tarihten ONCE verilmis hicbir
// siparise teklif gonderilmiyor. Yani ilk teklifler, bugunden sonra
// siparis veren musteriler 13 gunu doldurdugunda (kabaca 8 Kasim)
// baslayacak. Tarihi ileride degistirmek isterseniz tek satir yeterli.
const BASLANGIC_TARIHI = "2026-10-26T00:00:00Z";

// Gunluk siparis ~18-20; 4 gunluk pencereyi takip edebilmek icin limit
// bunun uzerinde olmali, yoksa her gun geride kalinir ve musteriler
// pencereden dusup hic teklif almaz.
const PARTI_LIMITI = 25;

// --- Redis ---
const GONDERILDI = "video-teklifi:";     // <telefon>
const KAPALI = "video-kapali:";          // <telefon> - "simdilik istemiyorum"
const GONDERILDI_OMRU = 180 * 24 * 3600;

const ALERT_NUMBERS = ["905530681619", "905511485344"];

// --- SESSIZ SAAT ---
// Gunde bir, saat 11:00'de calisacak sekilde planlaniyor; bu kontrol yine de
// duruyor - zamanlayici kayarsa ya da elle tetiklenirse gece mesaj gitmesin.
const SESSIZ_BASLANGIC = 22;
const SESSIZ_BITIS = 9;

function turkiyeSaati() {
  return (new Date().getUTCHours() + 3) % 24;
}
function sessizSaatteMiyiz() {
  const s = turkiyeSaati();
  return s >= SESSIZ_BASLANGIC || s < SESSIZ_BITIS;
}

// yorum.js / teslim-kontrol.js ile AYNI ortak devre kesici
const cb = yurtici.createCircuitBreaker("yurtici-cb");

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, ms || 15000);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

function normalizeTelefon(ham) {
  if (!ham) return "";
  let d = String(ham).replace(/[^0-9]/g, "");
  if (!d) return "";
  if (d.startsWith("0")) d = "90" + d.slice(1);
  if (!d.startsWith("90")) d = "90" + d;
  return d.length === 12 ? d : "";
}

function telefonCikar(o) {
  const s = o || {};
  const adaylar = [
    s.shipping_address && s.shipping_address.phone,
    s.customer && s.customer.phone,
    s.billing_address && s.billing_address.phone,
    s.phone
  ];
  for (const a of adaylar) {
    const n = normalizeTelefon(a);
    if (n) return n;
  }
  return "";
}

function adCikar(o) {
  const s = o || {};
  const kaynaklar = [
    s.shipping_address && s.shipping_address.first_name,
    s.customer && s.customer.first_name,
    s.billing_address && s.billing_address.first_name
  ];
  for (const k of kaynaklar) {
    const t = String(k || "").trim();
    if (t) {
      return t.charAt(0).toLocaleUpperCase("tr-TR") +
             t.slice(1).toLocaleLowerCase("tr-TR");
    }
  }
  return "değerli müşterimiz";
}

// fulfillment.js ile AYNI mantik: "#11742-F5" -> "11742"
function siparisNoCikar(o) {
  if (o && o.name) {
    const ilk = String(o.name).split(/[.\-_\s]/)[0];
    const rakam = ilk.replace(/[^0-9]/g, "");
    if (rakam) return rakam;
    const m = String(o.name).match(/\d+/);
    if (m) return m[0];
  }
  if (o && o.order_number != null) return String(o.order_number).replace(/[^0-9]/g, "");
  return "";
}

function sonrakiSayfaUrl(linkHeader) {
  if (!linkHeader) return "";
  for (const p of String(linkHeader).split(",")) {
    if (p.indexOf('rel="next"') !== -1) {
      const m = p.match(/<([^>]+)>/);
      if (m) return m[1];
    }
  }
  return "";
}

// Penceredeki KARGOYA VERILMIS siparisleri getir
async function pencereSiparisleri() {
  const pencereAlt = Date.now() - PENCERE_SON_GUN * 24 * 3600 * 1000;
  const pencereUst = Date.now() - PENCERE_BAS_GUN * 24 * 3600 * 1000;
  const baslangic = Date.parse(BASLANGIC_TARIHI);

  // Baslangic tarihinden onceki siparisler HIC sorgulanmiyor.
  const altSinir = Math.max(pencereAlt, baslangic);
  if (altSinir >= pencereUst) return [];   // pencere henuz baslangic tarihine gelmedi

  const min = new Date(altSinir).toISOString();
  const max = new Date(pencereUst).toISOString();
  let url = "https://" + process.env.SHOPIFY_STORE + "/admin/api/" + API_VERSION +
    "/orders.json?status=any&fulfillment_status=shipped&limit=250" +
    "&created_at_min=" + encodeURIComponent(min) +
    "&created_at_max=" + encodeURIComponent(max) +
    "&fields=id,name,order_number,phone,customer,shipping_address,billing_address,created_at";

  const hepsi = [];
  let sayfa = 0;
  while (url && sayfa < 5) {
    const r = await fetchWithTimeout(url, {
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_TOKEN,
        "Content-Type": "application/json"
      }
    }, 20000);
    if (!r.ok) {
      const govde = await r.text().catch(function () { return ""; });
      throw new Error("orders.json HTTP " + r.status + " - " + govde.slice(0, 200));
    }
    const data = await r.json().catch(function () { return {}; });
    const liste = Array.isArray(data.orders) ? data.orders : [];
    for (const o of liste) hepsi.push(o);
    url = sonrakiSayfaUrl(r.headers.get("link"));
    sayfa++;
  }
  return hepsi;
}

async function bayrakVar(anahtar) {
  try {
    const v = await redis.get(anahtar);
    return !!v;
  } catch (e) {
    // Redis okunamiyorsa GONDERME. Mukerrer teklif ("bir daha video cekin,
    // yine 1000 TL") hic gitmemesinden cok daha kotu.
    console.error("VIDEO-TEKLIFI: Redis okunamadi, atlandi:", e && e.message ? e.message : e);
    return true;
  }
}

async function bayrakAt(anahtar, omur) {
  try { await redis.set(anahtar, "1", { ex: omur }); } catch (e) {}
}

function durumOku(data) {
  if (data && data.messages && data.messages[0] && data.messages[0].id && !data.error) {
    return "Gonderildi OK (" + data.messages[0].id + ")";
  }
  if (data && data.error) {
    return "GITMEDI: " + (data.error.message || JSON.stringify(data.error)).slice(0, 200);
  }
  return "GITMEDI: beklenmeyen cevap";
}

async function sablonGonder(telefon, ad) {
  try {
    const resp = await fetchWithTimeout(
      "https://graph.facebook.com/v23.0/" + process.env.WHATSAPP_PHONE_NUMBER_ID + "/messages",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + process.env.WHATSAPP_TOKEN,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: telefon,
          type: "template",
          template: {
            name: TEMPLATE,
            language: { code: TEMPLATE_LANG },
            components: [{
              type: "body",
              parameters: [{ type: "text", text: ad }]
            }]
          }
        })
      },
      15000
    );
    const data = await resp.json().catch(function () { return {}; });
    return durumOku(data);
  } catch (e) {
    return "GITMEDI HATA: " + (e && e.message ? e.message : e);
  }
}

async function sheetsYaz(siparisNo, telefon, ad, durum) {
  try {
    if (!process.env.SHEETS_URL) return;
    await fetchWithTimeout(process.env.SHEETS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "video_teklifi",
        id: "video-" + telefon,
        siparisNo: String(siparisNo || ""),
        phone: String(telefon || ""),
        name: String(ad || ""),
        status: String(durum || "")
      })
    }, 12000);
  } catch (e) {
    console.error("VIDEO-TEKLIFI: Sheets yazilamadi:", e && e.message ? e.message : e);
  }
}

// Bu siparis gercekten MUSTERIYE teslim edilmis mi?
// Doner: true (teslim) | false (teslim degil) | null (bilinmiyor)
async function teslimEdildiMi(siparisNo) {
  if (!siparisNo) return null;
  const raw = await yurtici.queryShipment(siparisNo, cb, "VIDEO-TEKLIFI");
  if (!raw) return null;                       // Yurtici'ye ulasilamadi
  return !!raw.gercektenMusteriyeTeslimEdildi;
}

// Bu siparise teklif gider mi? Doner: { gonder, sebep }
async function karar(o) {
  const telefon = telefonCikar(o);
  if (!telefon) return { gonder: false, sebep: "telefon yok" };
  if (ALERT_NUMBERS.includes(telefon)) return { gonder: false, sebep: "kendi numaramiz" };
  if (await bayrakVar(GONDERILDI + telefon)) return { gonder: false, sebep: "zaten teklif gonderilmis" };
  if (await bayrakVar(KAPALI + telefon)) return { gonder: false, sebep: "istemiyorum demis" };

  const siparisNo = siparisNoCikar(o);
  const teslim = await teslimEdildiMi(siparisNo);
  if (teslim === false) {
    // Teslim edilmemis: bayrak ATILMIYOR, yarinki taramada tekrar bakilir.
    return { gonder: false, sebep: "henuz teslim edilmemis" };
  }
  if (teslim === null) {
    // Yurtici'ye ulasilamadi. yorum.js burada "yine de gonder" diyor cunku
    // orada risk sadece gereksiz bir yorum istegi. Burada ise kapidan donmus
    // birine "videonu cek, 1000 TL verelim" demek olur - GONDERMIYORUZ,
    // yarin tekrar deneriz.
    return { gonder: false, sebep: "teslim durumu dogrulanamadi, yarin tekrar" };
  }
  return { gonder: true, sebep: "teslim edilmis, teklif gonderilecek" };
}

// ============ TEST MODU ============
async function handleTest(req, res) {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  try {
    const siparisler = await pencereSiparisleri();
    let cikti = "=== VIDEO TEKLIFI (TEST MODU - HICBIR MESAJ GONDERILMEDI) ===\n";
    cikti += "Pencere     : siparis tarihi " + PENCERE_BAS_GUN + "-" + PENCERE_SON_GUN + " gun once\n";
    cikti += "Baslangic   : " + BASLANGIC_TARIHI.slice(0, 10) +
      " oncesi siparislere teklif GITMEZ (birikmis eski siparisler haric tutuldu)\n";
    cikti += "Parti limiti: tek calismada en fazla " + PARTI_LIMITI + " mesaj\n";
    cikti += "Sablon      : " + TEMPLATE + " (" + TEMPLATE_LANG + ")\n";
    cikti += "Sessiz saat : " + SESSIZ_BASLANGIC + ":00 - " + SESSIZ_BITIS + ":00. Su an TR " +
      turkiyeSaati() + ":00" + (sessizSaatteMiyiz() ? "  >>> SESSIZ <<<" : "") + "\n";
    cikti += "Penceredeki kargolanmis siparis: " + siparisler.length + "\n\n";

    if (!siparisler.length) {
      cikti += "Bu pencerede siparis yok.\n";
      return res.status(200).send(cikti);
    }

    let gonderilecek = 0;
    for (const o of siparisler) {
      const telefon = telefonCikar(o);
      const { gonder, sebep } = await karar(o);
      if (gonder) gonderilecek++;
      cikti += "-----------------------------------------\n";
      cikti += "Siparis : " + (o.name || "") + "  (" + String(o.created_at || "").slice(0, 10) + ")\n";
      cikti += "Musteri : " + adCikar(o) + "\n";
      cikti += "Telefon : " + (telefon || ">>> YOK <<<") + "\n";
      cikti += "KARAR   : " + (gonder ? "TEKLIF GIDERDI" : "GONDERILMEZ") + " - " + sebep + "\n";
    }
    cikti += "-----------------------------------------\n\n";
    cikti += "OZET: " + siparisler.length + " siparisin " + gonderilecek + " tanesine teklif gidecekti.\n";
    cikti += "(Tek calismada en fazla " + PARTI_LIMITI + " mesaj gonderilir.)\n";
    return res.status(200).send(cikti);
  } catch (e) {
    return res.status(200).send("HATA: " + (e && e.message ? e.message : e));
  }
}

async function handleDene(req, res) {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  const telefon = normalizeTelefon((req.query && req.query.telefon) || "");
  if (!telefon) {
    return res.status(200).send("telefon parametresi gerekli.\nOrnek: ?mod=dene&telefon=905551112233&secret=...");
  }
  const durum = await sablonGonder(telefon, "Test");
  return res.status(200).send(
    "DENEME GONDERIMI\n  telefon: " + telefon + "\n  durum  : " + durum + "\n\n" +
    "'durum' OK degilse sablon henuz onaylanmamis olabilir.\n"
  );
}

// ============ GERCEK CALISMA ============
module.exports = async (req, res) => {
  const secret = req.query && req.query.secret;
  if (secret !== SECRET) {
    console.error("VIDEO-TEKLIFI: gecersiz secret");
    return res.status(401).send("Unauthorized");
  }

  if (req.method === "GET") {
    const mod = (req.query && req.query.mod) || "test";
    if (mod === "dene") return handleDene(req, res);
    return handleTest(req, res);
  }

  if (req.method !== "POST") return res.status(200).send("OK");

  if (sessizSaatteMiyiz()) {
    const s = turkiyeSaati();
    console.log("VIDEO-TEKLIFI: sessiz saat (" + s + ":00), gonderim yok");
    return res.status(200).send("OK - sessiz saat (" + s + ":00)");
  }

  if (!process.env.SHOPIFY_STORE || !process.env.SHOPIFY_TOKEN) {
    console.error("VIDEO-TEKLIFI: SHOPIFY_STORE/SHOPIFY_TOKEN tanimli degil");
    return res.status(200).send("OK - shopify bilgisi yok");
  }

  try {
    const siparisler = await pencereSiparisleri();
    console.log("VIDEO-TEKLIFI: penceredeki siparis sayisi:", siparisler.length);

    let gonderilen = 0;
    const detaylar = [];

    for (const o of siparisler) {
      if (gonderilen >= PARTI_LIMITI) {
        console.log("VIDEO-TEKLIFI: parti limiti doldu, kalanlar yarin");
        break;
      }
      const { gonder, sebep } = await karar(o);
      if (!gonder) continue;

      const telefon = telefonCikar(o);
      const ad = adCikar(o);
      const siparisNo = siparisNoCikar(o);

      const durum = await sablonGonder(telefon, ad);
      // Bayrak gonderim basarisiz olsa da atiliyor: mukerrer teklif riskini
      // tekrar deneme kazancina tercih etmiyoruz.
      await bayrakAt(GONDERILDI + telefon, GONDERILDI_OMRU);
      console.log("VIDEO-TEKLIFI (" + siparisNo + " / " + telefon + "):", durum, "|", sebep);
      await sheetsYaz(siparisNo, telefon, ad, durum);
      gonderilen++;
      detaylar.push(siparisNo);

      await new Promise(function (r) { setTimeout(r, 300); });
    }

    const ozet = siparisler.length + " siparis bakildi, " + gonderilen + " teklif gonderildi" +
      (detaylar.length ? " - " + detaylar.join(", ") : "");
    console.log("VIDEO-TEKLIFI OZET:", ozet);
    return res.status(200).send("OK - " + ozet);
  } catch (error) {
    console.error("VIDEO-TEKLIFI HATA:", error && error.message ? error.message : error);
    return res.status(200).send("OK - hata: " + (error && error.message ? error.message : error));
  }
};
