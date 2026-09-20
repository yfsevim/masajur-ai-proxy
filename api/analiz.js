// api/analiz.js
// GUNLUK BOT ANALIZI
//
// Her sabah bir kez calisir, DUNKU musteri konusmalarini okur ve iki soruyu
// cevaplar:
//   1) Bot yanlis/eksik/kotu cevap verdi mi?   -> "Sorunlu Cevaplar" sekmesi
//   2) Musteriler en cok neyi soruyor?          -> "Gunluk Analiz" sekmesi
//
// Bu dosya HICBIR SEYE MUDAHALE ETMIYOR. Sadece okuyor, degerlendiriyor ve
// rapor yaziyor. Bot, fatura, kargo, sepet kurtarma - hicbiri etkilenmiyor.
// Patlasa bile tek kaybimiz o gunun raporu olur.
//
// VERI AKISI:
//   Sheets "Musteri Konusmalari" --(okuma)--> bu dosya --(Claude)--> degerlendirme
//   --> Sheets "Gunluk Analiz" + "Sorunlu Cevaplar"
//
// SHEETS OKUMA: Apps Script'e type:"konusma_oku" dali eklendi. O dal, verilen
// tarihteki satirlari JSON olarak geri donduruyor. Ayri bir Google API anahtari
// veya servis hesabina GEREK YOK - zaten calisan web app URL'i kullaniliyor.
//
// TEST MODU: GET ?mod=test&secret=...[&tarih=19.09.2026]
//   Hicbir yere kayit YAZMAZ, sonucu duz metin olarak ekrana basar.
//   tarih verilmezse dunu analiz eder.
//
// GERCEK CALISMA: POST ?secret=...   (QStash Schedule ile gunde bir kez)
//
// MUKERRER KORUMASI: ayni tarih icin ikinci kez calisirsa Redis bayragi
// (analiz-yapildi:<tarih>) gorulur ve ikinci rapor YAZILMAZ. QStash bir
// firing'i iki kez gonderse bile Sheets'e cift satir dusmez.

const { Redis } = require("@upstash/redis");
const redis = Redis.fromEnv();

// Botun kendi talimatinin kopyasi. Bot bu dosyayi kullanmiyor; analiz
// "bot kendi kurallarina uymus mu" diyebilsin diye burada duruyor.
// chat.js'teki prompt degisince BU DOSYA DA guncellenmeli (dosyanin
// basindaki uyariya bak).
const BOT_PROMPT = require("../lib/bot-prompt-kopya");

const SECRET = "masajur_yakkoholding_2128";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 4000;

// Bir gunde beklenen satir sayisi ~30-60. Bu tavan, beklenmedik bir durumda
// (ornegin Sheets yanlis tarih donerse) devasa bir istek atip para yakmayi
// engelliyor. Tavan asilirsa en yeni MAX_SATIR kadari analiz edilir.
const MAX_SATIR = 400;

const BAYRAK = "analiz-yapildi:";
const BAYRAK_OMRU = 90 * 24 * 3600;

// Turkiye 2016'dan beri yil boyu UTC+3, yaz saati uygulamasi yok.
// Bu yuzden sabit ofset guvenli.
const TR_OFSET_MS = 3 * 3600 * 1000;

function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, Object.assign({}, options, { signal: controller.signal }))
    .finally(() => clearTimeout(timer));
}

// Istanbul saatine gore "gg.aa.yyyy". gunOnce=1 -> dun.
function trTarih(gunOnce) {
  const t = new Date(Date.now() + TR_OFSET_MS - (gunOnce || 0) * 24 * 3600 * 1000);
  const g = String(t.getUTCDate()).padStart(2, "0");
  const a = String(t.getUTCMonth() + 1).padStart(2, "0");
  return g + "." + a + "." + t.getUTCFullYear();
}

function tarihGecerliMi(s) {
  return /^\d{2}\.\d{2}\.\d{4}$/.test(String(s || ""));
}

// Sheets'in son cevabindaki tani bilgisi (test modunda gosteriliyor).
// "Hic satir gelmedi" durumunda sebebini gormek icin: hangi sekme okundu,
// kac satir var, tarih sutununda gercekte ne yaziyor.
let sonTani = null;

// --- Sheets'ten o gunun konusmalarini oku ---
async function konusmalariOku(tarih) {
  if (!process.env.SHEETS_URL) throw new Error("SHEETS_URL tanimli degil");
  const r = await fetchWithTimeout(process.env.SHEETS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "konusma_oku", tarih: tarih })
  }, 30000);

  const metin = await r.text().catch(() => "");
  let veri;
  try {
    veri = JSON.parse(metin);
  } catch (e) {
    // Apps Script'te "konusma_oku" dali yoksa duz metin ("OK" gibi) doner.
    throw new Error("Sheets okuma cevabi JSON degil - Apps Script'e konusma_oku dali eklendi mi? Gelen: " + metin.slice(0, 200));
  }
  if (!veri || veri.ok !== true) {
    throw new Error("Sheets okuma basarisiz: " + metin.slice(0, 200));
  }
  // ESKI SURUM TUZAGI: Apps Script kaydedilmis ama YENI SURUM olarak
  // dagitilmamissa, "konusma_oku" bilinmeyen bir tip sayilip en alttaki
  // genel else'e duser: bize yine {"ok":true} doner ama "satirlar" YOKTUR
  // (ve o istek Musteri Konusmalari sekmesine bir cop satir yazar).
  // Bunu "o gun hic konusma olmamis" ile karistirmamak icin ayirt ediyoruz:
  // satirlar alani YOKSA hata, BOS DIZI ise gercekten konusma yok demektir.
  if (!Array.isArray(veri.satirlar)) {
    throw new Error(
      "Sheets cevabinda 'satirlar' alani yok - Apps Script'teki konusma_oku dali CALISMADI. " +
      "Script kaydedilmis ama muhtemelen yeni surum olarak dagitilmamis " +
      "(Dagit -> Dagitimlari yonet -> kalem -> Surum: Yeni surum -> Dagit). " +
      "NOT: bu istek 'Musteri Konusmalari' sekmesine bos bir cop satir yazmis olabilir, silebilirsin. " +
      "Gelen cevap: " + metin.slice(0, 150)
    );
  }
  sonTani = veri.tani || null;
  return veri.satirlar;
}

// --- Satirlari telefona gore konusmalara grupla ---
// Doner: { metin, konusmaSayisi, musteriSayisi, kesildi }
function konusmalariDuzenle(satirlar) {
  const temiz = satirlar.filter(function (s) {
    return s && (s.musteri || s.bot);
  });

  let kesildi = false;
  let kullanilan = temiz;
  if (temiz.length > MAX_SATIR) {
    kullanilan = temiz.slice(-MAX_SATIR);   // en yenileri tut
    kesildi = true;
  }

  const gruplar = new Map();
  for (const s of kullanilan) {
    const tel = String(s.telefon || "bilinmiyor");
    if (!gruplar.has(tel)) gruplar.set(tel, []);
    gruplar.get(tel).push(s);
  }

  const parcalar = [];
  let sira = 0;
  for (const [tel, satirlarGrubu] of gruplar) {
    sira++;
    let blok = "--- KONUSMA " + sira + " (telefon: " + tel + ") ---\n";
    for (const s of satirlarGrubu) {
      const saat = String(s.saat || "").trim();
      const m = String(s.musteri || "").replace(/\s+/g, " ").trim();
      const b = String(s.bot || "").replace(/\s+/g, " ").trim();
      if (m) blok += "[" + saat + "] MUSTERI: " + m + "\n";
      if (b) blok += "[" + saat + "] BOT: " + b + "\n";
    }
    parcalar.push(blok);
  }

  return {
    metin: parcalar.join("\n"),
    konusmaSayisi: kullanilan.length,
    musteriSayisi: gruplar.size,
    kesildi: kesildi
  };
}

// --- Claude'dan JSON sok: kod blogu/aciklama varsa temizle ---
function jsonCikar(metin) {
  let s = String(metin || "").trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const bas = s.indexOf("{");
  const son = s.lastIndexOf("}");
  if (bas === -1 || son === -1 || son <= bas) {
    throw new Error("Cevapta JSON bulunamadi: " + s.slice(0, 200));
  }
  return JSON.parse(s.slice(bas, son + 1));
}

const ANALIZ_TALIMATI = `Sen Masajur'un WhatsApp satis botunu denetleyen bir kalite kontrol uzmanisin.

Asagida once BOTUN KENDI TALIMATI, sonra o gunun MUSTERI KONUSMALARI veriliyor.
Botun verdigi cevaplari hem kendi talimatina hem de sagduyuya gore degerlendir.

Iki is yapacaksin:

1) SORUNLU CEVAPLARI bul. Sorun turleri:
   - "Yanlis bilgi"   : talimattaki bilgiye aykiri veya uydurma bir sey soylemis
   - "Cevapsiz"       : musterinin sordugu seyi cevaplamamis, konuyu kacirmis
   - "Tekrar"         : ayni cevabi ust uste vermis, kendini gereksiz tekrarlamis
   - "Kotu yonetim"   : musteri kizgin/memnuniyetsizken durumu iyi yonetememis
   - "Kacan satis"    : musteri almaya yakindi, bot kapatamadi veya gereksiz yere telefona yonlendirdi
   - "Devredilmeliydi": iade/ariza/sikayet gibi insana gitmesi gereken konuyu bot kendi cozmeye calismis

2) GUNUN OZETINI cikar: musteriler en cok neyi soruyor, kac kizgin musteri vardi,
   kac satis firsati kacti, ve tek cumlelik bir oneri.

KURALLAR:
- Sadece GERCEK sorunlari yaz. Cevap iyiyse yazma. Bir gunde hic sorun bulmaman da normaldir.
- Emin degilsen YAZMA. Az ve dogru, cok ve supheliden iyidir.
- Musteri mesaji ve bot cevabi alanlarina konusmadan KISALTILMIS alinti yaz (en fazla 150 karakter).
- "olmasiGereken" alanina botun ne demesi gerektigini KISA ve SOMUT yaz. Genel tavsiye degil, kullanilabilir cumle.
- "oneri" alanina, botun talimatinda neyin duzeltilmesi gerektigini tek cumleyle yaz.
- "enCokSorulanlar" listesini en cok sorulandan aza dogru sirala, en fazla 6 madde.
- Tum metinler TURKCE olsun.

SADECE asagidaki yapida gecerli JSON dondur. Baska hicbir sey yazma, kod blogu kullanma:
{
  "enCokSorulanlar": [{"konu": "kargo nerede", "adet": 8}],
  "kizginMusteri": 0,
  "kacanSatis": 0,
  "oneri": "tek cumle",
  "sorunlar": [
    {
      "saat": "17:35",
      "telefon": "905xxxxxxxxx",
      "musteriMesaji": "kisa alinti",
      "botCevabi": "kisa alinti",
      "tur": "Tekrar",
      "aciklama": "sorunun ne oldugu, tek cumle",
      "olmasiGereken": "botun ne demesi gerektigi"
    }
  ]
}`;

// --- Claude ile degerlendir ---
async function analizEt(konusmaMetni) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY tanimli degil");

  const icerik =
    "=== BOTUN KENDI TALIMATI (BASLANGIC) ===\n" +
    BOT_PROMPT +
    "\n=== BOTUN KENDI TALIMATI (BITIS) ===\n\n" +
    "=== O GUNUN KONUSMALARI (BASLANGIC) ===\n" +
    konusmaMetni +
    "\n=== O GUNUN KONUSMALARI (BITIS) ===";

  const r = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: ANALIZ_TALIMATI,
      messages: [{ role: "user", content: icerik }]
    })
  }, 120000);

  if (!r.ok) {
    const govde = await r.text().catch(() => "");
    throw new Error("Anthropic HTTP " + r.status + " - " + govde.slice(0, 300));
  }

  const veri = await r.json();
  const metin = veri && veri.content && veri.content[0] && veri.content[0].text;
  if (!metin) throw new Error("Anthropic cevabinda metin yok");

  const sonuc = jsonCikar(metin);
  const kullanim = veri.usage || {};

  return {
    enCokSorulanlar: Array.isArray(sonuc.enCokSorulanlar) ? sonuc.enCokSorulanlar : [],
    kizginMusteri: Number(sonuc.kizginMusteri) || 0,
    kacanSatis: Number(sonuc.kacanSatis) || 0,
    oneri: String(sonuc.oneri || ""),
    sorunlar: Array.isArray(sonuc.sorunlar) ? sonuc.sorunlar : [],
    girisToken: kullanim.input_tokens || 0,
    cikisToken: kullanim.output_tokens || 0
  };
}

function konularMetni(liste) {
  return liste
    .map(function (k) { return String(k.konu || "") + " (" + (Number(k.adet) || 0) + ")"; })
    .join(", ");
}

// --- Sonucu Sheets'e yaz (TEK istek, iki sekmeye birden) ---
// TEKRAR DENEME YOK (#12558 dersi): Apps Script cevabi bize ulasmasa bile
// satiri cogu zaman ZATEN yazmis oluyor; tekrar denemek mukerrer satir demek.
async function sheetseYaz(tarih, duzen, sonuc) {
  try {
    if (!process.env.SHEETS_URL) return "SHEETS_URL yok";
    const r = await fetchWithTimeout(process.env.SHEETS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "analiz_kaydet",
        tarih: tarih,
        ozet: {
          konusma: duzen.konusmaSayisi,
          musteri: duzen.musteriSayisi,
          konular: konularMetni(sonuc.enCokSorulanlar),
          sorunlu: sonuc.sorunlar.length,
          kizgin: sonuc.kizginMusteri,
          kacanSatis: sonuc.kacanSatis,
          oneri: sonuc.oneri
        },
        sorunlar: sonuc.sorunlar.map(function (s) {
          return {
            saat: String(s.saat || ""),
            telefon: String(s.telefon || ""),
            musteriMesaji: String(s.musteriMesaji || ""),
            botCevabi: String(s.botCevabi || ""),
            tur: String(s.tur || ""),
            aciklama: String(s.aciklama || ""),
            olmasiGereken: String(s.olmasiGereken || "")
          };
        })
      })
    }, 30000);
    const metin = await r.text().catch(function () { return ""; });
    return String(metin).slice(0, 200);
  } catch (e) {
    console.error("ANALIZ: Sheets'e yazilamadi (TEKRAR DENENMIYOR):", e && e.message ? e.message : e);
    return "YAZILAMADI: " + (e && e.message ? e.message : e);
  }
}

async function bayrakVar(tarih) {
  try { return !!(await redis.get(BAYRAK + tarih)); }
  catch (e) {
    // Redis okunamiyorsa GUVENLI TARAF: "yapilmis" say, ikinci rapor yazma.
    console.error("ANALIZ: Redis okunamadi, guvenli taraf:", e && e.message ? e.message : e);
    return true;
  }
}
async function bayrakAt(tarih) {
  try { await redis.set(BAYRAK + tarih, "1", { ex: BAYRAK_OMRU }); } catch (e) {}
}

// Analizi calistir (kayit YOK). Hem test hem gercek calisma bunu kullaniyor.
async function calistir(tarih) {
  const satirlar = await konusmalariOku(tarih);
  const duzen = konusmalariDuzenle(satirlar);
  if (duzen.konusmaSayisi === 0) {
    return { bos: true, tarih: tarih, duzen: duzen };
  }
  const sonuc = await analizEt(duzen.metin);
  return { bos: false, tarih: tarih, duzen: duzen, sonuc: sonuc };
}

// ============ TEST MODU (hicbir yere kayit yazmaz) ============
async function handleTest(req, res) {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");

  const istenenTarih = req.query && req.query.tarih;
  const tarih = tarihGecerliMi(istenenTarih) ? istenenTarih : trTarih(1);

  let c = "=== GUNLUK BOT ANALIZI (TEST MODU - HICBIR KAYIT YAZILMADI) ===\n";
  c += "Analiz edilen gun: " + tarih + "\n";
  if (istenenTarih && !tarihGecerliMi(istenenTarih)) {
    c += "UYARI: verdigin tarih gg.aa.yyyy bicimine uymuyor, dun analiz edildi.\n";
  }
  c += "\n";

  try {
    const r = await calistir(tarih);

    c += "Okunan satir   : " + r.duzen.konusmaSayisi + "\n";
    c += "Farkli musteri : " + r.duzen.musteriSayisi + "\n";
    if (r.duzen.kesildi) {
      c += "UYARI: satir sayisi " + MAX_SATIR + " tavanini asti, en yeni " + MAX_SATIR + " satir analiz edildi.\n";
    }

    if (r.bos) {
      c += "\nBu tarihte hic konusma bulunamadi.\n\n";
      if (sonTani) {
        c += "--- TANI (Sheets ne gordu) ---\n";
        c += "Okunan sekme   : " + sonTani.sekme + "\n";
        c += "Sekmedeki satir: " + sonTani.sonSatir + "\n";
        c += "Aranan gun     : " + tarih + "\n";
        const ornekler = Array.isArray(sonTani.ornekler) ? sonTani.ornekler : [];
        if (ornekler.length === 0) {
          c += "Tarih ornegi   : (yok - sekme bos gorunuyor)\n";
        } else {
          c += "\nSon satirlarin TARIH sutununda gercekte ne var:\n";
          ornekler.forEach(function (o, i) {
            c += "  " + (i + 1) + ") tip=" + o.tip + "  ham='" + o.ham + "'\n";
            c += "     cevrilmis='" + o.cevrilmis + "'  ->  gun='" + o.gun + "'\n";
          });
          c += "\nYukaridaki 'gun' degerlerinden biri aranan gune ('" + tarih + "') esit\n";
          c += "olmaliydi. Degilse tarih bicimi farkli demektir - bu ciktiyi bana at.\n";
        }
      } else {
        c += "Olasi sebepler:\n";
        c += "  - O gun gercekten hic mesaj gelmemis\n";
        c += "  - Apps Script guncel degil (tani bilgisi gelmedi)\n";
      }
      return res.status(200).send(c);
    }

    const s = r.sonuc;
    c += "Token          : " + s.girisToken + " giris / " + s.cikisToken + " cikis\n\n";

    c += "--- GUNUN OZETI ---\n";
    c += "En cok sorulan : " + (konularMetni(s.enCokSorulanlar) || "(yok)") + "\n";
    c += "Kizgin musteri : " + s.kizginMusteri + "\n";
    c += "Kacan satis    : " + s.kacanSatis + "\n";
    c += "Oneri          : " + s.oneri + "\n\n";

    c += "--- SORUNLU CEVAPLAR (" + s.sorunlar.length + " adet) ---\n";
    if (s.sorunlar.length === 0) {
      c += "Hic sorunlu cevap bulunamadi.\n";
    } else {
      s.sorunlar.forEach(function (p, i) {
        c += "\n" + (i + 1) + ") [" + (p.saat || "?") + "] " + (p.telefon || "?") + "  -  " + (p.tur || "?") + "\n";
        c += "   MUSTERI : " + (p.musteriMesaji || "") + "\n";
        c += "   BOT     : " + (p.botCevabi || "") + "\n";
        c += "   SORUN   : " + (p.aciklama || "") + "\n";
        c += "   OLMALI  : " + (p.olmasiGereken || "") + "\n";
      });
    }

    c += "\n-----------------------------------------\n";
    c += "Bu test modu, sonucu HICBIR YERE yazmadi.\n";
    c += "Gercek calismada bu bilgiler 'Gunluk Analiz' ve 'Sorunlu Cevaplar'\n";
    c += "sekmelerine yazilacak.\n";
    return res.status(200).send(c);
  } catch (error) {
    c += "HATA: " + (error && error.message ? error.message : error) + "\n\n";
    c += "Sik sebepler:\n";
    c += "  - 'Apps Script'e konusma_oku dali eklendi mi' yaziyorsa: Apps Script guncellenmemis\n";
    c += "    veya guncellenip YENI SURUM olarak dagitilmamis.\n";
    c += "  - 'Anthropic HTTP 4xx' yaziyorsa: API anahtari veya harcama limiti.\n";
    return res.status(200).send(c);
  }
}

// ============ GERCEK CALISMA ============
module.exports = async (req, res) => {
  const secret = req.query && req.query.secret;
  if (secret !== SECRET) {
    console.error("ANALIZ: gecersiz secret");
    return res.status(401).send("Unauthorized");
  }

  if (req.method === "GET" && req.query && req.query.mod === "test") {
    return handleTest(req, res);
  }
  if (req.method !== "POST") return res.status(200).send("OK");

  const istenenTarih = req.query && req.query.tarih;
  const tarih = tarihGecerliMi(istenenTarih) ? istenenTarih : trTarih(1);

  try {
    if (await bayrakVar(tarih)) {
      console.log("ANALIZ: bu tarih zaten analiz edilmis, atlandi:", tarih);
      return res.status(200).send("OK - zaten analiz edilmis: " + tarih);
    }

    const r = await calistir(tarih);

    if (r.bos) {
      // Bayragi burada da atiyoruz: bos gun icin her tetiklemede Sheets'i
      // ve Claude'u bosuna yormayalim.
      await bayrakAt(tarih);
      console.log("ANALIZ: bu tarihte konusma yok:", tarih);
      return res.status(200).send("OK - konusma yok: " + tarih);
    }

    const s = r.sonuc;

    // Bayrak, kayittan ONCE atiliyor. Sebebi: Sheets yazimi yarida kalirsa
    // ikinci calisma ayni gunu tekrar yazip mukerrer satir olusturabilir.
    // Eksik rapor, cift rapordan iyidir - eksigini test moduyla elle alabiliriz.
    await bayrakAt(tarih);

    const kayit = await sheetseYaz(tarih, r.duzen, s);

    const ozet = tarih + ": " + r.duzen.konusmaSayisi + " satir, " +
      r.duzen.musteriSayisi + " musteri, " + s.sorunlar.length + " sorunlu cevap, " +
      s.kizginMusteri + " kizgin, " + s.kacanSatis + " kacan satis";
    console.log("ANALIZ OZET:", ozet, "| Sheets:", kayit,
      "| token:", s.girisToken + "/" + s.cikisToken);

    return res.status(200).send("OK - " + ozet);
  } catch (error) {
    console.error("ANALIZ HATA:", error && error.message ? error.message : error);
    // QStash'in tekrar tekrar denemesini istemiyoruz - 200 donuyoruz.
    return res.status(200).send("OK - hata: " + (error && error.message ? error.message : error));
  }
};
