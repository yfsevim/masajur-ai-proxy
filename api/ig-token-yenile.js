// ===========================================================================
// api/ig-token-yenile.js  -  INSTAGRAM TOKEN'INI OTOMATIK YENILER
// ===========================================================================
// SORUN (2026-11-08'de yasandi):
// Instagram'in uzun omurlu token'i TAM 60 GUN yasiyor. 6 Eylul'de konan
// token 7 Kasim'da oldu, Instagram botu bir gun boyunca sustu. Webhook'lar
// geliyordu, bot cevabi uretiyordu ama Instagram'a gonderemiyordu.
//
// COZUM:
// Meta'nin resmi yenileme ucu (dokumandan birebir):
//   GET https://graph.instagram.com/refresh_access_token
//       ?grant_type=ig_refresh_token
//       &access_token=<LONG_LIVED_ACCESS_TOKEN>
// Kurallar (Meta dokumani, 17 Tem 2025):
//   - Token EN AZ 24 SAAT eski olmali,
//   - Token'in suresi HENUZ DOLMAMIS olmali (dolduysa yenilenemez, elle
//     Meta panelinden yeniden uretmek gerekir),
//   - Yenilenen token, yenilendigi gunden itibaren 60 GUN gecerli,
//   - Gerekli izin: instagram_business_basic (uygulamada zaten var).
// Cevap: { "access_token": "...", "token_type": "bearer", "expires_in": 5183944 }
//
// CALISMA MANTIGI:
//   - Gunluk cron calisir (vercel.json).
//   - Token'in kalan omru 45 GUNDEN azsa yeniler. Yani pratikte ~15 gunde
//     bir gercek yenileme olur; her yenileme sure sayacini 60 gune resetler.
//     Boylece sistem 45 gun ust uste coksa bile token olmez.
//   - Yeni token Redis'e yazilir, lib/ig-token.js oradan okur.
//   - YENILEME BASARISIZ OLURSA ve kalan omur 7 GUNDEN azsa (ya da omur
//     bilinmiyorsa) WhatsApp'tan UYARI gider - artik sessizce olmez.
//     Uyari gunde EN FAZLA 1 KEZ gider (Redis kilidi).
//
// ELLE CALISTIRMA / TEST:
//   /api/ig-token-yenile?secret=<API_SECRET>
//   /api/ig-token-yenile?secret=<API_SECRET>&zorla=1   (esige bakmadan yenile)
//   /api/ig-token-yenile?secret=<API_SECRET>&durum=1   (hicbir sey yapma,
//                                                       sadece durumu goster)
// ===========================================================================

const { Redis } = require("@upstash/redis");
const redis = Redis.fromEnv();

const TOKEN_KEY = "ig-token";
const UYARI_KILIT_KEY = "ig-token-uyari";
const HATA_SAYAC_KEY = "ig-token-hata-sayac";

const GUN_MS = 24 * 60 * 60 * 1000;
const YENILEME_ESIGI_GUN = 45; // kalan omur bunun altina duserse yenile
const UYARI_ESIGI_GUN = 7;     // yenileme basarisiz + kalan bu kadarsa uyar
const UYARI_HATA_SAYISI = 3;   // ust uste bu kadar gun basarisizsa uyar
// NOT: yeni konan token ILK 24 SAAT yenilenemez (Meta kurali). O yuzden
// kurulumdan sonraki ilk 1-2 cron denemesi basarisiz olabilir; bu normal
// ve UYARI GONDERMEZ. Uyari ancak ust uste 3 gun basarisizlikta ya da
// kalan omur 7 gunun altina dustugunde gider.

// Bildirim ayarlari - instagram-webhook.js ile AYNI numaralar/sablon
const ALERT_NUMBERS = ["905530681619", "905511485344"];
const ALERT_TEMPLATE = "temsilci_bildirim";
const ALERT_TEMPLATE_LANG = "tr";

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function uyariGonder(mesajMetni) {
  // Gunde en fazla 1 uyari - cron her gun calistigi icin spam olmasin
  try {
    const kilit = await redis.set(UYARI_KILIT_KEY, "1", { nx: true, ex: 86400 });
    if (kilit === null) {
      console.log("IG TOKEN: uyari bugun zaten gonderilmis, tekrar gonderilmiyor");
      return;
    }
  } catch (e) {
    console.error("IG TOKEN: uyari kilidi hatasi, yine de gonderiliyor:", e && e.message ? e.message : e);
  }

  for (const num of ALERT_NUMBERS) {
    try {
      const resp = await fetchWithTimeout(
        `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: num,
            type: "template",
            template: {
              name: ALERT_TEMPLATE,
              language: { code: ALERT_TEMPLATE_LANG },
              components: [
                {
                  type: "body",
                  parameters: [
                    { type: "text", text: "Instagram token" },
                    { type: "text", text: String(mesajMetni).slice(0, 250) }
                  ]
                }
              ]
            }
          })
        },
        6000
      );
      const data = await resp.json();
      console.log("IG TOKEN UYARI SONUCU (" + num + "):", JSON.stringify(data));
    } catch (e) {
      console.error("IG TOKEN UYARI HATA (" + num + "):", e && e.message ? e.message : e);
    }
  }
}

function yetkili(req) {
  const apiSecret = process.env.API_SECRET || null;
  const cronSecret = process.env.CRON_SECRET || null;
  if (!apiSecret && !cronSecret) return null; // hic ayar yok -> acik birakma

  const auth = req.headers && req.headers.authorization ? String(req.headers.authorization) : "";
  const bearer = auth.indexOf("Bearer ") === 0 ? auth.slice(7) : null;

  if (cronSecret && bearer && bearer === cronSecret) return true;
  if (apiSecret && bearer && bearer === apiSecret) return true;
  if (apiSecret && req.query && req.query.secret === apiSecret) return true;
  return false;
}

async function kaydiOku() {
  try {
    const kayit = await redis.get(TOKEN_KEY);
    if (kayit && typeof kayit === "object" && kayit.token) return kayit;
    return null;
  } catch (e) {
    console.error("IG TOKEN: Redis okuma hatasi:", e && e.message ? e.message : e);
    return null;
  }
}

module.exports = async (req, res) => {
  const izin = yetkili(req);
  if (izin === null) {
    console.error("IG TOKEN: API_SECRET/CRON_SECRET ayarlanmamis - islem yapilmadi");
    return res.status(500).json({ ok: false, hata: "secret_ayarlanmamis" });
  }
  if (!izin) {
    return res.status(401).json({ ok: false, hata: "yetkisiz" });
  }

  const envToken = process.env.INSTAGRAM_ACCESS_TOKEN || null;
  if (!envToken) {
    console.error("IG TOKEN: INSTAGRAM_ACCESS_TOKEN bos");
    return res.status(500).json({ ok: false, hata: "env_token_yok" });
  }

  const simdi = Date.now();
  const kayit = await kaydiOku();

  // Zincir gecerli mi? kaynak, zincirin BASLADIGI ortam degiskeni degeri.
  // Sen Vercel'de token'i elle degistirdiysen kaynak tutmaz -> zincir bastan
  // baslar, senin elle koydugun deger kullanilir.
  const zincirGecerli = !!(kayit && kayit.kaynak === envToken);
  const aktifToken = zincirGecerli ? kayit.token : envToken;
  const kalanMs = zincirGecerli && kayit.expiresAt ? kayit.expiresAt - simdi : null;
  const kalanGun = kalanMs === null ? null : Math.floor(kalanMs / GUN_MS);

  const durum = {
    zincirGecerli: zincirGecerli,
    kalanGun: kalanGun,
    sonYenileme: zincirGecerli && kayit.refreshedAt ? new Date(kayit.refreshedAt).toISOString() : null
  };

  if (req.query && req.query.durum === "1") {
    console.log("IG TOKEN DURUM:", JSON.stringify(durum));
    return res.status(200).json({ ok: true, durum: durum });
  }

  const zorla = !!(req.query && req.query.zorla === "1");

  if (!zorla && kalanGun !== null && kalanGun > YENILEME_ESIGI_GUN) {
    console.log("IG TOKEN: yenilemeye gerek yok, kalan gun:", kalanGun);
    return res.status(200).json({ ok: true, yenilendi: false, durum: durum });
  }

  // --- Yenileme ---
  let data = null;
  let hataMetni = null;
  try {
    const url =
      "https://graph.instagram.com/refresh_access_token" +
      "?grant_type=ig_refresh_token" +
      "&access_token=" + encodeURIComponent(aktifToken);
    const resp = await fetchWithTimeout(url, { method: "GET" }, 10000);
    data = await resp.json().catch(() => null);
    if (!data || !data.access_token) {
      hataMetni = data && data.error ? JSON.stringify(data.error) : "bilinmeyen cevap";
    }
  } catch (e) {
    hataMetni = e && e.message ? e.message : String(e);
  }

  if (hataMetni) {
    let hataSayisi = 1;
    try {
      hataSayisi = await redis.incr(HATA_SAYAC_KEY);
      await redis.expire(HATA_SAYAC_KEY, 15 * 24 * 60 * 60);
    } catch (e) {
      console.error("IG TOKEN: hata sayaci yazilamadi:", e && e.message ? e.message : e);
    }

    console.error(
      "IG TOKEN: YENILEME BASARISIZ -", hataMetni,
      "| kalan gun:", kalanGun, "| ust uste hata:", hataSayisi
    );

    const omurKritik = kalanGun !== null && kalanGun < UYARI_ESIGI_GUN;
    const sureklHata = hataSayisi >= UYARI_HATA_SAYISI;
    if (omurKritik || sureklHata) {
      const kalanYazi = kalanGun === null ? "bilinmiyor" : kalanGun + " gun";
      await uyariGonder(
        "Instagram token yenilenemedi (" + hataSayisi + ". kez). Kalan sure: " + kalanYazi +
        ". Meta panelinden yeni token uretip Vercel'de INSTAGRAM_ACCESS_TOKEN'i guncelle. Hata: " + hataMetni
      );
    }
    return res.status(200).json({
      ok: false, yenilendi: false, hata: hataMetni, hataSayisi: hataSayisi, durum: durum
    });
  }

  const omurSn = Number(data.expires_in) || 0;
  const yeniKayit = {
    token: data.access_token,
    kaynak: envToken,
    expiresAt: simdi + omurSn * 1000,
    refreshedAt: simdi
  };

  try {
    await redis.set(TOKEN_KEY, yeniKayit);
  } catch (e) {
    console.error("IG TOKEN: Redis yazma hatasi:", e && e.message ? e.message : e);
    await uyariGonder(
      "Instagram token yenilendi ama Redis'e yazilamadi. Bot eski token ile calismaya devam ediyor."
    );
    return res.status(200).json({ ok: false, yenilendi: false, hata: "redis_yazilamadi" });
  }

  // Basarili yenileme -> hata sayaci sifirlanir
  try {
    await redis.del(HATA_SAYAC_KEY);
  } catch (e) {
    console.error("IG TOKEN: hata sayaci silinemedi:", e && e.message ? e.message : e);
  }

  const yeniKalanGun = Math.floor(omurSn / 86400);
  console.log("IG TOKEN: YENILENDI - yeni omur:", yeniKalanGun, "gun");

  return res.status(200).json({
    ok: true,
    yenilendi: true,
    yeniKalanGun: yeniKalanGun,
    oncekiKalanGun: kalanGun
  });
};
