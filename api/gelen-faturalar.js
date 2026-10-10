// api/gelen-faturalar.js
// Mysoft'tan SIZE GELEN faturalari (e-fatura gelen kutusu + e-arsiv gelen
// kutusu) ceker ve "Masajur Kar-Zarar" Google Sheets dosyasinin
// "Alis Faturalari" sekmesine yazar (Apps Script web uygulamasi uzerinden).
//
// Calisma sekli:
//   - Her sabah Vercel Cron otomatik cagirir (vercel.json -> crons), son 10 gunu tarar.
//   - Elle de cagrilabilir:
//       /api/gelen-faturalar?secret=...&gun=40              -> son 40 gun
//       /api/gelen-faturalar?secret=...&baslangic=2026-09-01&bitis=2026-10-10
//       ...&yaz=0   -> Sheets'e YAZMAZ, sadece ne bulundugunu gosterir (test)
//       ...&ham=1   -> Mysoft'un ham cevabini gosterir (hata ayiklama)
//   - Ayni fatura (ETTN) Sheets'te zaten varsa tekrar yazilmaz.
//
// Gerekli Vercel ortam degiskenleri:
//   MYSOFT_CLIENT_ID, MYSOFT_CLIENT_SECRET  (fatura botuyla ayni - zaten var)
//   MYSOFT_API_BASE_URL                     (zaten var)
//   KARZARAR_SHEETS_URL                     (YENI - Apps Script web uygulamasi linki)

const SECRET = "masajur_yakkoholding_2128";
const SHEETS_SECRET = "masajur_karzarar_2128";
const MYSOFT_API_BASE_URL = process.env.MYSOFT_API_BASE_URL || "https://edocumentapi.mysoft.com.tr";
const SAYFA_LIMIT = 100;
const MAKS_SAYFA = 50;

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getMysoftAccessToken() {
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
  }, 15000);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    throw new Error("Mysoft token alinamadi: " + JSON.stringify(data));
  }
  return data.access_token;
}

// Istanbul saatine gore YYYY-MM-DD
function tarihStr(d) {
  const ist = new Date(d.getTime() + 3 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

function sayi(x) {
  const n = Number(x);
  return isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

// Sayfali liste cekme: afterValue ile ilerler
async function listeCek(token, yol, govdeTaban, hamKayit) {
  const tum = [];
  let afterValue = 0;
  for (let sayfa = 0; sayfa < MAKS_SAYFA; sayfa++) {
    const govde = { ...govdeTaban, limit: SAYFA_LIMIT, afterValue };
    const resp = await fetchWithTimeout(MYSOFT_API_BASE_URL + yol, {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(govde)
    }, 30000);
    const metin = await resp.text();
    let data = {};
    try { data = JSON.parse(metin); } catch (e) { data = { hamMetin: metin.slice(0, 500) }; }
    if (hamKayit) hamKayit.push({ yol, govde, durum: resp.status, cevap: data });

    if (!resp.ok || data.succeed === false) {
      throw new Error(yol + " hata (" + resp.status + "): " + (data.message || data.errorCode || metin.slice(0, 300)));
    }
    const liste = Array.isArray(data.data) ? data.data : [];
    tum.push(...liste);

    const sonraki = Number(data.afterValue);
    if (liste.length < SAYFA_LIMIT || !sonraki || sonraki === afterValue) break;
    afterValue = sonraki;
  }
  return tum;
}

function eFaturaSatiri(f) {
  const kdv20 = sayi(f.vatTotalTra20);
  const kdv10 = sayi(f.vatTotalTra10);
  const kdv1 = sayi(f.vatTotalTra1);
  const kdvDiger = sayi((Number(f.vatTotalTra8) || 0) + (Number(f.vatTotalTra18) || 0));
  return {
    ettn: f.ettn,
    tarih: f.docDate,
    no: f.docNo,
    tur: "e-Fatura",
    firma: f.accountName,
    vkn: f.vknTckn,
    matrah: sayi(f.taxExclusiveAmount),
    kdv20, kdv10, kdv1, kdvDiger,
    kdvToplam: sayi(f.taxTotalTra),
    toplam: sayi(f.payableAmount || f.taxInclusiveAmount),
    durum: f.invoiceStatusText || ""
  };
}

function eArsivSatiri(f) {
  const kdv20 = sayi(f.taxAmtTraRate20);
  const kdv10 = sayi(f.taxAmtTraRate10);
  const kdv1 = sayi(f.taxAmtTraRate1);
  const kdvDiger = sayi((Number(f.taxAmtTraRate8) || 0) + (Number(f.taxAmtTraRate18) || 0));
  return {
    ettn: f.invoiceETTN,
    tarih: f.docDate,
    no: f.docNo,
    tur: "e-Arşiv",
    firma: f.accountName,
    vkn: f.accountVknTckn,
    matrah: sayi(f.taxExclusiveAmtTra),
    kdv20, kdv10, kdv1, kdvDiger,
    kdvToplam: sayi(f.taxTotalTra),
    toplam: sayi(f.payableAmtTra || f.taxInclusiveAmtTra),
    durum: ""
  };
}

async function sheetsYaz(faturalar) {
  const url = process.env.KARZARAR_SHEETS_URL;
  if (!url) throw new Error("KARZARAR_SHEETS_URL tanimli degil");
  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: SHEETS_SECRET, faturalar }),
    redirect: "follow"
  }, 30000);
  const metin = await resp.text();
  try { return JSON.parse(metin); } catch (e) { return { ok: false, ham: metin.slice(0, 300) }; }
}

module.exports = async (req, res) => {
  const q = req.query || {};
  if (q.secret !== SECRET) {
    return res.status(401).send("Unauthorized");
  }

  const ham = q.ham === "1" ? [] : null;
  const yaz = q.yaz !== "0";

  let baslangic = q.baslangic;
  let bitis = q.bitis;
  if (!baslangic || !bitis) {
    const gun = Math.min(Math.max(parseInt(q.gun || "10", 10) || 10, 1), 400);
    const simdi = new Date();
    bitis = tarihStr(simdi);
    baslangic = tarihStr(new Date(simdi.getTime() - gun * 24 * 60 * 60 * 1000));
  }

  try {
    const token = await getMysoftAccessToken();
    const ortak = { startDate: baslangic, endDate: bitis, isUseDocDate: true };

    const [eFat, eArs] = await Promise.all([
      listeCek(token, "/api/InvoiceInbox/getInvoiceInboxWithHeaderInfoListForPeriod", ortak, ham),
      listeCek(token, "/api/EArchiveDocumentInbox/getEArchiveDocumentInboxList", ortak, ham)
        .catch(e => { console.error("GELEN-FATURALAR e-arsiv hatasi:", e.message); return { hata: e.message }; })
    ]);

    const faturalar = [
      ...eFat.map(eFaturaSatiri),
      ...(Array.isArray(eArs) ? eArs.map(eArsivSatiri) : [])
    ].filter(f => f.ettn);

    let sheets = null;
    if (yaz && faturalar.length) {
      sheets = await sheetsYaz(faturalar);
    }

    const ozet = {
      ok: true,
      aralik: baslangic + " / " + bitis,
      eFaturaAdet: eFat.length,
      eArsivAdet: Array.isArray(eArs) ? eArs.length : 0,
      eArsivHata: Array.isArray(eArs) ? null : eArs.hata,
      toplamKdv: sayi(faturalar.reduce((t, f) => t + f.kdvToplam, 0)),
      sheets: yaz ? sheets : "yazilmadi (yaz=0)",
      ornek: faturalar.slice(0, 5)
    };
    if (ham) ozet.ham = ham;
    console.log("GELEN-FATURALAR:", JSON.stringify({ aralik: ozet.aralik, eFat: ozet.eFaturaAdet, eArs: ozet.eArsivAdet, sheets }));
    return res.status(200).json(ozet);
  } catch (e) {
    console.error("GELEN-FATURALAR HATA:", e && e.message ? e.message : e);
    const cevap = { ok: false, hata: e && e.message ? e.message : String(e), aralik: baslangic + " / " + bitis };
    if (ham) cevap.ham = ham;
    return res.status(500).json(cevap);
  }
};
