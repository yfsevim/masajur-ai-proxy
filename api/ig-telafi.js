// ===========================================================================
// api/ig-telafi.js  -  CEVAPSIZ KALAN INSTAGRAM YORUMLARINI BULUR
// ===========================================================================
// NEDEN VAR:
// 7-8 Kasim 2026'da Instagram token'inin suresi doldu ve bot bir gun boyunca
// hicbir yoruma/DM'e cevap gonderemedi. Webhook olaylari TEKRAR GELMEZ, yani
// o donem kendiliginden telafi edilmez. Bu uc, Instagram'dan son gonderilerin
// yorumlarini cekip CEVAPSIZ olanlari buluyor.
//
// BU DOSYA HICBIR SEY GONDERMEZ VE HICBIR SEY SILMEZ.
// Sadece okur ve listeler. Telafiyi gercekten uygulamak ayri bir adim.
//
// KULLANIM:
//   /api/ig-telafi?secret=<API_SECRET>
//   /api/ig-telafi?secret=<API_SECRET>&baslangic=2026-11-07T15:00:00Z
//   /api/ig-telafi?secret=<API_SECRET>&gonderi=40     (kac gonderi taransin)
//
// baslangic verilmezse varsayilan: token'in oldugu an (7 Kasim 2026 15:20 UTC).
//
// CIKTI: JSON. "cevapsiz" dizisi telafi edilmesi gerekenleri, "cevaplanmis"
// sayisi ise o donemde zaten cevaplanmislari gosterir.
// ===========================================================================

const { igTokenAl } = require("../lib/ig-token");

const IG_KULLANICI_ADI = "masajurcom";
const VARSAYILAN_BASLANGIC = "2026-11-07T15:20:00Z"; // token'in oldugu an (UTC)
const API = "https://graph.instagram.com/v23.0";

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function jsonGetir(url) {
  const resp = await fetchWithTimeout(url, 12000);
  const data = await resp.json().catch(() => null);
  if (!data) return { hata: "cevap okunamadi" };
  if (data.error) return { hata: JSON.stringify(data.error) };
  return { data: data };
}

module.exports = async (req, res) => {
  const apiSecret = process.env.API_SECRET || null;
  if (!apiSecret) {
    return res.status(500).json({ ok: false, hata: "API_SECRET ayarlanmamis" });
  }
  if (!req.query || req.query.secret !== apiSecret) {
    return res.status(401).json({ ok: false, hata: "yetkisiz" });
  }

  const token = await igTokenAl();
  if (!token) {
    return res.status(500).json({ ok: false, hata: "token yok" });
  }

  const baslangicMetni = (req.query.baslangic || VARSAYILAN_BASLANGIC);
  const baslangic = Date.parse(baslangicMetni);
  if (isNaN(baslangic)) {
    return res.status(400).json({ ok: false, hata: "baslangic tarihi okunamadi" });
  }
  const gonderiSayisi = Math.min(Number(req.query.gonderi) || 25, 50);

  // 1) Son gonderiler
  const medyaSonuc = await jsonGetir(
    `${API}/me/media?fields=id,timestamp,permalink&limit=${gonderiSayisi}&access_token=${encodeURIComponent(token)}`
  );
  if (medyaSonuc.hata) {
    console.error("IG TELAFI: gonderiler cekilemedi:", medyaSonuc.hata);
    return res.status(200).json({ ok: false, hata: medyaSonuc.hata });
  }
  const medyalar = Array.isArray(medyaSonuc.data.data) ? medyaSonuc.data.data : [];

  // 2) Her gonderinin yorumlari
  const cevapsiz = [];
  let cevaplanmisSayisi = 0;
  let tarananYorum = 0;
  const gonderiHatalari = [];

  for (const medya of medyalar) {
    // "from" alani bazi kurulumlarda gelmiyor; gelmezse onsuz tekrar deniyoruz.
    let yorumSonuc = await jsonGetir(
      `${API}/${medya.id}/comments?fields=id,text,timestamp,username,from,replies{id,username}&limit=50&access_token=${encodeURIComponent(token)}`
    );
    if (yorumSonuc.hata) {
      yorumSonuc = await jsonGetir(
        `${API}/${medya.id}/comments?fields=id,text,timestamp,username,replies{id,username}&limit=50&access_token=${encodeURIComponent(token)}`
      );
    }
    if (yorumSonuc.hata) {
      gonderiHatalari.push({ gonderi: medya.id, hata: yorumSonuc.hata });
      continue;
    }

    const yorumlar = Array.isArray(yorumSonuc.data.data) ? yorumSonuc.data.data : [];
    for (const y of yorumlar) {
      const zaman = Date.parse(y.timestamp || "");
      if (isNaN(zaman) || zaman < baslangic) continue;      // donem disi
      if (y.username === IG_KULLANICI_ADI) continue;         // kendi yorumumuz
      tarananYorum++;

      const yanitlar = y.replies && Array.isArray(y.replies.data) ? y.replies.data : [];
      const bizCevapladik = yanitlar.some(function (r) {
        return r && r.username === IG_KULLANICI_ADI;
      });

      if (bizCevapladik) { cevaplanmisSayisi++; continue; }

      cevapsiz.push({
        yorumId: y.id,
        kullanici: y.username || null,
        kullaniciId: y.from && y.from.id ? y.from.id : null,
        metin: y.text || "",
        zaman: y.timestamp || null,
        gonderi: medya.permalink || medya.id
      });
    }
  }

  cevapsiz.sort(function (a, b) { return String(a.zaman).localeCompare(String(b.zaman)); });

  console.log(
    "IG TELAFI LISTE:", "taranan gonderi:", medyalar.length,
    "| donemdeki yorum:", tarananYorum,
    "| cevaplanmis:", cevaplanmisSayisi,
    "| CEVAPSIZ:", cevapsiz.length
  );

  return res.status(200).json({
    ok: true,
    not: "Bu uc hicbir sey gondermez ve silmez, sadece listeler.",
    baslangic: new Date(baslangic).toISOString(),
    taranan: {
      gonderi: medyalar.length,
      donemdekiYorum: tarananYorum,
      cevaplanmis: cevaplanmisSayisi,
      cevapsiz: cevapsiz.length,
      kullaniciIdVar: cevapsiz.filter(function (c) { return !!c.kullaniciId; }).length
    },
    gonderiHatalari: gonderiHatalari,
    cevapsiz: cevapsiz
  });
};
