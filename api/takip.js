// api/takip.js
// BILGI ALIP KAYBOLAN MUSTERIYE TAKIP MESAJI
//
// Musteri WhatsApp'a yaziyor (reklamdan, Instagram'dan, siteden), bot
// cevapliyor, sonra kisi sessizlesiyor. Bu dosya o kisilere iki asamali
// bir hatirlatma gonderiyor.
//
//   1) Son mesajindan 3,5 SAAT sonra -> SERBEST METIN
//      "479 TL'lik Ari Zehri Kremi hediye" teklifi.
//      24 saatlik musteri hizmeti penceresi acik oldugu icin sablon
//      GEREKMIYOR, normal metin gonderebiliyoruz.
//
//   2) Hala cevap yoksa 28 SAAT sonra -> META SABLONU (takip_indirim)
//      "BOYUN kodu ile 500 TL indirim, 48 saat gecerli".
//      24 saat gectigi icin serbest metin ARTIK GONDERILEMEZ; Meta'nin
//      onayladigi sablon sart.
//
// KUYRUK NASIL DOLUYOR: webhook-process.js her musteri mesajindan sonra
// telefonu "takip-kuyruk" sirali kumesine (sorted set) yaziyor, skor =
// mesajin zamani. Ayni telefon tekrar yazarsa skoru guncelleniyor. Burada
// sadece "skoru yeterince eski" olanlari cekiyoruz - Redis'te desen
// taramasi (SCAN) yapmaya gerek kalmiyor.
//
// KIMLERE GONDERILMIYOR (kullanici karari, 2026-10-25):
//   - Siparis verenler (hem bottan hem siteden - iki ayri kontrol var)
//   - Destek konusmalari (kargo/iade/ariza derdi olan, zaten musteri)
//   - Acikca "ilgilenmiyorum / istemiyorum" diyenler
//   - "Mesaj istemiyorum" butonuna basanlar (kalici)
//   - Kendi numaralarimiz
// NOT: "pahali" diyen BILEREK elenmiyor - indirim teklifinin asil hedefi
// zaten fiyat itirazi olan musteri.
//
// GUVENLIK RAYLARI (sepet-kurtarma.js'teki derslerin aynisi):
//   - MAX_YAS_SAAT: 72 saatten eski kayitlara dokunulmuyor ve kuyruktan
//     siliniyor. Ilk deploy'da gecmisteki herkese toplu mesaj gitmesin.
//   - PARTI_LIMITI: tek calismada en fazla 10 mesaj. Ani mesaj patlamasi
//     WhatsApp numarasinin kalite puanini dusurur.
//   - Kisi basina her asamadan SADECE BIR mesaj (Redis bayragi, 30 gun).
//   - Siparis gecmisi okunamazsa HIC MESAJ GITMEZ (guvenli taraf).
//
// TEST MODU: GET ?mod=test&secret=...  -> hicbir mesaj GONDERMEZ, sadece
// "su an kime ne gonderilecekti" listesini duz metin olarak yazar.
//
// GERCEK CALISMA: POST ?secret=...  (QStash Schedule ile 15 dakikada bir)

const { Redis } = require("@upstash/redis");
const redis = Redis.fromEnv();

const SECRET = "masajur_yakkoholding_2128";
const API_VERSION = "2026-04";            // diger dosyalarla ayni

// --- Zamanlama (saat) ---
const ASAMA1_SAAT = 3.5;
const ASAMA2_SAAT = 28;
const MAX_YAS_SAAT = 72;

// 24 saatlik serbest metin penceresi. QStash bir sure calismazsa kayitlar
// birikip 24 saati gecebilir; o durumda 1. mesaji SERBEST METIN olarak
// gondermeye calismak bosuna hata uretir (Meta reddeder). Pencerenin
// kenarina gelmis kisiyi atlayip 2. asamada sablonla yakaliyoruz.
const SERBEST_METIN_SON_SAAT = 23;

// --- Guvenlik sinirlari ---
const PARTI_LIMITI = 10;

// --- SESSIZ SAAT (2026-10-26) ---
// Ilk gun 129 mesajin ~45'i gece 22:00-08:00 arasinda gitti: musteri
// 23:30'da yaziyor, 3,5 saat sonra saat 03:00 oluyor ve sistem mesaji
// atiyor. Kural dogru calisiyordu ama sonucu kotu - uyuyan insana satis
// mesaji gidiyor, engellenme/sikayet WhatsApp kalite puanini dusuruyor,
// gece okunan mesaj zaten donusmuyor.
// Simdi: bu saatlerin disinda hicbir takip mesaji gonderilmiyor. Bayrak
// ATILMIYOR, kuyruktan SILINMIYOR - kisi sabah 09:00'daki ilk calismada
// normal sirasiyla yakalaniyor.
const SESSIZ_BASLANGIC = 22;   // 22:00'den itibaren gonderim yok
const SESSIZ_BITIS = 9;        // 09:00'da tekrar basliyor

// Vercel UTC calisiyor, Turkiye UTC+3 (yaz saati uygulamasi yok).
function turkiyeSaati() {
  return (new Date().getUTCHours() + 3) % 24;
}

function sessizSaatteMiyiz() {
  const s = turkiyeSaati();
  return s >= SESSIZ_BASLANGIC || s < SESSIZ_BITIS;
}

// --- Siparis gecmisi kontrolu ---
const SIPARIS_GECMISI_GUN = 30;
const SIPARIS_SAYFA_LIMITI = 8;           // 8 x 250 = 2000 siparis tavan

// --- WhatsApp sablonu (2. asama) ---
// Meta'da olusturulacak: kategori PAZARLAMA, dil Turkce, PARAMETRESIZ.
// Parametresiz secildi: musterinin adini cogu zaman bilmiyoruz (sadece
// siparis akisina giren kisiler ad veriyor), "degerli musterimiz" gibi
// bir doldurma da samimiyetsiz duruyor.
const TAKIP2_TEMPLATE = "takip_indirim";
const TAKIP2_LANG = "tr";

// Kendi numaralarimiz
const ALERT_NUMBERS = ["905530681619", "905511485344"];

// --- Redis anahtarlari ---
const KUYRUK = "takip-kuyruk";            // sorted set: uye=telefon, skor=son mesaj ms
const BAYRAK1 = "takip1:";                // <telefon>
const BAYRAK2 = "takip2:";                // <telefon>
const KAPALI = "takip-kapali:";           // <telefon> - "mesaj istemiyorum"
const SIPARIS_VERDI = "siparis-verdi:";   // <telefon> - chat.js yaziyor
const MOD_ANAHTARI = "mod:";              // <telefon> - chat.js yaziyor
const GECMIS = "chat:";                   // <telefon> - webhook-process.js yaziyor

// hediye-sozu: sepet-kurtarma.js ile AYNI anahtar. Siteden siparis
// gelirse siparis-kayit.js zaten bu bayraga bakip siparisi "hediye-krem"
// diye etiketliyor; bottan siparis gelirse chat.js ayni bayragi okuyup
// isletme bildirimine "HEDIYE: Ari Zehri Kremi" notunu dusuyor.
const HEDIYE_SOZU = "hediye-sozu:";
const HEDIYE_OMRU = 48 * 3600;

// 2026-10-26: BIZ musteriye "satin al" diye yazdik. Bundan sonraki 48
// saatlik yazisma genel sohbet kaydina karismasin diye isaretleniyor;
// webhook-process.js bu bayragi okuyup Sheets'e "takip_sohbet" tipiyle
// yaziyor. 48 saat sonra kendiliginden normale donuyor - musteri bir ay
// sonra kargo sorarsa o normal sohbete dusuyor.
const TAKIP_SOHBET = "takip-sohbet:";
const TAKIP_SOHBET_OMRU = 48 * 3600;
const BAYRAK_OMRU = 30 * 24 * 3600;       // 30 gun
const KAPALI_OMRU = 365 * 24 * 3600;      // 1 yil

// Acikca "hayir" diyen musteri. BILEREK DAR tutuldu: "pahali", "dusunurum",
// "esime soracagim" gibi ifadeler BURADA YOK - onlar hala ikna edilebilir
// musteriler ve indirim teklifinin asil hedefi onlar.
const RET_KALIPLARI = [
  "ilgilenmiyorum", "ilgilenmiyoruz", "istemiyorum", "istemem",
  "almayacağım", "almayacagim", "almak istemiyorum", "gerek yok",
  "vazgeçtim", "vazgectim", "iptal edin", "rahatsız etmeyin",
  "rahatsiz etmeyin", "mesaj atmayın", "mesaj atmayin",
  "beni aramayın", "beni aramayin", "listeden çıkar", "listeden cikar",
  "mesaj istemiyorum"
];

// 1. ASAMA METNI (serbest metin - sablon degil, istedigimiz gibi yazabiliriz)
const ASAMA1_METIN =
  "Merhaba 🙂 Masajur hakkında yazmıştınız, aklınızda kalan bir soru varsa " +
  "buradayım.\n\n" +
  "Siparişinizi şimdi tamamlarsanız 479 TL değerindeki Arı Zehri Kremi'ni " +
  "hediye ediyoruz. Visco yastık zaten her siparişte hediye.\n\n" +
  "Ücretsiz kargo ve kapıda ödeme ile gönderiyoruz. 14 gün iade hakkınız " +
  "var, memnun kalmazsanız gönül rahatlığıyla iade edebilirsiniz. Cihaz " +
  "1 yıl garantili.\n\n" +
  "Dilerseniz ad soyad ve açık adresinizi buraya yazın, siparişinizi ben " +
  "oluşturayım. Ya da masajur.com/al adresinden kendiniz de verebilirsiniz.";

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeTelefon(raw) {
  if (!raw) return "";
  let d = String(raw).replace(/[^0-9]/g, "");
  if (!d) return "";
  if (d.startsWith("0")) d = "90" + d.slice(1);
  if (!d.startsWith("90")) d = "90" + d;
  return d;
}

function telefonCikar(o) {
  const cust = o.customer || {};
  const ship = o.shipping_address || {};
  const bill = o.billing_address || {};
  return normalizeTelefon(o.phone || ship.phone || bill.phone || cust.phone);
}

function readWaStatus(waData) {
  try {
    if (waData && waData.messages && waData.messages[0] && waData.messages[0].id) {
      return "Gonderildi OK (" + waData.messages[0].id + ")";
    }
    if (waData && waData.error) {
      const code = waData.error.code != null ? " [" + waData.error.code + "]" : "";
      return "GITMEDI HATA" + code + ": " + (waData.error.message || "bilinmeyen hata");
    }
    return "BELIRSIZ: " + JSON.stringify(waData).slice(0, 150);
  } catch (e) {
    return "DURUM OKUNAMADI: " + (e && e.message ? e.message : e);
  }
}

// ============================================================
// SHOPIFY SIPARIS GECMISI
// ------------------------------------------------------------
// NOT (bilincli tekrar): asagidaki iki fonksiyonun ayni mantigi
// sepet-kurtarma.js'te de var. Ortak bir lib/ dosyasina almak dogru
// olurdu (Yurtici istemcisinde oyle yapildi) ama o is CALISAN
// sepet-kurtarma.js'i de degistirmeyi gerektiriyor. Yeni sistem
// oturduktan sonra ikisi birlikte lib/shopify-siparis.js'e tasinmali.
// ============================================================
function sonrakiSayfaUrl(linkHeader) {
  if (!linkHeader) return "";
  const parcalar = String(linkHeader).split(",");
  for (const p of parcalar) {
    if (p.indexOf('rel="next"') !== -1) {
      const m = p.match(/<([^>]+)>/);
      if (m) return m[1];
    }
  }
  return "";
}

// Her istegin basinda null'a cekiliyor - bayat listeyle karar vermeyelim.
let siparisTelefonCache = null;

async function siparisVerenTelefonlar() {
  if (siparisTelefonCache) return siparisTelefonCache;
  try {
    const kume = new Set();
    const minDate = new Date(Date.now() - SIPARIS_GECMISI_GUN * 24 * 3600 * 1000).toISOString();
    let url = `https://${process.env.SHOPIFY_STORE}/admin/api/${API_VERSION}/orders.json` +
      `?status=any&limit=250&created_at_min=${encodeURIComponent(minDate)}` +
      `&fields=id,name,phone,customer,shipping_address,billing_address`;

    let sayfa = 0;
    while (url && sayfa < SIPARIS_SAYFA_LIMITI) {
      const r = await fetchWithTimeout(url, {
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_TOKEN,
          "Content-Type": "application/json"
        }
      }, 20000);
      if (!r.ok) {
        const govde = await r.text().catch(() => "");
        throw new Error("orders.json HTTP " + r.status + " - " + govde.slice(0, 200));
      }
      const data = await r.json().catch(() => ({}));
      const siparisler = Array.isArray(data.orders) ? data.orders : [];
      for (const o of siparisler) {
        const t = telefonCikar(o);
        if (t) kume.add(t);
      }
      url = sonrakiSayfaUrl(r.headers.get("link"));
      sayfa++;
    }
    console.log("TAKIP: son " + SIPARIS_GECMISI_GUN + " gunde siparis veren " +
      kume.size + " telefon (" + sayfa + " sayfa)");
    siparisTelefonCache = kume;
    return kume;
  } catch (e) {
    // GUVENLI TARAF: siparis gecmisini okuyamadiysak MESAJ GONDERME.
    // Zaten almis birine "sana hediye" yazmak, mesajin hic gitmemesinden
    // cok daha kotu (sepet-kurtarma.js'te yasanmis bir olay).
    console.error("TAKIP: siparis gecmisi okunamadi (MESAJ GONDERILMIYOR):",
      e && e.message ? e.message : e);
    siparisTelefonCache = "HATA";
    return "HATA";
  }
}

// ============================================================
// Redis yardimcilari
// ============================================================
async function bayrakVar(anahtar) {
  try {
    const v = await redis.get(anahtar);
    return !!v;
  } catch (e) {
    // Redis okunamiyorsa guvenli taraf: "gonderilmis" say, mesaj gonderme.
    return true;
  }
}

async function bayrakAt(anahtar, omur) {
  try { await redis.set(anahtar, "1", { ex: omur }); } catch (e) {}
}

async function kuyruktanSil(telefon) {
  try { await redis.zrem(KUYRUK, telefon); } catch (e) {}
}

// Destek modunda mi? chat.js "mod:<telefon>" = "destek:<epoch>" yaziyor.
async function destekModundaMi(telefon) {
  try {
    const v = await redis.get(MOD_ANAHTARI + telefon);
    return String(v || "").startsWith("destek");
  } catch (e) {
    return false;
  }
}

// Konusma gecmisinde acik bir ret var mi?
async function retVarMi(telefon) {
  try {
    const h = await redis.get(GECMIS + telefon);
    if (!Array.isArray(h)) return false;
    for (const m of h) {
      if (!m || m.role !== "user") continue;
      const s = String(m.content || "").toLowerCase();
      if (RET_KALIPLARI.some(function (k) { return s.includes(k); })) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

// ============================================================
// WhatsApp gonderimi
// ============================================================
async function serbestMetinGonder(telefon, metin) {
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
          to: telefon,
          type: "text",
          text: { body: metin }
        })
      },
      15000
    );
    const data = await resp.json().catch(() => ({}));
    return readWaStatus(data);
  } catch (e) {
    return "GITMEDI HATA: " + (e && e.message ? e.message : e);
  }
}

async function sablonGonder(telefon) {
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
          to: telefon,
          type: "template",
          template: {
            name: TAKIP2_TEMPLATE,
            language: { code: TAKIP2_LANG }
            // components YOK: sablon parametresiz.
          }
        })
      },
      12000
    );
    const data = await resp.json().catch(() => ({}));
    return readWaStatus(data);
  } catch (e) {
    return "GITMEDI HATA: " + (e && e.message ? e.message : e);
  }
}

// Sheets'e yaz. Apps Script'te "takip_mesaji" dali yoksa kayit
// "Bilinmeyen Kayitlar" guvenlik agina duser (07.10'da eklenmisti),
// yani veri kaybolmaz - ama dal eklenirse duzgun sekmeye yazar.
async function logTakipToSheets(asama, telefon, durum) {
  try {
    if (!process.env.SHEETS_URL) return;
    await fetchWithTimeout(process.env.SHEETS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "takip_mesaji",
        id: "takip-" + asama + "-" + telefon,   // mukerrer korumasi
        asama: String(asama),
        phone: String(telefon || ""),
        status: String(durum || "")
      })
    }, 15000);
  } catch (e) {
    console.error("TAKIP: Sheets log HATA:", e && e.message ? e.message : e);
  }
}

// ============================================================
// Karar: bu telefona su an hangi asama?
// Doner: { asama: 0|1|2, sebep: "...", sil: true|false }
// ============================================================
// zorla=true SADECE elle test tetiklemesinde (mod=simdi-gonder) geliyor.
// Yalnizca ZAMAN kontrollerini ve kendi numara elemesini atlatir; opt-out,
// siparis, destek, ret gibi GERCEK guvenlik elemeleri aynen calisir.
async function asamaBelirle(telefon, yasSaat, zorla) {
  // Ikinci emniyet: cagiran taraf sayi gecirse bile metne ceviriyoruz.
  // Asagidaki includes/has kontrolleri metin bekliyor (bkz. adaylariGetir).
  telefon = telefon == null ? "" : String(telefon);
  if (!telefon) return { asama: 0, sebep: "telefon yok", sil: true };
  if (!zorla && ALERT_NUMBERS.includes(telefon)) {
    return { asama: 0, sebep: "kendi numaramiz", sil: true };
  }
  if (!zorla && yasSaat > MAX_YAS_SAAT) {
    return { asama: 0, sebep: "cok eski (" + yasSaat.toFixed(1) + " saat)", sil: true };
  }
  if (!zorla && yasSaat < ASAMA1_SAAT) {
    return { asama: 0, sebep: "henuz erken (" + yasSaat.toFixed(1) + " saat)", sil: false };
  }

  if (await bayrakVar(KAPALI + telefon)) {
    return { asama: 0, sebep: "mesaj istemiyor", sil: true };
  }
  if (await bayrakVar(BAYRAK2 + telefon)) {
    return { asama: 0, sebep: "iki mesaj da gonderilmis", sil: true };
  }
  if (await destekModundaMi(telefon)) {
    return { asama: 0, sebep: "destek konusmasi", sil: true };
  }
  if (await bayrakVar(SIPARIS_VERDI + telefon)) {
    return { asama: 0, sebep: "bottan siparis vermis", sil: true };
  }
  if (await retVarMi(telefon)) {
    return { asama: 0, sebep: "acikca ilgilenmedigini soylemis", sil: true };
  }

  const b1 = await bayrakVar(BAYRAK1 + telefon);

  // Hangi asamaya adayiz?
  //
  // SIRA ONEMLI: once 2. asamaya bakiliyor. Ilk yazimda 2. asama "1. mesaj
  // gitmis olmak" sartina bagliydi; testte su acik cikti: 1. mesaj herhangi
  // bir sebeple gidemediyse (sistem kapaliydi, o saatte destek modundaydi,
  // 24 saatlik pencere kapanmisti) kisi 2. mesaji da HIC alamiyor ve 72
  // saatte sessizce dusuyordu. Artik 28 saati gecen herkes - 1. mesaji alsin
  // almasin - sablonla yakalaniyor. Eleme kontrolleri (siparis, destek, ret)
  // bu noktada zaten yeniden calisti.
  let aday = 0;
  let sebep = "";
  if (yasSaat >= ASAMA2_SAAT) {
    aday = 2;
    sebep = yasSaat.toFixed(1) + " saat sessiz, indirim kodu" +
      (b1 ? "" : " (1. mesaj gidememisti)");
  } else if (!b1) {
    if (yasSaat > SERBEST_METIN_SON_SAAT) {
      // 24 saatlik serbest metin penceresi kapanmak uzere: su an metin
      // gondermek bosuna hata uretir. 28. saatte sablonla yakalayacagiz.
      return {
        asama: 0,
        sebep: "pencere kapanmis (" + yasSaat.toFixed(1) + " saat), 2. asama bekleniyor",
        sil: false
      };
    }
    aday = 1;
    sebep = yasSaat.toFixed(1) + " saat sessiz, hediye teklifi";
  } else {
    return {
      asama: 0,
      sebep: "1. mesaj gitti, " + yasSaat.toFixed(1) + " saat (" + ASAMA2_SAAT + " bekleniyor)",
      sil: false
    };
  }

  // SON KONTROL (en pahalisi, bilerek en sonda): siteden siparis vermis mi?
  const siparisliler = await siparisVerenTelefonlar();
  if (siparisliler === "HATA") {
    return { asama: 0, sebep: "siparis gecmisi okunamadi, guvenli taraf", sil: false };
  }
  if (siparisliler.has(telefon)) {
    return { asama: 0, sebep: "son " + SIPARIS_GECMISI_GUN + " gunde siparisi var", sil: true };
  }

  return { asama: aday, sebep: sebep, sil: false };
}

// Kuyruktan islenecek adaylari cek: skoru (son mesaj zamani) ASAMA1_SAAT'ten
// eski olan herkes. En eskiden baslayarak.
async function adaylariGetir() {
  const tavan = Date.now() - ASAMA1_SAAT * 3600 * 1000;
  try {
    // Upstash: zrange(key, min, max, { byScore: true })
    const uyeler = await redis.zrange(KUYRUK, 0, tavan, { byScore: true });
    if (!Array.isArray(uyeler)) return [];
    // 2026-10-26 KRITIK DUZELTME: Upstash istemcisi degerleri otomatik JSON
    // cozuyor; "905337056888" gibi tamamen rakamdan olusan bir uye buradan
    // SAYI olarak donuyor. Metin birlestirmesiyle yapilan kontroller
    // (redis.get("takip-kapali:" + telefon)) bundan etkilenmiyordu, ama
    // ALERT_NUMBERS.includes(telefon) ve siparisliler.has(telefon) her zaman
    // false donuyordu - yani "kendi numaramiz" ve "siparis vermis musteri"
    // elemeleri SESSIZCE CALISMIYORDU. Gercek vaka: siparis #14008
    // (905337056888) ve kendi numaramiz 905530681619 takip mesaji aldi.
    return uyeler.map(function (u) { return String(u); });
  } catch (e) {
    console.error("TAKIP: kuyruk okunamadi:", e && e.message ? e.message : e);
    return [];
  }
}

async function sonMesajZamani(telefon) {
  try {
    const skor = await redis.zscore(KUYRUK, telefon);
    return skor == null ? 0 : Number(skor);
  } catch (e) {
    return 0;
  }
}

// ============ TEST MODU (hicbir mesaj gondermez) ============
async function handleTest(req, res) {
  const secret = req.query && req.query.secret;
  if (secret !== SECRET) return res.status(401).send("Unauthorized");

  siparisTelefonCache = null;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");

  try {
    const adaylar = await adaylariGetir();

    // Kuyrugun TAMAMI (suresi dolmamislar dahil). Boylece bota yeni yazilan
    // bir numaranin kuyruga dustugu 3,5 saat beklemeden gorulebiliyor.
    let tumKuyruk = [];
    try {
      const duz = await redis.zrange(KUYRUK, 0, -1, { withScores: true });
      if (Array.isArray(duz)) {
        for (let i = 0; i < duz.length; i += 2) {
          tumKuyruk.push({ telefon: String(duz[i]), ms: Number(duz[i + 1]) });
        }
      }
    } catch (e) {
      console.error("TAKIP TEST: tum kuyruk okunamadi:", e && e.message ? e.message : e);
    }

    let cikti = "=== TAKIP MESAJI (TEST MODU - HICBIR MESAJ GONDERILMEDI) ===\n";
    cikti += "Kurallar: " + ASAMA1_SAAT + ". saatte hediye metni, " + ASAMA2_SAAT +
      ". saatte indirim sablonu, " + MAX_YAS_SAAT + " saatten eskiye dokunulmaz\n";
    cikti += "Sessiz saat   : " + SESSIZ_BASLANGIC + ":00 - " + SESSIZ_BITIS +
      ":00 arasi gonderim YOK. Su an Turkiye saati " + turkiyeSaati() + ":00" +
      (sessizSaatteMiyiz() ? "  >>> SESSIZ SAATTEYIZ, su an mesaj gitmez <<<" : "") + "\n";
    cikti += "Kuyrukta toplam  : " + tumKuyruk.length + " numara\n";
    cikti += "Suresi dolan     : " + adaylar.length + " numara (" + ASAMA1_SAAT + " saati gecenler)\n";

    const siparisliler = await siparisVerenTelefonlar();
    if (siparisliler === "HATA") {
      cikti += "SIPARIS GECMISI : >>> OKUNAMADI <<< - bu haldeyken HICBIR MESAJ GITMEZ.\n\n";
    } else {
      cikti += "Siparis gecmisi : son " + SIPARIS_GECMISI_GUN + " gunde " +
        siparisliler.size + " telefon - bunlara mesaj gitmez\n\n";
    }

    // Henuz suresi dolmamislari da goster - testte en cok ise yarayan kisim bu.
    const bekleyenler = tumKuyruk
      .filter(function (k) { return (Date.now() - k.ms) / 3600000 < ASAMA1_SAAT; })
      .sort(function (a, b) { return b.ms - a.ms; });

    if (bekleyenler.length > 0) {
      cikti += "SURESI HENUZ DOLMAYANLAR (en yeni ustte, ilk 10):\n";
      bekleyenler.slice(0, 10).forEach(function (k) {
        const yas = (Date.now() - k.ms) / 3600000;
        const kalan = ASAMA1_SAAT - yas;
        cikti += "  " + k.telefon + " - " + yas.toFixed(1) + " saat once yazdi, " +
          kalan.toFixed(1) + " saat sonra 1. mesaj gider\n";
      });
      cikti += "\n";
    }

    if (adaylar.length === 0) {
      cikti += "Suresi dolan kimse yok, su an gonderilecek mesaj yok.\n\n";
      if (tumKuyruk.length === 0) {
        cikti += "Kuyruk tamamen bos. Bu normal olabilir: kuyruk ancak\n" +
          "webhook-process.js'in yeni surumu deploy edildikten SONRA yazan\n" +
          "musterilerle dolmaya baslar. Kendi telefonundan bota bir mesaj at,\n" +
          "bu sayfayi yenileyince numaran yukarida gorunmeli.\n";
      }
      return res.status(200).send(cikti);
    }

    let sayac1 = 0, sayac2 = 0;
    for (const telefon of adaylar) {
      const ms = await sonMesajZamani(telefon);
      const yas = ms ? (Date.now() - ms) / 3600000 : 999;
      const { asama, sebep } = await asamaBelirle(telefon, yas);
      if (asama === 1) sayac1++;
      if (asama === 2) sayac2++;

      cikti += "-----------------------------------------\n";
      cikti += "Telefon   : " + telefon + "\n";
      cikti += "Son mesaj : " + yas.toFixed(1) + " saat once\n";
      cikti += "KARAR     : " + (asama === 0 ? "MESAJ YOK" : asama + ". ASAMA GIDERDI") +
        " - " + sebep + "\n";
    }

    cikti += "-----------------------------------------\n\n";
    cikti += "OZET: " + sayac1 + " hediye metni, " + sayac2 + " indirim sablonu gidecekti.\n\n";
    cikti += "KONTROL LISTESI:\n";
    cikti += "  1) 'Siparis gecmisi' satirinda makul bir sayi var mi?\n";
    cikti += "  2) Siparis vermis bir numara listede 'siparisi var' diye eleniyor mu?\n";
    cikti += "  3) Kargo/iade soran biri 'destek konusmasi' diye eleniyor mu?\n";
    cikti += "  4) 2. asama icin Meta'da '" + TAKIP2_TEMPLATE + "' sablonu ONAYLANDI mi?\n";
    cikti += "     Onaylanmadan 2. mesaj GITMEZ (hata doner, bayrak yine de atilir).\n";
    return res.status(200).send(cikti);
  } catch (error) {
    return res.status(200).send("HATA: " + (error && error.message ? error.message : error));
  }
}

// ============ TEST YARDIMCISI: VIDEO KILIDINI SIFIRLA ============
// GET ?mod=video-sifirla&telefon=905...&secret=...
// Bir numaranin video kilitlerini ve sohbet hafizasini siler, boylece o
// numara bota tekrar yazdiginda konusma SIFIRDAN baslar ve video yeniden
// gider. Sadece test icin - musteri akisini etkilemez.
async function handleVideoSifirla(req, res) {
  const secret = req.query && req.query.secret;
  if (secret !== SECRET) return res.status(401).send("Unauthorized");

  res.setHeader("Content-Type", "text/plain; charset=utf-8");

  const ham = String((req.query && req.query.telefon) || "").replace(/\D/g, "");
  if (!ham) return res.status(200).send("telefon parametresi gerekli. Ornek: ?mod=video-sifirla&telefon=905551112233&secret=...");

  try {
    const silinen = [];
    for (const anahtar of ["tanitim", "fizyoterapist"]) {
      await redis.del("medya-gonderildi:" + ham + ":" + anahtar);
      silinen.push(anahtar);
    }
    await redis.del(GECMIS + ham);
    return res.status(200).send(
      "SIFIRLANDI: " + ham + "\n" +
      "  video kilitleri : " + silinen.join(", ") + "\n" +
      "  sohbet hafizasi : silindi\n\n" +
      "Bu numara bota tekrar yazdiginda konusma sifirdan baslar,\n" +
      "ilk cevapta video yeniden gider.\n"
    );
  } catch (e) {
    return res.status(200).send("HATA: " + (e && e.message ? e.message : e));
  }
}

// ============ TEST YARDIMCISI: SIMDI GONDER ============
// GET ?mod=simdi-gonder&telefon=905...&asama=1&secret=...
// Tek bir numaraya takip mesajini 3,5 saat beklemeden HEMEN gonderir.
// Sadece ZAMAN kosulunu ve kendi-numara elemesini atlar; opt-out, siparis,
// destek konusmasi ve ret elemeleri aynen calisir. Gercek gonderimle ayni
// bayraklari atar, ayni Sheets kaydini yazar - yani gercek akisin aynisi.
async function handleSimdiGonder(req, res) {
  const secret = req.query && req.query.secret;
  if (secret !== SECRET) return res.status(401).send("Unauthorized");

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  siparisTelefonCache = null;

  const telefon = normalizeTelefon((req.query && req.query.telefon) || "");
  if (!telefon) {
    return res.status(200).send("telefon parametresi gerekli.\nOrnek: ?mod=simdi-gonder&telefon=905551112233&asama=1&secret=...");
  }

  const istenenAsama = String((req.query && req.query.asama) || "1") === "2" ? 2 : 1;
  const sahteYas = istenenAsama === 2 ? ASAMA2_SAAT : ASAMA1_SAAT;

  try {
    const { asama, sebep } = await asamaBelirle(telefon, sahteYas, true);
    if (asama === 0) {
      return res.status(200).send(
        "GONDERILMEDI: " + telefon + "\nSebep: " + sebep + "\n\n" +
        "Bu bir eleme. Gercek akista da bu kisiye mesaj gitmezdi.\n"
      );
    }

    let durum;
    if (asama === 1) {
      durum = await serbestMetinGonder(telefon, ASAMA1_METIN);
      await bayrakAt(BAYRAK1 + telefon, BAYRAK_OMRU);
      await bayrakAt(HEDIYE_SOZU + telefon, HEDIYE_OMRU);
    } else {
      durum = await sablonGonder(telefon);
      await bayrakAt(BAYRAK2 + telefon, BAYRAK_OMRU);
      await kuyruktanSil(telefon);
    }
    await bayrakAt(TAKIP_SOHBET + telefon, TAKIP_SOHBET_OMRU);
    await logTakipToSheets(asama, telefon, durum);

    return res.status(200).send(
      "GONDERILDI: " + telefon + "\n" +
      "  asama  : " + asama + (asama === 1 ? " (hediye metni)" : " (indirim sablonu)") + "\n" +
      "  durum  : " + durum + "\n" +
      "  karar  : " + sebep + "\n\n" +
      "WhatsApp'ini kontrol et. 'durum' OK degilse mesaj gitmemistir.\n"
    );
  } catch (e) {
    return res.status(200).send("HATA: " + (e && e.message ? e.message : e));
  }
}

// ============ TESHIS: SIPARIS GECMISI KONTROLU ============
// GET ?mod=siparis-kontrol&telefon=905...&secret=...
// 2026-10-26: siparis vermis bir musteriye (#14008 / 905337056888) takip
// mesaji gitti. Eleme calismamis. Bu mod, elemeyi besleyen Shopify
// sorgusunu adim adim gosteriyor: kac sayfa okundu, kac siparis geldi,
// kac telefon cikarilabildi ve aranan numara kumede var mi.
async function handleSiparisKontrol(req, res) {
  const secret = req.query && req.query.secret;
  if (secret !== SECRET) return res.status(401).send("Unauthorized");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");

  const aranan = normalizeTelefon((req.query && req.query.telefon) || "");
  if (!aranan) return res.status(200).send("telefon parametresi gerekli.");

  try {
    const kume = new Set();
    const minDate = new Date(Date.now() - SIPARIS_GECMISI_GUN * 24 * 3600 * 1000).toISOString();
    let url = `https://${process.env.SHOPIFY_STORE}/admin/api/${API_VERSION}/orders.json` +
      `?status=any&limit=250&created_at_min=${encodeURIComponent(minDate)}` +
      `&fields=id,name,phone,customer,shipping_address,billing_address`;

    let sayfa = 0, toplamSiparis = 0, telefonsuz = 0;
    const eslesen = [];
    while (url && sayfa < SIPARIS_SAYFA_LIMITI) {
      const r = await fetchWithTimeout(url, {
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_TOKEN,
          "Content-Type": "application/json"
        }
      }, 20000);
      if (!r.ok) {
        const g = await r.text().catch(() => "");
        return res.status(200).send("Shopify HTTP " + r.status + " - " + g.slice(0, 300));
      }
      const data = await r.json().catch(() => ({}));
      const liste = Array.isArray(data.orders) ? data.orders : [];
      toplamSiparis += liste.length;
      for (const o of liste) {
        const t = telefonCikar(o);
        if (!t) { telefonsuz++; continue; }
        kume.add(t);
        if (t === aranan) {
          eslesen.push((o.name || o.id) + " (sayfa " + (sayfa + 1) + ")");
        }
      }
      const link = r.headers.get("link");
      url = sonrakiSayfaUrl(link);
      sayfa++;
    }

    let c = "=== SIPARIS GECMISI KONTROLU ===\n";
    c += "Aranan numara   : " + aranan + "\n";
    c += "Pencere         : son " + SIPARIS_GECMISI_GUN + " gun (" + minDate.slice(0, 10) + " sonrasi)\n";
    c += "Okunan sayfa    : " + sayfa + " (limit " + SIPARIS_SAYFA_LIMITI + ")\n";
    c += "Okunan siparis  : " + toplamSiparis + "\n";
    c += "Telefonu cikmayan siparis: " + telefonsuz + "\n";
    c += "Kumedeki telefon: " + kume.size + "\n\n";
    c += eslesen.length
      ? "SONUC: numara kumede VAR. Eslesen siparisler: " + eslesen.join(", ") + "\n" +
        "Yani eleme calismali. Mesaj yine de gittiyse sebep baska yerde.\n"
      : "SONUC: numara kumede YOK. Eleme bu yuzden calismadi.\n" +
        "Sayfa sayisi limite dayandiysa pencere kirpilmis olabilir;\n" +
        "telefonsuz siparis sayisi yuksekse telefon alanlari okunamiyor demektir.\n";
    return res.status(200).send(c);
  } catch (e) {
    return res.status(200).send("HATA: " + (e && e.message ? e.message : e));
  }
}

// ============ TEK NUMARA KARAR KONTROLU (hicbir mesaj gondermez) ============
// 2026-10-26: mod=test tum kuyrugu tarayip her aday icin onlarca Redis cagrisi
// yaptigi icin tarayicida acilmiyordu. Bu mod SADECE verilen numara icin
// asamaBelirle()'yi calistirip kararin sebebini ve - en onemlisi - kuyruktan
// gelen uyenin JS tipini yaziyor. Sayi/metin karisikligini burada goruyoruz.
async function handleKarar(req, res) {
  const secret = req.query && req.query.secret;
  if (secret !== SECRET) return res.status(401).send("Unauthorized");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");

  const aranan = normalizeTelefon((req.query && req.query.telefon) || "");
  if (!aranan) return res.status(200).send("telefon parametresi gerekli.");

  siparisTelefonCache = null;
  let c = "=== TEK NUMARA KARAR KONTROLU (MESAJ GONDERILMEDI) ===\n";
  c += "Aranan numara : " + aranan + "\n";

  try {
    // 1) Kuyrukta ham uye hangi tipte duruyor?
    let hamTip = "kuyrukta yok";
    let hamDeger = "-";
    try {
      const duz = await redis.zrange(KUYRUK, 0, -1, { withScores: true });
      if (Array.isArray(duz)) {
        for (let i = 0; i < duz.length; i += 2) {
          if (String(duz[i]) === aranan) {
            hamTip = typeof duz[i];
            hamDeger = String(duz[i]);
            break;
          }
        }
      }
    } catch (e) {
      hamTip = "okunamadi: " + (e && e.message ? e.message : e);
    }
    c += "Kuyruktaki tip: " + hamTip + " (deger: " + hamDeger + ")\n";

    // 2) Duzeltmenin asil kaniti: metne cevrilmis haliyle elemeler calisiyor mu?
    c += "ALERT_NUMBERS.includes -> " + ALERT_NUMBERS.includes(aranan) + "\n";
    const siparisliler = await siparisVerenTelefonlar();
    if (siparisliler === "HATA") {
      c += "Siparis gecmisi: >>> OKUNAMADI <<<\n";
    } else {
      c += "Siparis kumesi : " + siparisliler.size + " telefon, bu numara iceride mi -> " +
        siparisliler.has(aranan) + "\n";
    }

    // 3) Gercek karar.
    const ms = await sonMesajZamani(aranan);
    const yas = ms ? (Date.now() - ms) / 3600000 : 999;
    const { asama, sebep, sil } = await asamaBelirle(aranan, yas);
    c += "Son mesaj     : " + (ms ? yas.toFixed(1) + " saat once" : "kayit yok") + "\n";
    c += "KARAR         : " + (asama === 0 ? "MESAJ YOK" : asama + ". ASAMA GIDERDI") +
      " - " + sebep + "\n";
    c += "Kuyruktan sil : " + !!sil + "\n";
    return res.status(200).send(c);
  } catch (e) {
    return res.status(200).send(c + "\nHATA: " + (e && e.message ? e.message : e));
  }
}

// ============ GERCEK CALISMA ============
module.exports = async (req, res) => {
  if (req.method === "GET" && req.query && req.query.mod === "test") {
    return handleTest(req, res);
  }

  if (req.method === "GET" && req.query && req.query.mod === "karar") {
    return handleKarar(req, res);
  }

  if (req.method === "GET" && req.query && req.query.mod === "siparis-kontrol") {
    return handleSiparisKontrol(req, res);
  }

  if (req.method === "GET" && req.query && req.query.mod === "simdi-gonder") {
    return handleSimdiGonder(req, res);
  }

  if (req.method === "GET" && req.query && req.query.mod === "video-sifirla") {
    return handleVideoSifirla(req, res);
  }

  if (req.method !== "POST") return res.status(200).send("OK");

  const secret = req.query && req.query.secret;
  if (secret !== SECRET) {
    console.error("TAKIP: gecersiz secret");
    return res.status(401).send("Unauthorized");
  }

  // Sessiz saat: hicbir sey gondermeden cik. Kuyruk olduğu gibi kaliyor.
  if (sessizSaatteMiyiz()) {
    const s = turkiyeSaati();
    console.log("TAKIP: sessiz saat (" + s + ":00), gonderim yok");
    return res.status(200).send(
      "OK - sessiz saat (" + s + ":00). Gonderim " + SESSIZ_BITIS +
      ":00 - " + SESSIZ_BASLANGIC + ":00 arasinda yapiliyor."
    );
  }

  siparisTelefonCache = null;

  try {
    const adaylar = await adaylariGetir();
    console.log("TAKIP: kuyruktaki aday sayisi:", adaylar.length);

    let gonderilen1 = 0, gonderilen2 = 0;
    const detaylar = [];

    for (const telefon of adaylar) {
      if (gonderilen1 + gonderilen2 >= PARTI_LIMITI) {
        console.log("TAKIP: parti limiti doldu, kalanlar sonraki calismada");
        break;
      }

      const ms = await sonMesajZamani(telefon);
      const yas = ms ? (Date.now() - ms) / 3600000 : 999;
      const { asama, sebep, sil } = await asamaBelirle(telefon, yas);

      if (asama === 0) {
        if (sil) {
          await kuyruktanSil(telefon);
          console.log("TAKIP ELENDI (" + telefon + "):", sebep);
        }
        continue;
      }

      if (asama === 1) {
        const durum = await serbestMetinGonder(telefon, ASAMA1_METIN);
        // Bayrak gonderim basarisiz olsa da atiliyor: mukerrer pazarlama
        // mesaji riskini tekrar deneme kazancina tercih etmiyoruz.
        await bayrakAt(BAYRAK1 + telefon, BAYRAK_OMRU);
        // Hediye sozu verildi: 48 saat icinde siparis gelirse hem siteden
        // (siparis-kayit.js etiketler) hem bottan (chat.js bildirime not
        // duser) kremin eklenecegi biliniyor.
        await bayrakAt(HEDIYE_SOZU + telefon, HEDIYE_OMRU);
        await bayrakAt(TAKIP_SOHBET + telefon, TAKIP_SOHBET_OMRU);
        console.log("TAKIP ASAMA-1 (" + telefon + "):", durum, "|", sebep);
        await logTakipToSheets(1, telefon, durum);
        gonderilen1++;
        detaylar.push(telefon + ":ASAMA1");
      } else {
        const durum = await sablonGonder(telefon);
        await bayrakAt(BAYRAK2 + telefon, BAYRAK_OMRU);
        await bayrakAt(TAKIP_SOHBET + telefon, TAKIP_SOHBET_OMRU);
        await kuyruktanSil(telefon);   // bu kisiyle isimiz bitti
        console.log("TAKIP ASAMA-2 INDIRIM (" + telefon + "):", durum, "|", sebep);
        await logTakipToSheets(2, telefon, durum);
        gonderilen2++;
        detaylar.push(telefon + ":ASAMA2-INDIRIM");
      }

      await new Promise(r => setTimeout(r, 300)); // WhatsApp'i yormayalim
    }

    const ozet = adaylar.length + " aday bakildi, " + gonderilen1 + " hediye metni, " +
      gonderilen2 + " indirim sablonu gonderildi" +
      (detaylar.length ? " - " + detaylar.join(", ") : "");
    console.log("TAKIP OZET:", ozet);
    return res.status(200).send("OK - " + ozet);
  } catch (error) {
    console.error("TAKIP HATA:", error && error.message ? error.message : error);
    return res.status(200).send("OK - hata: " + (error && error.message ? error.message : error));
  }
};
