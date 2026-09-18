// api/sepet-kurtarma.js
// YARIM KALAN SEPET KURTARMA
//
// Musteri sitede ad/soyad/telefon girip odeme adimina geliyor ama siparisi
// tamamlamadan cikiyor. Shopify bunu "terk edilmis odeme" (abandoned checkout)
// olarak kaydediyor. Bu dosya o kayitlari tarayip musteriye WhatsApp'tan
// hatirlatma gonderiyor.
//
// IKI ASAMALI:
//   1) Terk edildikten 1 SAAT sonra  -> "sepetinde urun var, tamamla"  (sepet_hatirlatma)
//   2) Hala tamamlamadiysa 3 SAAT sonra -> "479 TL'lik krem hediye"    (sepet_hediye)
// Musteri AYNI sepeti tamamlarsa Shopify o kaydi listeden dusuruyor.
// AMA bu yetmiyor - bkz. asagidaki "SIPARIS VERMIS MUSTERI" notu.
//
// IZIN NOTU: terk edilmis sepetler "read_orders" kapsami altinda
// (Shopify'in kendi tanimi: "Siparisleri, islemleri, gonderimleri ve YARIM
// BIRAKILMIS ODEMELERI goruntuleme"). Ayri bir izin GEREKMIYOR.
//
// GUVENLIK RAYLARI (bilincli kararlar):
// - SIPARIS_GECMISI_GUN: son 30 gunde SIPARIS VERMIS bir telefona hic mesaj
//   gitmiyor. (2026-09-18'de eklendi, gercek bir olay uzerine - asagida.)
// - MAX_YAS_SAAT: 24 saatten eski sepetlere HIC dokunulmuyor. Ilk deploy'da
//   gecmisteki onlarca eski sepete toplu mesaj gitmesini engelliyor.
// - PARTI_LIMITI: tek calismada en fazla 10 mesaj. Ani mesaj patlamasi
//   WhatsApp numarasinin kalite puanini dusurur.
// - Sepet basina her asamadan SADECE BIR mesaj (Redis bayragi).
// - ALERT_NUMBERS (kendi numaralarimiz) atlanir.
//
// TEST MODU: GET ?mod=test&secret=...  -> hicbir mesaj GONDERMEZ, sadece
// "su an kime ne gonderilecekti" listesini duz metin olarak yazar. Once
// bununla telefonlarin duzgun geldigini dogrula, sonra gercek moda gec.
//
// GERCEK CALISMA: POST ?secret=...  (QStash Schedule ile 15 dakikada bir)

const { Redis } = require("@upstash/redis");
const redis = Redis.fromEnv();

const SECRET = "masajur_yakkoholding_2128";
const API_VERSION = "2026-04";           // diger dosyalarla ayni

// --- Zamanlama ---
const ASAMA1_SAAT = 1;                   // hatirlatma
const ASAMA2_SAAT = 3;                   // hediye teklifi
const MAX_YAS_SAAT = 24;                 // bundan eski sepetlere dokunma
// 2026-09-18: HER SEPET IKI MESAJI DA ALIR. Ama sistem devreye girdiginde
// zaten 3 saati gecmis sepetler var; onlara 1. mesaji gonderip 15 dakika
// sonra 2. mesaji gondermek kotu bir deneyim olurdu. Bu yuzden 2. mesaj
// hem "sepet 3 saati gecmis" hem de "1. mesajin uzerinden en az 2 saat
// gecmis" sartini birlikte ariyor. Yeni bir sepette ikisi de dogal olarak
// saglaniyor (1. saatte mesaj, 3. saatte ikincisi = 2 saat ara).
const MIN_MESAJ_ARALIGI_SAAT = 2;

// --- Guvenlik sinirlari ---
const PARTI_LIMITI = 10;                 // tek calismada en fazla kac mesaj

// --- SIPARIS VERMIS MUSTERI KONTROLU ---
// 2026-09-18, GERCEK OLAY: Ibrahim O. bir gun once siparisini vermisti. Ertesi
// gun siteye tekrar girdi ve yeni bir sepet birakti. O YENI sepetin
// completed_at'i bos oldugu icin kod "bu kisi almamis" sandi ve "sepetini
// tamamla" mesaji gonderdi. Ikinci mesaji da alsaydi daha kotu olurdu:
// "sana ozel 479 TL'lik krem hediye" - bir gun once TAM FIYAT odemis adama.
//
// Yani sepetin kendi completed_at'ine bakmak YETMIYOR; o TELEFONDAN yakin
// zamanda siparis gelip gelmedigine bakmak gerekiyor.
//
// Neden Shopify'a soruyoruz da Redis bayragi kullanmiyoruz: bayragi
// siparis-kayit.js dusurse ancak BUGUNDEN SONRAKI siparisleri bilirdik,
// Ibrahim gibi gecmiste siparis vermis olanlar bir ay boyunca acikta kalirdi.
// Shopify'a sormak gecmise donuk de calisiyor.
//
// MALIYET: bu sorgu sadece gercekten mesaj gonderilecek bir aday varsa
// yapiliyor (asamaBelirle'de en son kontrol). Cogu calismada aday olmadigi
// icin hic Shopify istegi atilmiyor.
const SIPARIS_GECMISI_GUN = 30;
const SIPARIS_SAYFA_LIMITI = 8;          // 8 x 250 = 2000 siparis tavan

// --- WhatsApp sablonlari ---
const SEPET1_TEMPLATE = "sepet_hatirlatma";
const SEPET1_LANG = "tr";
const SEPET2_TEMPLATE = "sepet_hediye";
// DIL KODU NOTU: bu sablon Meta'da yanlislikla "English" olarak kaydedildi
// (metin Turkce, sadece etiketi ingilizce - kapidan_donen_kurtarma ile ayni
// durum). WhatsApp bu etiketi ceviri icin kullanmiyor, sablonda ne yaziyorsa
// onu gonderiyor; bu yuzden sablonu silip yeniden olusturmak yerine dil
// kodunu "en" biraktik. sepet_hatirlatma normal sekilde "tr".
const SEPET2_LANG = "en";

// Kendi numaralarimiza mesaj gitmesin
const ALERT_NUMBERS = ["905530681619", "905511485344"];

// --- Redis bayraklari ---
const BAYRAK1 = "sepet-asama1:";         // <checkout id>
const BAYRAK2 = "sepet-asama2:";         // <checkout id>
const HEDIYE_SOZU = "hediye-sozu:";      // <telefon> - siparis gelince etiketlemek icin
// 2026-09-18: TELEFON BAZLI KILIT. Gercek veride ayni musteri 1 dakika
// arayla IKI ayri sepet acmis (Ayla F. - 31298247393370 ve 31298252701786).
// Bayrak sadece sepet numarasina bagli olsaydi ayni kisiye ayni mesajdan
// iki tane giderdi. Bu anahtar "bu telefona hangi sepet icin mesaj attik"
// bilgisini tutuyor: baska bir sepet icin tekrar mesaj gitmiyor, ama AYNI
// sepetin 2. asama mesaji engellenmiyor.
const TELEFON_KILIDI = "sepet-telefon:";  // <telefon> -> checkout id
const BAYRAK_OMRU = 7 * 24 * 3600;       // 7 gun
const TELEFON_OMRU = 24 * 3600;          // 24 saat
const HEDIYE_OMRU = 48 * 3600;           // 48 saat

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// teslim-kontrol.js'teki ile AYNI mantik
function normalizeTelefon(raw) {
  if (!raw) return "";
  let d = String(raw).replace(/[^0-9]/g, "");
  if (!d) return "";
  if (d.startsWith("0")) d = "90" + d.slice(1);
  if (!d.startsWith("90")) d = "90" + d;
  return d;
}

// WhatsApp sablon parametreleri satir sonu/sekme/4+ bosluk iceremez
function temizleParam_(v, varsayilan) {
  var s = String(v == null ? "" : v)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!s) return varsayilan;
  return s.slice(0, 200);
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

// Terk edilmis sepetteki musteri adini bul (birkac yerde olabiliyor)
function musteriAdiCikar(c) {
  const cust = c.customer || {};
  const ad = ((cust.first_name || "") + " " + (cust.last_name || "")).trim();
  if (ad) return ad;
  const addr = c.shipping_address || c.billing_address || {};
  const addrAd = ((addr.first_name || "") + " " + (addr.last_name || "")).trim();
  if (addrAd) return addrAd;
  return addr.name || "";
}

// Telefon birkac alanda olabiliyor - hepsine bak
function telefonCikar(c) {
  const cust = c.customer || {};
  const ship = c.shipping_address || {};
  const bill = c.billing_address || {};
  return normalizeTelefon(c.phone || ship.phone || bill.phone || cust.phone);
}

// Shopify'dan son N saatte olusmus terk edilmis sepetleri cek
async function fetchTerkEdilmisSepetler(saat) {
  const minDate = new Date(Date.now() - saat * 3600 * 1000).toISOString();
  const url = `https://${process.env.SHOPIFY_STORE}/admin/api/${API_VERSION}/checkouts.json` +
    `?limit=250&created_at_min=${encodeURIComponent(minDate)}`;
  const r = await fetchWithTimeout(url, {
    headers: {
      "X-Shopify-Access-Token": process.env.SHOPIFY_TOKEN,
      "Content-Type": "application/json"
    }
  }, 20000);
  if (!r.ok) {
    const govde = await r.text().catch(() => "");
    throw new Error("Shopify checkouts.json HTTP " + r.status + " - " + govde.slice(0, 300));
  }
  const data = await r.json().catch(() => ({}));
  return Array.isArray(data.checkouts) ? data.checkouts : [];
}

// Shopify sayfalama: "link" basligindaki rel="next" adresini cikar.
// Ornek: <https://...orders.json?page_info=xyz>; rel="next"
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

// Son SIPARIS_GECMISI_GUN gunde siparis vermis TELEFONLARIN kumesi.
//
// Cache: Vercel ayni container'i tekrar kullanabildigi icin bu degisken
// calismalar arasi hayatta kalabilir. Bayat veriyle karar vermemek icin
// HER ISTEGIN BASINDA null'a cekiliyor (bkz. handleTest ve module.exports).
// Boylece tek bir calisma icinde en fazla bir kez Shopify'a gidiliyor.
//
// Doner: Set  (basarili)  |  "HATA"  (Shopify'a ulasilamadi)
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
        const t = telefonCikar(o);   // siparislerde de ayni alanlar var
        if (t) kume.add(t);
      }
      url = sonrakiSayfaUrl(r.headers.get("link"));
      sayfa++;
    }

    console.log("SEPET-KURTARMA: son " + SIPARIS_GECMISI_GUN + " gunde siparis veren " +
      kume.size + " telefon bulundu (" + sayfa + " sayfa)");
    siparisTelefonCache = kume;
    return kume;
  } catch (e) {
    // GUVENLI TARAF: siparis gecmisini okuyamadiysak mesaj GONDERME.
    // Zaten almis birine "tamamla" / "sana hediye" yazmak, mesajin hic
    // gitmemesinden cok daha kotu.
    console.error("SEPET-KURTARMA: siparis gecmisi okunamadi (MESAJ GONDERILMIYOR):",
      e && e.message ? e.message : e);
    siparisTelefonCache = "HATA";
    return "HATA";
  }
}

// Sepetin kac saattir bekledigini hesapla
function yasSaat(c) {
  const t = c.updated_at || c.created_at;
  if (!t) return 0;
  return (Date.now() - new Date(t).getTime()) / 3600000;
}

async function bayrakVar(anahtar) {
  try {
    const v = await redis.get(anahtar);
    return !!v;
  } catch (e) {
    // Redis erisilemezse GUVENLI TARAF: mesaj GONDERME.
    // Mukerrer pazarlama mesaji, hic mesaj gitmemesinden cok daha kotu.
    return true;
  }
}
async function bayrakAt(anahtar, omur) {
  try { await redis.set(anahtar, "1", { ex: omur }); } catch (e) {}
}
async function degerOku(anahtar) {
  try {
    const v = await redis.get(anahtar);
    return v == null ? "" : String(v);
  } catch (e) {
    // Redis okunamiyorsa guvenli taraf: "baska bir sepet icin kilitli" say,
    // mesaj gonderme.
    return "REDIS-HATASI";
  }
}
async function degerYaz(anahtar, deger, omur) {
  try { await redis.set(anahtar, String(deger), { ex: omur }); } catch (e) {}
}

// WhatsApp sablon mesaji gonder
async function sablonGonder(phone, templateName, lang, ad, link) {
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
          to: phone,
          type: "template",
          template: {
            name: templateName,
            language: { code: lang },
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: temizleParam_(ad, "değerli müşterimiz") },
                  { type: "text", text: temizleParam_(link, "https://masajur.com") }
                ]
              }
            ]
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

// Sepet mesajlarini eski BOTSohbet Sheets dosyasina yaz ("Sepet Kurtarma" sekmesi).
// 2026-09-18: Apps Script'e type:"sepet_mesaji" dali eklendi ve deploy edildi,
// bu yuzden acildi. Apps Script'te bu dal YOKSA satirlar "Sayfa1"e (musteri
// konusmalari) coop olarak duser - o yuzden ikisi birlikte guncellenmeli.
//
// TEKRAR DENEME YOK (#12558 dersi): Apps Script cevabi bize ulasmasa bile
// satiri cogu zaman ZATEN eklemis oluyor.
const SHEETS_SEPET_LOG = true;
async function logSepetToSheets(asama, checkoutId, ad, telefon, tutar, durum) {
  try {
    if (!SHEETS_SEPET_LOG) return;
    if (!process.env.SHEETS_URL) return;
    await fetchWithTimeout(process.env.SHEETS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "sepet_mesaji",
        asama: String(asama),
        checkoutId: String(checkoutId || ""),
        name: String(ad || ""),
        phone: String(telefon || ""),
        tutar: String(tutar || ""),
        status: String(durum || "")
      })
    }, 15000);
  } catch (e) {
    console.error("SEPET: Sheets log HATA (TEKRAR DENENMIYOR):", e && e.message ? e.message : e);
  }
}

// SON KONTROL: mesaj gonderilecek gibi gorunuyor - once bu numaradan yakin
// zamanda siparis gelmis mi diye bak. Bilerek en sona birakildi: Shopify
// siparis sorgusu sadece gercek bir aday varsa calissin.
async function siparisKontroluGec(telefon, asama, sebep) {
  const siparisliler = await siparisVerenTelefonlar();
  if (siparisliler === "HATA") {
    return { asama: 0, sebep: "siparis gecmisi okunamadi, guvenli taraf" };
  }
  if (siparisliler.has(telefon)) {
    return { asama: 0, sebep: "bu numaradan son " + SIPARIS_GECMISI_GUN + " gunde siparis var" };
  }
  return { asama: asama, sebep: sebep };
}

// Bir sepet icin hangi asamada oldugumuzu belirle.
// Doner: { asama: 0|1|2, sebep: "..." }
//   0 -> simdilik bir sey yapma
async function asamaBelirle(c, telefon) {
  const yas = yasSaat(c);

  if (!telefon) return { asama: 0, sebep: "telefon yok" };
  if (ALERT_NUMBERS.includes(telefon)) return { asama: 0, sebep: "kendi numaramiz" };
  if (yas > MAX_YAS_SAAT) return { asama: 0, sebep: "cok eski (" + yas.toFixed(1) + " saat)" };
  if (c.completed_at) return { asama: 0, sebep: "zaten tamamlanmis" };

  if (yas < ASAMA1_SAAT) return { asama: 0, sebep: "henuz erken (" + yas.toFixed(1) + " saat)" };

  // TELEFON KILIDI: bu numaraya baska bir sepet icin mesaj attiysak dur.
  // Ayni sepetin devami ise (kilit bu sepete aitse) devam edilebilir.
  const kilit = await degerOku(TELEFON_KILIDI + telefon);
  if (kilit && kilit !== String(c.id)) {
    return { asama: 0, sebep: "bu numaraya baska sepet icin mesaj gitti (" + kilit + ")" };
  }

  const b2 = await bayrakVar(BAYRAK2 + c.id);
  if (b2) return { asama: 0, sebep: "iki mesaj da gonderilmis" };

  // 1. ASAMA: 1 saati gecmis ve daha once hatirlatma gitmemis her sepet.
  // BAYRAK1 icinde gonderim zamani (ms) tutuluyor - 2. mesajin araligini
  // hesaplayabilmek icin.
  const b1 = await degerOku(BAYRAK1 + c.id);
  if (!b1) {
    return await siparisKontroluGec(telefon, 1, yas.toFixed(1) + " saat oldu, hatirlatma");
  }
  if (b1 === "REDIS-HATASI") {
    return { asama: 0, sebep: "Redis okunamadi, guvenli taraf" };
  }

  // 2. ASAMA: sepet 3 saati gecmis OLACAK ve 1. mesajin uzerinden en az
  // MIN_MESAJ_ARALIGI_SAAT gecmis OLACAK.
  const gecenSaat = (Date.now() - Number(b1)) / 3600000;
  if (yas >= ASAMA2_SAAT && gecenSaat >= MIN_MESAJ_ARALIGI_SAAT) {
    return await siparisKontroluGec(telefon, 2,
      "1. mesajdan " + gecenSaat.toFixed(1) + " saat gecti, hediye");
  }
  if (yas < ASAMA2_SAAT) {
    return { asama: 0, sebep: "1. mesaj gitti, sepet " + yas.toFixed(1) + " saatlik (3 bekleniyor)" };
  }
  return { asama: 0, sebep: "1. mesajdan " + gecenSaat.toFixed(1) + " saat gecti (" + MIN_MESAJ_ARALIGI_SAAT + " bekleniyor)" };
}

// ============ TEST MODU (hicbir mesaj gondermez) ============
async function handleTest(req, res) {
  const secret = req.query && req.query.secret;
  if (secret !== SECRET) return res.status(401).send("Unauthorized");

  siparisTelefonCache = null;   // bayat siparis listesiyle karar verme
  res.setHeader("Content-Type", "text/plain; charset=utf-8");

  if (!process.env.SHOPIFY_STORE || !process.env.SHOPIFY_TOKEN) {
    return res.status(200).send("HATA: SHOPIFY_STORE veya SHOPIFY_TOKEN tanimli degil");
  }

  try {
    const sepetler = await fetchTerkEdilmisSepetler(MAX_YAS_SAAT + 24);
    let cikti = "=== TERK EDILMIS SEPETLER (TEST MODU - HICBIR MESAJ GONDERILMEDI) ===\n";
    cikti += "Shopify'dan donen kayit sayisi: " + sepetler.length + "\n";
    cikti += "Kurallar: " + ASAMA1_SAAT + ". saatte hatirlatma, " + ASAMA2_SAAT +
      ". saatte hediye, " + MAX_YAS_SAAT + " saatten eskiye dokunulmaz\n";

    // Siparis gecmisi sorgusunu test modunda HER ZAMAN calistir. Gercek
    // calismada bu sorgu sadece mesaj adayi varsa yapiliyor; ama burada
    // amac "sorgu calisiyor mu" sorusunu sepetlerden bagimsiz cevaplamak.
    const siparisliler = await siparisVerenTelefonlar();
    if (siparisliler === "HATA") {
      cikti += "SIPARIS GECMISI : >>> OKUNAMADI <<< - bu haldeyken HICBIR MESAJ GITMEZ.\n";
      cikti += "                  Vercel loglarinda 'siparis gecmisi okunamadi' satirina bak.\n\n";
    } else {
      cikti += "Siparis gecmisi : son " + SIPARIS_GECMISI_GUN + " gunde siparis veren " +
        siparisliler.size + " telefon bulundu - bu numaralara mesaj gitmez\n\n";
    }

    if (sepetler.length === 0) {
      cikti += "Hic terk edilmis sepet yok.\n\n" +
        "Bu normal olabilir (son 48 saatte kimse yarim birakmamis) ama telefonlarin\n" +
        "gelip gelmedigini anlamak icin siteden kendin bir deneme yapabilirsin:\n" +
        "sepete urun ekle, odeme adiminda ad/telefon gir, sayfayi kapat, 10 dk sonra\n" +
        "bu adresi tekrar ac.";
      return res.status(200).send(cikti);
    }

    let sayac = 0;
    for (const c of sepetler) {
      const telefon = telefonCikar(c);
      const ad = musteriAdiCikar(c);
      const { asama, sebep } = await asamaBelirle(c, telefon);
      if (asama > 0) sayac++;

      cikti += "-----------------------------------------\n";
      cikti += "Checkout ID : " + c.id + "\n";
      cikti += "Musteri     : " + (ad || "(isim yok)") + "\n";
      cikti += "Telefon     : " + (telefon || ">>> TELEFON YOK <<<") + "\n";
      cikti += "Tutar       : " + (c.total_price || "?") + " " + (c.currency || "") + "\n";
      cikti += "Terk zamani : " + (c.updated_at || c.created_at) + " (" + yasSaat(c).toFixed(1) + " saat once)\n";
      cikti += "Kurtarma    : " + (c.abandoned_checkout_url ? c.abandoned_checkout_url.slice(0, 110) + "..." : ">>> LINK YOK <<<") + "\n";
      cikti += "KARAR       : " + (asama === 0 ? "MESAJ YOK" : asama + ". ASAMA MESAJI GIDERDI") + " - " + sebep + "\n";
    }

    cikti += "-----------------------------------------\n\n";
    cikti += "OZET: " + sepetler.length + " sepetin " + sayac + " tanesine su an mesaj gonderilecekti.\n\n";
    cikti += "KONTROL LISTESI:\n";
    cikti += "  1) Telefonlar '90...' seklinde dolu mu? Bos geliyorsa Shopify kisisel veri erisimi sorunu var.\n";
    cikti += "  2) Kurtarma linkleri dolu mu?\n";
    cikti += "  3) Isimler dogru mu?\n";
    cikti += "  4) Yukaridaki 'Siparis gecmisi' satirinda makul bir sayi var mi?\n";
    cikti += "     '>>> OKUNAMADI <<<' yaziyorsa Shopify siparis sorgusu calismiyor\n";
    cikti += "     demektir - o durumda hicbir mesaj GITMEZ.\n";
    cikti += "Dordu de tamamsa gercek moda gecebiliriz.\n";

    return res.status(200).send(cikti);
  } catch (error) {
    return res.status(200).send(
      "HATA: " + (error && error.message ? error.message : error) + "\n\n" +
      "HTTP 401/403 goruyorsan: token yanlis ya da kisisel veri erisimi kapali.\n" +
      "HTTP 404 goruyorsan: API surumu (" + API_VERSION + ") bu magaza icin gecersiz olabilir."
    );
  }
}

// ============ GERCEK CALISMA ============
module.exports = async (req, res) => {
  if (req.method === "GET" && req.query && req.query.mod === "test") {
    return handleTest(req, res);
  }

  if (req.method !== "POST") return res.status(200).send("OK");

  const secret = req.query && req.query.secret;
  if (secret !== SECRET) {
    console.error("SEPET-KURTARMA: gecersiz secret");
    return res.status(401).send("Unauthorized");
  }

  if (!process.env.SHOPIFY_STORE || !process.env.SHOPIFY_TOKEN) {
    console.error("SEPET-KURTARMA: SHOPIFY_STORE/SHOPIFY_TOKEN tanimli degil");
    return res.status(200).send("OK - shopify bilgisi yok");
  }

  siparisTelefonCache = null;   // bayat siparis listesiyle karar verme

  try {
    const sepetler = await fetchTerkEdilmisSepetler(MAX_YAS_SAAT + 6);
    console.log("SEPET-KURTARMA: donen sepet sayisi:", sepetler.length);

    let gonderilen1 = 0, gonderilen2 = 0;
    const detaylar = [];

    for (const c of sepetler) {
      if (gonderilen1 + gonderilen2 >= PARTI_LIMITI) {
        console.log("SEPET-KURTARMA: parti limiti doldu, kalanlar sonraki calismada");
        break;
      }

      const telefon = telefonCikar(c);
      const ad = musteriAdiCikar(c);
      const { asama } = await asamaBelirle(c, telefon);
      if (asama === 0) continue;

      const link = c.abandoned_checkout_url || "";
      if (!link) {
        console.log("SEPET-KURTARMA: kurtarma linki yok, atlandi:", c.id);
        continue;
      }

      if (asama === 1) {
        const durum = await sablonGonder(telefon, SEPET1_TEMPLATE, SEPET1_LANG, ad, link);
        // Bayrak, gonderim basarisiz olsa da atiliyor: mukerrer pazarlama
        // mesaji riskini tekrar deneme kazancina tercih etmiyoruz.
        // Zaman damgasi yaziliyor: 2. mesajin araligi buradan hesaplaniyor.
        await degerYaz(BAYRAK1 + c.id, Date.now(), BAYRAK_OMRU);
        await degerYaz(TELEFON_KILIDI + telefon, c.id, TELEFON_OMRU);
        console.log("SEPET ASAMA-1 (" + c.id + " / " + telefon + "):", durum);
        await logSepetToSheets(1, c.id, ad, telefon, c.total_price, durum);
        gonderilen1++;
        detaylar.push(c.id + ":ASAMA1");
      } else if (asama === 2) {
        const durum = await sablonGonder(telefon, SEPET2_TEMPLATE, SEPET2_LANG, ad, link);
        await bayrakAt(BAYRAK2 + c.id, BAYRAK_OMRU);
        await degerYaz(TELEFON_KILIDI + telefon, c.id, TELEFON_OMRU);
        // Hediye sozu verildi: bu telefondan 48 saat icinde siparis gelirse
        // siparis-kayit.js Shopify'da siparisi "hediye-krem" diye etiketleyecek.
        await bayrakAt(HEDIYE_SOZU + telefon, HEDIYE_OMRU);
        console.log("SEPET ASAMA-2 HEDIYE (" + c.id + " / " + telefon + "):", durum);
        await logSepetToSheets(2, c.id, ad, telefon, c.total_price, durum);
        gonderilen2++;
        detaylar.push(c.id + ":ASAMA2-HEDIYE");
      }

      await new Promise(r => setTimeout(r, 300)); // WhatsApp'i yormayalim
    }

    const ozet = sepetler.length + " sepet bakildi, " + gonderilen1 + " hatirlatma, " +
      gonderilen2 + " hediye mesaji gonderildi" +
      (detaylar.length ? " - " + detaylar.join(", ") : "");
    console.log("SEPET-KURTARMA OZET:", ozet);
    return res.status(200).send("OK - " + ozet);
  } catch (error) {
    console.error("SEPET-KURTARMA HATA:", error && error.message ? error.message : error);
    return res.status(200).send("OK - hata: " + (error && error.message ? error.message : error));
  }
};
