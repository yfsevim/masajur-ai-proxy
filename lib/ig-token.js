// ===========================================================================
// lib/ig-token.js  -  INSTAGRAM TOKEN OKUYUCU
// ===========================================================================
// NEDEN VAR:
// Instagram'in uzun omurlu token'i TAM 60 GUN yasiyor. 2026-11-08'de bot
// tam da bu yuzden sustu: token 6 Eylul'de konmustu, 7 Kasim'da oldu,
// webhook'lar geliyordu ama hicbir cevap Instagram'a gonderilemiyordu
// (Vercel loglarinda 3 gunde 115 adet "Session has expired" hatasi).
//
// COZUM: token artik SADECE ortam degiskeninden okunmuyor. api/ig-token-
// yenile.js adli gunluk cron, token'i suresi dolmadan yeniliyor ve YENI
// token'i Redis'e yaziyor. Buradaki igTokenAl() once Redis'e bakiyor.
//
// ELLE MUDAHALE GUVENLIGI:
// Redis'teki kayitta "kaynak" alani var - o zincirin basladigi ortam
// degiskeni degeri. Eger sen Vercel'de INSTAGRAM_ACCESS_TOKEN'i ELLE
// degistirirsen kaynak artik tutmaz, bu durumda Redis'teki eski zincir
// COPE ATILIR ve senin yeni koydugun deger kullanilir. Yani elle token
// degistirmek her zaman kazanir, Redis asla onun onune gecemez.
// ===========================================================================

const { Redis } = require("@upstash/redis");
const redis = Redis.fromEnv();

const TOKEN_KEY = "ig-token";

// Her API cagrisinda Redis'e gitmemek icin kucuk bir bellek onbellegi.
// 60 saniye: yenileme sonrasi en fazla 1 dakika eski token kullanilir,
// token 60 GUN yasadigi icin bu zararsiz.
const ONBELLEK_MS = 60000;
let onbellek = null; // { token: "...", zaman: 1699... }

// Redis'teki kaydi dondurur (yoksa null). Hem bu dosya hem cron kullaniyor.
async function igTokenKaydiniOku() {
  try {
    const kayit = await redis.get(TOKEN_KEY);
    if (kayit && typeof kayit === "object" && kayit.token) return kayit;
    return null;
  } catch (e) {
    console.error("IG TOKEN: Redis okuma hatasi:", e && e.message ? e.message : e);
    return null;
  }
}

// Su an gecerli olan token'i dondurur.
// Sira: 1) Redis'teki yenilenmis token (zincir gecerliyse)
//       2) Ortam degiskeni INSTAGRAM_ACCESS_TOKEN
async function igTokenAl() {
  const envToken = process.env.INSTAGRAM_ACCESS_TOKEN || null;

  if (onbellek && Date.now() - onbellek.zaman < ONBELLEK_MS) {
    return onbellek.token;
  }

  const kayit = await igTokenKaydiniOku();
  if (kayit && kayit.kaynak === envToken) {
    onbellek = { token: kayit.token, zaman: Date.now() };
    return kayit.token;
  }

  // Redis bos VEYA ortam degiskeni elle degistirilmis -> ortam degiskeni
  onbellek = { token: envToken, zaman: Date.now() };
  return envToken;
}

module.exports = { igTokenAl, igTokenKaydiniOku, TOKEN_KEY };
