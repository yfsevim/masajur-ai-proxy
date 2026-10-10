// api/gelen-faturalar.js
// Mysoft'tan:
//   1) SIZE GELEN faturalari (e-fatura gelen kutusu + e-arsiv gelen kutusu)
//   2) SIZIN KESTIGINIZ (giden) faturalari - gun gun toplanmis halde
//   3) Gider pusulalarini - gun gun toplanmis halde
// ceker ve "Masajur Kar-Zarar" Google Sheets dosyasina yazar
// (Apps Script web uygulamasi uzerinden):
//   - "Alis Faturalari" sekmesi: her gelen fatura bir satir (ETTN ile tekrar yazilmaz)
//   - "Satis Faturalari" sekmesi: her gun bir satir (ayni gun tekrar gelirse guncellenir)
//
// Calisma sekli:
//   - Her sabah Vercel Cron otomatik cagirir (vercel.json -> crons), son 10 gunu tarar.
//   - Elle de cagrilabilir:
//       /api/gelen-faturalar?secret=...&gun=40
//       /api/gelen-faturalar?secret=...&baslangic=2026-09-01&bitis=2026-10-10
//       ...&yaz=0   -> Sheets'e YAZMAZ, sadece ne bulundugunu gosterir (test)
//       ...&ham=1   -> Mysoft'un ham cevabini gosterir (hata ayiklama)
//
// Vercel ortam degiskenleri:
//   MYSOFT_CLIENT_ID, MYSOFT_CLIENT_SECRET, MYSOFT_API_BASE_URL (fatura botuyla ayni)
//   KARZARAR_SHEETS_URL (Apps Script web uygulamasi linki)

const SECRET = "masajur_yakkoholding_2128";
const SHEETS_SECRET = "masajur_karzarar_2128";
const MYSOFT_API_BASE_URL = process.env.MYSOFT_API_BASE_URL || "https://edocumentapi.mysoft.com.tr";
const SAYFA_LIMIT = 100;
const MAKS_SAYFA = 60;
const GECERSIZ_DURUM = /iptal|red|hata|ba[sş]ar[iı]s[iı]z|cancel/i;

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
    if (hamKayit && sayfa === 0) hamKayit.push({ yol, govde, durum: resp.status, cevap: data });

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

// ---------- GELEN FATURALAR (her fatura ayri satir) ----------

function eFaturaSatiri(f) {
  return {
    ettn: f.ettn,
    tarih: f.docDate,
    no: f.docNo,
    tur: "e-Fatura",
    firma: f.accountName,
    vkn: f.vknTckn,
    matrah: sayi(f.taxExclusiveAmount),
    kdv20: sayi(f.vatTotalTra20),
    kdv10: sayi(f.vatTotalTra10),
    kdv1: sayi(f.vatTotalTra1),
    kdvDiger: sayi((Number(f.vatTotalTra8) || 0) + (Number(f.vatTotalTra18) || 0)),
    kdvToplam: sayi(f.taxTotalTra),
    toplam: sayi(f.payableAmount || f.taxInclusiveAmount),
    durum: f.invoiceStatusText || ""
  };
}

function eArsivSatiri(f) {
  return {
    ettn: f.invoiceETTN,
    tarih: f.docDate,
    no: f.docNo,
    tur: "e-Arşiv",
    firma: f.accountName,
    vkn: f.accountVknTckn,
    matrah: sayi(f.taxExclusiveAmtTra),
    kdv20: sayi(f.taxAmtTraRate20),
    kdv10: sayi(f.taxAmtTraRate10),
    kdv1: sayi(f.taxAmtTraRate1),
    kdvDiger: sayi((Number(f.taxAmtTraRate8) || 0) + (Number(f.taxAmtTraRate18) || 0)),
    kdvToplam: sayi(f.taxTotalTra),
    toplam: sayi(f.payableAmtTra || f.taxInclusiveAmtTra),
    durum: ""
  };
}

// ---------- GIDEN FATURALAR + GIDER PUSULASI (gun gun toplam) ----------

function gunlukTopla(gidenler, giderPusulalari, baslangic, bitis) {
  const gunler = {};
  function gun(tarih) {
    if (!gunler[tarih]) {
      gunler[tarih] = {
        tarih, adet: 0, iptalAdet: 0, matrah: 0, kdv20: 0, kdv10: 0, kdvDiger: 0,
        kdvToplam: 0, toplam: 0, gpAdet: 0, gpTutar: 0, gpVergi: 0
      };
    }
    return gunler[tarih];
  }

  // Aralıktaki her günü sıfırla başlat (o gün fatura yoksa da 0 yazılsın)
  const d0 = new Date(baslangic + "T12:00:00Z");
  const d1 = new Date(bitis + "T12:00:00Z");
  for (let d = d0; d <= d1; d = new Date(d.getTime() + 24 * 3600 * 1000)) {
    gun(d.toISOString().slice(0, 10));
  }

  const durumSayac = {};
  for (const f of gidenler) {
    const t = String(f.docDate || "").slice(0, 10);
    if (!t) continue;
    const g = gun(t);
    const durum = f.invoiceStatusText || "";
    durumSayac[durum] = (durumSayac[durum] || 0) + 1;
    if (GECERSIZ_DURUM.test(durum)) { g.iptalAdet++; continue; }
    g.adet++;
    g.matrah += Number(f.taxExclusiveAmount) || 0;
    g.kdv20 += Number(f.vatTotalTra20) || 0;
    g.kdv10 += Number(f.vatTotalTra10) || 0;
    g.kdvDiger += (Number(f.vatTotalTra1) || 0) + (Number(f.vatTotalTra8) || 0) + (Number(f.vatTotalTra18) || 0);
    g.kdvToplam += Number(f.taxTotalTra) || 0;
    g.toplam += Number(f.payableAmount || f.taxInclusiveAmount) || 0;
  }

  for (const p of giderPusulalari) {
    const t = String(p.docDate || "").slice(0, 10);
    if (!t) continue;
    if (GECERSIZ_DURUM.test(p.portalExpenseVoucherStatusText || "")) continue;
    const g = gun(t);
    g.gpAdet++;
    g.gpTutar += Number(p.payableAmtTra || p.taxInclusiveAmtTra) || 0;
    g.gpVergi += Number(p.taxTotalTra) || 0;
  }

  const liste = Object.values(gunler)
    .filter(g => g.tarih >= baslangic && g.tarih <= bitis)
    .sort((a, b) => a.tarih.localeCompare(b.tarih))
    .map(g => {
      for (const k of ["matrah", "kdv20", "kdv10", "kdvDiger", "kdvToplam", "toplam", "gpTutar", "gpVergi"]) g[k] = sayi(g[k]);
      return g;
    });
  return { liste, durumSayac };
}

async function sheetsYaz(faturalar, gidenGunluk) {
  const url = process.env.KARZARAR_SHEETS_URL;
  if (!url) throw new Error("KARZARAR_SHEETS_URL tanimli degil");
  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: SHEETS_SECRET, faturalar, gidenGunluk }),
    redirect: "follow"
  }, 60000);
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

    const hataYakala = (ad) => (e) => {
      console.error("GELEN-FATURALAR " + ad + " hatasi:", e.message);
      return { hata: e.message };
    };

    const [eFat, eArs, giden, gp] = await Promise.all([
      listeCek(token, "/api/InvoiceInbox/getInvoiceInboxWithHeaderInfoListForPeriod", ortak, ham),
      listeCek(token, "/api/EArchiveDocumentInbox/getEArchiveDocumentInboxList", ortak, ham).catch(hataYakala("e-arsiv gelen")),
      listeCek(token, "/api/InvoiceOutbox/getInvoiceOutboxWithHeaderInfoList", ortak, ham).catch(hataYakala("giden")),
      listeCek(token, "/api/ExpenseVoucher/getExpenseVoucherOutboxWithHeaderInfoList", ortak, ham).catch(hataYakala("gider pusulasi"))
    ]);

    const faturalar = [
      ...eFat.map(eFaturaSatiri),
      ...(Array.isArray(eArs) ? eArs.map(eArsivSatiri) : [])
    ].filter(f => f.ettn);

    // Giden faturalar alinamadiysa gunluk toplam YAZILMAZ (yanlislikla 0 yazmamak icin)
    let gidenGunluk = null;
    let durumSayac = null;
    if (Array.isArray(giden)) {
      const sonuc = gunlukTopla(giden, Array.isArray(gp) ? gp : [], baslangic, bitis);
      gidenGunluk = sonuc.liste;
      durumSayac = sonuc.durumSayac;
    }

    let sheets = null;
    if (yaz && (faturalar.length || gidenGunluk)) {
      sheets = await sheetsYaz(faturalar, gidenGunluk);
    }

    const ozet = {
      ok: true,
      aralik: baslangic + " / " + bitis,
      gelen: {
        eFaturaAdet: eFat.length,
        eArsivAdet: Array.isArray(eArs) ? eArs.length : 0,
        eArsivHata: Array.isArray(eArs) ? null : eArs.hata,
        toplamKdv: sayi(faturalar.reduce((t, f) => t + f.kdvToplam, 0))
      },
      giden: {
        adet: Array.isArray(giden) ? giden.length : 0,
        hata: Array.isArray(giden) ? null : giden.hata,
        durumlar: durumSayac,
        toplamKdv: gidenGunluk ? sayi(gidenGunluk.reduce((t, g) => t + g.kdvToplam, 0)) : null
      },
      giderPusulasi: {
        adet: Array.isArray(gp) ? gp.length : 0,
        hata: Array.isArray(gp) ? null : gp.hata
      },
      sheets: yaz ? sheets : "yazilmadi (yaz=0)",
      ornekGelen: faturalar.slice(0, 3),
      ornekGunluk: gidenGunluk ? gidenGunluk.slice(-3) : null
    };
    if (ham) ozet.ham = ham;
    console.log("GELEN-FATURALAR:", JSON.stringify({ aralik: ozet.aralik, gelen: ozet.gelen, giden: ozet.giden, sheets }));
    return res.status(200).json(ozet);
  } catch (e) {
    console.error("GELEN-FATURALAR HATA:", e && e.message ? e.message : e);
    const cevap = { ok: false, hata: e && e.message ? e.message : String(e), aralik: baslangic + " / " + bitis };
    if (ham) cevap.ham = ham;
    return res.status(500).json(cevap);
  }
};
