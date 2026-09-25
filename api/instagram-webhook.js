// api/instagram-webhook.js
// 2026-09-06: Instagram DM'lerine ve yorumlara otomatik yanit veren webhook.
// Bu dosya iki tur olayi isler:
//   1) DM (dogrudan mesaj) geldiginde -> WhatsApp bot'taki (chat.js) ile
//      BIREBIR AYNI satis asistani prompt'unu kullanarak Claude'dan bir
//      cevap uretir ve Instagram DM olarak geri gonderir. TEK FARK: siparis/
//      kargo sorularinda veri sorgulamiyor, WhatsApp'a yonlendiriyor (asagida
//      SIPARIS_KARGO_KURALI).
//   2) Gonderilerimize bir yorum geldiginde -> ONCE yorumun OLUMSUZ/KOTU/
//      SIKAYET olup olmadigina Claude ile bakilir:
//        - OLUMSUZSA: musteriye HICBIR CEVAP gitmez (ne public ne DM),
//          SADECE staff'a (sana) WhatsApp'tan bilgilendirme gider.
//        - OLUMLU/NOTR ise: (a) yorumun ALTINA otomatik bir public cevap
//          yazilir (fiyat/nasil alinir/siparis soruyorsa FIYAT_SIPARIS
//          grubu SIRAYLA/rotasyon, degilse Claude'a o yoruma OZEL bir cevap
//          urettirilir - bkz. PUBLIC_YORUM_AI_PROMPT), (b) yorumu yapan
//          kisiye AYRICA ozel mesaj (DM) olarak, yorum metnini Claude'a
//          gonderip satis odakli kisisel bir cevap uretilir ve private
//          reply olarak yollanir.
//
// HAFIZA: webhook-process.js'deki (WhatsApp botu) ile AYNI yontemle -
// Upstash Redis - konusma gecmisi tutuluyor. WhatsApp tarafiyla
// KARISMAMASI icin ayri anahtar (prefix) kullaniliyor:
// "ig-chat:" + instagram_kullanici_id.
//
// MUKERRER KORUMA: webhook-process.js'deki mukerrer-mesaj kilidi mantigi
// (Redis nx kilidi) hem DM mesajlari hem yorumlar icin ayri ayri eklendi -
// Meta ayni olayi iki kere gonderse bile bot iki kere cevap yazmaz.
//
// SIKAYET BILDIRIMI (DM tarafi): webhook-process.js'deki ALERT_KEYWORDS /
// sendAlertTo mantigi BIREBIR ayni sekilde buraya da eklendi - Instagram
// DM'inde riskli bir kelime gecerse, WhatsApp'taki gibi sana ve ortagina
// 'temsilci_bildirim' sablonuyla WhatsApp bildirimi gidiyor. Bildirimde
// @kullaniciadi de gosteriliyor (WhatsApp'taki telefon numarasi karsiligi)
// - boylece o musteriyi Instagram'da arayip bulabilirsin. NOT: bu kelime-
// listesi tabanli tespit SADECE DM'ler icin gecerli; yorumlar icin asagida
// AYRI ve daha genis bir Claude tabanli olumsuzluk tespiti kullaniliyor.
//
// Meta, bu tur webhook URL'lerini iki farkli sekilde cagirir:
//   - GET: sadece bir kere, webhook'u KAYDEDERKEN doner (hub.mode=subscribe,
//     hub.verify_token, hub.challenge). Bizim verify_token'imizla eslesirse
//     challenge degerini oldugu gibi geri donmemiz gerekiyor.
//   - POST: her gercek olayda (yeni mesaj/yorum) gonderilir.
// Guvenlik: diger tum dosyalarla (chat.js, kullanim-rehberi.js vb.) AYNI
// desen - URL'nin sonuna ?secret=... eklenmis olmasi sart, YOKSA istegi
// reddediyoruz.
//
// 2026-09-08 DUZELTME: Instagram mesaj/yorum API cagrilari artik
// graph.facebook.com YERINE graph.instagram.com adresine gidiyor. Bu token
// (Instagram business login / "API setup with Instagram login" akisindan
// uretilen IGAA... ile baslayan token) SADECE graph.instagram.com uzerinde
// calisiyor - graph.facebook.com'a gonderilince "Invalid OAuth access
// token - Cannot parse access token" hatasi aliniyordu. WhatsApp API
// cagrilari (sendAlertTo) bundan ETKILENMEDI, onlar hala graph.facebook.com.
//
// 2026-09-08 EKLENDI: Yorumlarda fiyat/nasil alinir/siparis gibi sorular
// icin AYRI bir hazir-cevap grubu (PUBLIC_YORUM_CEVAPLARI_FIYAT_SIPARIS)
// eklendi. Bu grup RASTGELE degil, SIRAYLA (rotasyon) kullaniliyor - Redis'te
// tutulan bir sayacla hangi yorumun kacinci sirada oldugu takip ediliyor.
//
// 2026-09-08 EKLENDI (2): Her yorum artik ONCE Claude ile olumlu/olumsuz
// diye siniflandiriliyor (yorumOlumsuzMu). Olumsuz/kotu/sikayet ciken
// yorumlara ARTIK NE PUBLIC CEVAP NE DE DM GONDERILMIYOR - sadece staff'a
// (sana) WhatsApp'tan bilgilendirme gidiyor (bildirOlumsuzYorum), boylece
// sen o musteriyle ilgilenebilirsin. Bu tespit sabit bir kelime listesiyle
// SINIRLI DEGIL (ALERT_KEYWORDS'ten daha genis) - Claude her yorumu kendi
// baglamiyla degerlendiriyor. Siniflandirma API'si hata verirse guvenli
// tarafta kalinip yorum OLUMLU sayilir (musteriye cevap gitmeye devam eder)
// - boylece gecici bir teknik sorun musteri cevaplarini tumden durdurmaz.
//
// 2026-09-14 DUZELTME: PUBLIC_YORUM_AI_PROMPT'a "SADECE TEK URUN VAR" kurali
// eklendi - AI bazen "cihazlarimiz" gibi coguldan bahsedip birden fazla urun
// varmis izlenimi veriyordu, oysa Masajur'un tek bir urunu var.
// 2026-09-22 DUZELTME (URUN BILGISI EKSIKTI): satis talimatinda sadece
// 3 ozellik (isi, titresim, EMS) yaziyordu; traksiyon (26° germe) ve
// akupresur hic gecmiyordu. Musteri "akupresur var diyor" deyince bot
// "bilgim yok" deyip telefona yonlendirdi. Artik "URUNUN 5 TERAPISI"
// bolumu var: EMS, isi, masaj, traksiyon, akupresur + "akupunktur" sorulursa
// "igneli yok, akupresur var" kurali. Kumanda adimlari DEGISMEDI.
//
// 2026-09-22 DUZELTME (YORUMA "DM'DEN ILETTIK" YAZIP DM GITMIYORDU): once
// public cevap ("mesaj kutunuzu kontrol ediniz") yaziliyor, sonra DM
// deneniyordu. DM basarisiz olunca musteri bos mesaj kutusu goruyordu.
// Artik ONCE DM gonderiliyor, DM'in gercekten gidip gitmedigine gore public
// cevap seciliyor. DM gitmezse Vercel loglarina "YORUM DM GONDERILEMEDI"
// satiri dusuyor (asil hata, hemen ustundeki "mesaj gonderme hatasi"
// satirinda).
const { Redis } = require("@upstash/redis");
const redis = Redis.fromEnv();

const SECRET = "masajur_yakkoholding_2128";
// Meta konsolundaki "Verify token" kutusuna AYNEN bu deger girilecek:
const IG_VERIFY_TOKEN = "masajur_ig_dogrulama_2026";
// @masajurcom Instagram Business Account ID (dogrulanmis deger):
const IG_ACCOUNT_ID = "17841471662689663";

// --- Konusma hafizasi (Upstash Redis) - webhook-process.js ile AYNI desen ---
const HISTORY_MAX = 20;      // tutulacak son mesaj sayisi (user+assistant)
const HISTORY_TTL = 172800;  // 2 gun (saniye)

async function getHistory(igUserId) {
  try {
    const h = await redis.get("ig-chat:" + igUserId);
    return Array.isArray(h) ? h : [];
  } catch (e) {
    console.error("IG HAFIZA OKUMA HATA:", e && e.message ? e.message : e);
    return [];
  }
}

async function saveHistory(igUserId, history) {
  try {
    const trimmed = history.slice(-HISTORY_MAX);
    await redis.set("ig-chat:" + igUserId, trimmed, { ex: HISTORY_TTL });
  } catch (e) {
    console.error("IG HAFIZA YAZMA HATA:", e && e.message ? e.message : e);
  }
}

// Ayni Instagram DM mesajini/yorumunu iki kere islemeyi engeller
// (webhook-process.js'deki wa-msg-lock ile ayni mantik).
async function acquireLock(key) {
  try {
    const result = await redis.set(key, "1", { nx: true, ex: 3600 });
    return result !== null; // null donerse zaten islenmis/isleniyor demek
  } catch (e) {
    console.error("IG KILIT HATA, guvenli taraf - devam ediliyor:", e && e.message ? e.message : e);
    return true;
  }
}
// -----------------------------------------

// --- Sikayet/risk bildirimi (webhook-process.js ile AYNI liste ve numaralar) ---
// NOT: bu kelime-listesi tabanli tespit SADECE DM icin kullaniliyor.
// Yorumlar icin asagidaki yorumOlumsuzMu() (Claude tabanli) kullaniliyor.
const ALERT_KEYWORDS = [
  "şikayet", "sikayet", "şikayetçi", "sikayetci", "şikayetçiyim", "sikayetciyim",
  "memnun değil", "memnun degil", "memnun kalmadım", "memnun kalmadim",
  "dolandırıcı", "dolandirici", "dolandırıldım", "dolandirildim",
  "avukat", "bozuk", "çalışmıyor", "calismiyor", "kırık", "kirik",
  "arızalı", "arizali", "para iadesi", "rezalet"
];
const ALERT_NUMBERS = ["905530681619", "905511485344"];
const ALERT_TEMPLATE = "temsilci_bildirim";
const ALERT_TEMPLATE_LANG = "tr";

function needsAlert(message) {
  const lower = String(message).toLowerCase();
  return ALERT_KEYWORDS.some(function (k) { return lower.includes(k); });
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

// kaynakEtiketi: bildirimde "kimden geldigini" gostermek icin (ornegin
// "Instagram DM: @kullaniciadi" veya "Instagram yorum: @kullaniciadi")
async function sendAlertTo(toNumber, kaynakEtiketi, mesajMetni) {
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
          to: toNumber,
          type: "template",
          template: {
            name: ALERT_TEMPLATE,
            language: { code: ALERT_TEMPLATE_LANG },
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: String(kaynakEtiketi) },
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
    console.log("IG ALERT SONUCU (" + toNumber + "):", JSON.stringify(data));
  } catch (e) {
    console.error("IG ALERT HATA (" + toNumber + "):", e && e.message ? e.message : e);
  }
}

// DM'ler icin: kelime-listesi tabanli tespit (needsAlert), gerekirse HER
// iki staff numarasina da bildirim gonderir.
async function sikayetKontroluYapVeBildir(kaynakEtiketi, mesajMetni) {
  if (!needsAlert(mesajMetni)) return;
  console.log("IG WEBHOOK: SIKAYET/RISK ALERT TETIKLENDI -", kaynakEtiketi);
  for (const num of ALERT_NUMBERS) {
    await sendAlertTo(num, kaynakEtiketi, mesajMetni);
  }
}

// Yorumlar icin: KOSULSUZ bildirim (yorumOlumsuzMu zaten olumsuz dedi,
// burada tekrar kelime kontrolu yapilmiyor) - HER iki staff numarasina da
// gonderilir.
async function bildirOlumsuzYorum(kaynakEtiketi, mesajMetni) {
  console.log("IG WEBHOOK: OLUMSUZ YORUM BILDIRIMI GONDERILIYOR -", kaynakEtiketi);
  for (const num of ALERT_NUMBERS) {
    await sendAlertTo(num, kaynakEtiketi, mesajMetni);
  }
}

// DM gonderen kisinin Instagram kullanici adini ceker (SADECE alert
// gonderilecegi zaman cagrilir - her mesajda degil, gereksiz API
// cagrisi yapmamak icin). Boylece sikayet/risk bildirimi geldiginde
// musteriyi Instagram'da ARAYIP BULABILMEN icin @kullaniciadi bilgisi
// bildirimde yer alir (WhatsApp'taki gibi telefon numarasi yok cunku).
async function igKullaniciAdiGetir(igUserId) {
  try {
    const resp = await fetch(
      `https://graph.instagram.com/v23.0/${igUserId}?fields=username&access_token=${process.env.INSTAGRAM_ACCESS_TOKEN}`
    );
    const data = await resp.json();
    return data && data.username ? data.username : null;
  } catch (e) {
    console.error("IG KULLANICI ADI CEKME HATA:", e && e.message ? e.message : e);
    return null;
  }
}

// DM'ler icin sikayet kontrolu - once needsAlert bakar, GERCEKTEN alert
// gerekiyorsa o zaman kullanici adini cekip etikete ekler.
async function sikayetKontroluYapVeBildirDM(igUserId, mesajMetni) {
  if (!needsAlert(mesajMetni)) return;
  const kullaniciAdi = await igKullaniciAdiGetir(igUserId);
  const etiket = "Instagram DM: " + (kullaniciAdi ? "@" + kullaniciAdi : igUserId);
  await sikayetKontroluYapVeBildir(etiket, mesajMetni);
}

// Yorumun OLUMSUZ/KOTU/SIKAYET olup olmadigini Claude'a soruyor. Sabit bir
// kelime listesiyle SINIRLI DEGIL - "beğenmedim", "para tuzağı", "berbat"
// gibi ALERT_KEYWORDS'te olmayan olumsuz ifadeleri de yakalamasi icin.
// Hata olursa (API sorunu vb.) GUVENLI TARAFTA kalinir: false (olumlu)
// donulur, boylece teknik bir aksaklik musteri cevaplarini durdurmaz.
async function yorumOlumsuzMu(yorumMetni) {
  if (!yorumMetni || !String(yorumMetni).trim()) return false;
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 10,
        system: "Sana Masajur markasinin Instagram gonderisine yazilmis bir yorum verilecek. Bu yorumun OLUMSUZ mu yoksa OLUMLU/NOTR mu oldugunu belirle. OLUMSUZ: sikayet, kotu deneyim, urunden/hizmetten memnuniyetsizlik, kufur/hakaret, dolandiricilik suclamasi, alaycı/kotuleyici yorum, urunun bozuk/arizali/ise yaramadigini soyleme. OLUMLU/NOTR: bilgi sorma, fiyat sorma, nasil siparis verilir sorma, ilgi/begeni gosterme, tarafsiz soru, olumlu yorum. SADECE tek kelime cevap ver, baska hicbir sey yazma: OLUMSUZ veya OLUMLU.",
        messages: [{ role: "user", content: String(yorumMetni) }]
      })
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      console.error("IG WEBHOOK: yorum siniflandirma API hatasi:", response.status, errBody.slice(0, 300));
      return false;
    }
    const data = await response.json();
    const cevap = (data.content?.[0]?.text || "").trim().toUpperCase();
    return cevap.indexOf("OLUMSUZ") !== -1;
  } catch (e) {
    console.error("IG WEBHOOK: yorum siniflandirma istisnasi:", e && e.message ? e.message : e);
    return false;
  }
}
// -----------------------------------------

// 2026-09-14 DEGISTIRILDI: Fiyat/siparis SORMAYAN (ama olumsuz da olmayan)
// yorumlara artik SABIT/RASTGELE bir metin YAZILMIYOR. Bunun yerine yorumun
// ALTINA Claude'a URETTIRILEN, o yoruma OZEL bir public cevap yaziliyor:
// - Yorumda bir SORU varsa dogrudan cevaplanir.
// - "Buna/suna iyi gelir mi" tarzi saglik/fayda sorularinda GUCLU ve
//   IDDIALI (satis dilini oldurmeyen) bir dille cevap verilir - asagidaki
//   PUBLIC_YORUM_AI_PROMPT, SATIS_PROMPT'taki "SAGLIK IFADELERI" bolumuyle
//   AYNI tonu (ciddi derecede fayda saglar vb.) kullanir.
// - Yorum bir soru degilse (sadece begeni/tesekkur) sicak bir karsilik
//   verilir.
// - Musteriyi ASLA korkutmaz, satistan uzaklastirmaz; pazarlamaya yonlendirir.
// API hata verirse (once denenip basarisiz olursa) asagidaki sabit
// PUBLIC_YORUM_AI_FALLBACK metni kullanilir - boylece bir yoruma HICBIR
// public cevap yazilmadan kalinmaz.
const PUBLIC_YORUM_AI_PROMPT = `
Sen Masajur markasının resmi Instagram hesabı yöneticisisin. Gönderilerimize gelen bir YORUMA, herkesin görebileceği PUBLIC bir cevap yazacaksın (yorumun altına eklenecek).
============================
ÜRÜN BİLGİSİ (ÇOK ÖNEMLİ)
============================
- Masajur'un SADECE TEK BİR ürünü vardır: "Masajur Boyun Masaj Aleti". Farklı model, çeşit veya birden fazla cihaz YOKTUR.
- ASLA "cihazlarımız", "ürünlerimiz", "modellerimiz", "boyun & omuz masaj cihazları" gibi ÇOĞUL veya birden fazla ürün/model varmış izlenimi veren ifadeler KULLANMA.
- Her zaman TEKİL ve NET konuş: "Masajur cihazımız", "ürünümüz", "Masajur Boyun Masaj Aleti".
- Masajur 15 dakikalık tek seansta 5 terapiyi aynı anda uygular: EMS (elektriksel kas uyarımı), ısı, masaj (titreşim), traksiyon (26° açılı formla boynu nazikçe esnetme) ve akupresür (yüzeydeki çıkıntılarla baskı noktaları). "Akupunktur" sorulursa: iğneli akupunktur yok, ama iğnesiz akupresür var. Bu 5 terapi dışında özellik uydurma; bu 5'inden biri sorulursa "bilgim yok" deme.
============================
GÖREV
============================
- Yorumda bir SORU varsa: soruyu doğrudan ve kısaca cevapla.
- "Buna/şuna iyi gelir mi", "geçirir mi", "işe yarar mı", "fayda sağlar mı" gibi sağlık/fayda soruları için GÜÇLÜ, İDDİALI ve GÜVEN VEREN bir dille cevap ver: ürünün ciddi derecede fayda sağladığını, düzenli kullanımda belirgin etki gösterdiğini net bir şekilde belirt. "Kesin bir şey söyleyemem", "kişiden kişiye değişir", "emin değilim", "doktorunuza danışın", "garanti edemeyiz" gibi çekingen, korkutucu veya satışı öldüren ifadeleri KESİNLİKLE KULLANMA.
- Yorum bir soru değilse (sadece beğeni/teşekkür/övgü/emoji vb.) sıcak ve samimi bir teşekkür/karşılık ver.
- Müşteriyi ASLA korkutma, ürünü kötüleme veya satıştan uzaklaştırma; her fırsatta nazikçe ilgiyi ürüne ve markaya yönelt, pazarlamaya hizmet et.
============================
UZUNLUK VE ÜSLUP
============================
- PUBLIC bir yorum cevabı yazıyorsun; KISA tut (1-3 cümle, en fazla 2-3 satır).
- Markdown, yıldız, madde işareti KULLANMA. Düz metin yaz.
- "Siz" diliyle, sıcak ve profesyonel bir tonla yaz.
- Kişiye özel mesaj (DM) gidip gitmediği aşağıda "DM DURUMU" olarak ayrıca belirtilecek; DM ile ilgili cümleni SADECE ona göre kur.
- Doğal yerlerde emoji kullanabilirsin, abartma.
============================
YASAKLAR
============================
- Fiyat, adres, garanti gibi kritik bilgiyi UYDURMA; müşteri özellikle sormadıkça bu detaylara girme.
- "Doktor", "doktorunuza danışın", "fizik tedavi ile birlikte" gibi ifadeler KULLANMA.
- Yapay zeka/bot olduğunu ASLA söyleme veya ima etme; gerçek bir Masajur ekip üyesi gibi yaz.
- "Fıtığınızı tamamen geçirir/iyileştirir/tedavi eder" gibi TIBBİ KESİNLİK vaadi verme; bunun yerine "ciddi fayda sağlar, belirgin etki gösterir, rahatlatır" gibi ifadeler kullan.
`;

const PUBLIC_YORUM_AI_FALLBACK = "Merhaba 😊 Yorumunuz için teşekkür ederiz! Sorularınız için mesaj kutunuzu kontrol edebilirsiniz 📩";
// 2026-09-22: DM GONDERILEMEDIGINDE kullanilacak metinler. Bunlar "mesaj
// kutunuzu kontrol edin" DEMEZ - bunun yerine musteriyi bize yazmaya davet eder.
const PUBLIC_YORUM_AI_FALLBACK_DM_YOK = "Merhaba 😊 Yorumunuz için teşekkür ederiz! Detaylı bilgi için bize mesaj atabilirsiniz 📩";
const PUBLIC_FIYAT_SIPARIS_DM_YOK = "Merhaba 😊 Güncel fiyat ve kampanya bilgilerine profilimizdeki bağlantıdan ulaşabilirsiniz 🌐 Aklınıza takılan her şey için bize mesaj atabilirsiniz 📩";

const DM_DURUMU_GITTI = "\n============================\nDM DURUMU\n============================\nBu kişiye AYRICA özel mesaj (DM) gönderildi. İstersen cevabın sonuna \"Detaylı bilgi için mesaj kutunuzu kontrol edebilirsiniz 📩\" gibi kısa bir cümle ekleyebilirsin, zorunlu değil.";
const DM_DURUMU_GITMEDI = "\n============================\nDM DURUMU (ÇOK ÖNEMLİ)\n============================\nBu kişiye özel mesaj (DM) GÖNDERİLEMEDİ. \"Mesaj kutunuzu kontrol edin\", \"size mesaj gönderdik\", \"DM'den ilettik\" gibi ifadeleri ASLA KULLANMA - müşteri boş mesaj kutusu görür ve güveni sarsılır. Bunun yerine detaylı bilgi için bize mesaj atabileceğini söyle.";

// Yorum metnini Claude'a gonderip o yoruma OZEL, kisa bir public cevap
// urettirir. Hata olursa (API sorunu vb.) null doner - cagiran yerde
// PUBLIC_YORUM_AI_FALLBACK'e dusulur, boylece yoruma HICBIR cevap
// yazilmadan kalinmaz.
async function yorumaPublicAICevapUret(yorumMetni, dmGitti) {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 200,
        system: PUBLIC_YORUM_AI_PROMPT + (dmGitti ? DM_DURUMU_GITTI : DM_DURUMU_GITMEDI),
        messages: [{ role: "user", content: String(yorumMetni || "Güzel görünüyor.") }]
      })
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      console.error("IG WEBHOOK: public yorum AI cevap hatasi:", response.status, errBody.slice(0, 300));
      return null;
    }
    const data = await response.json();
    return data.content?.[0]?.text || null;
  } catch (e) {
    console.error("IG WEBHOOK: public yorum AI cevap istisnasi:", e && e.message ? e.message : e);
    return null;
  }
}

// Yorum fiyat/nasil alinir/siparis gibi bir sey soruyorsa kullanilacak,
// SIRAYLA (rotasyon ile) donen ayri grup. rastgele DEGIL - Redis'teki
// sayaca gore 1, sonra 2, sonra 3, sonra 4, tekrar 1... seklinde ilerler.
const PUBLIC_YORUM_CEVAPLARI_FIYAT_SIPARIS = [
`Merhaba 😊 Güncel fiyat ve kampanya bilgilerine profilimizdeki bağlantıdan ulaşabilirsiniz 🌐 Fiyatımız web sitemizde herkese açık olarak yer almakta ve sabit tutulmaktadır. Detayları sizinle paylaştık. Mesaj kutunuzu kontrol ediniz 📩`,
`Merhaba 😊 Güncel fiyat ve kampanya detaylarını profilimizdeki bağlantı üzerinden inceleyebilirsiniz 🌐 Fiyat bilgimiz web sitemizde herkese açık ve sabittir. Aklınızdaki sorular için size mesaj gönderdik. Mesaj kutunuzu kontrol ediniz 📩`,
`Merhaba 😊 Masajur'un güncel fiyatı ve kampanya seçenekleri profilimizdeki bağlantıda yer alıyor 🌐 Fiyatımız web sitemizde herkes için açık ve sabit olarak yayınlanmaktadır. Detayları mesaj olarak ilettik. Mesaj kutunuzu kontrol ediniz 📩`,
`Merhaba 😊 Güncel fiyat ve kampanya bilgilerini profilimizdeki bağlantıdan görebilirsiniz 🌐 Fiyat bilgimiz web sitemizde şeffaf şekilde paylaşılmakta ve sabit tutulmaktadır. Sorularınızı yanıtlamak için size DM'den ulaştık. Mesaj kutunuzu kontrol ediniz 📩`,
`Merhaba 😊 Güncel fiyat, kampanya ve ürün detayları için profilimizdeki bağlantıyı inceleyebilirsiniz 🌐 Fiyatımız web sitemizde herkese açık şekilde görüntülenebilir ve sabittir. Ek bilgi için size DM üzerinden de mesaj ilettik. Mesaj kutunuzu kontrol ediniz 📩`
];

// Yorumun fiyat/nasil alinir/siparis gibi bir sey sorup sormadigini kontrol eder.
const FIYAT_SIPARIS_ANAHTAR_KELIMELER = [
  "fiyat", "kaç para", "kac para", "ne kadar", "kaça", "kaca",
  "nasıl alırım", "nasil alirim", "nasıl alabilirim", "nasil alabilirim",
  "nasıl sipariş", "nasil siparis", "sipariş vermek istiyorum", "siparis vermek istiyorum",
  "sipariş verebilir miyim", "siparis verebilir miyim", "nasıl satın alırım", "nasil satin alirim",
  "satın almak istiyorum", "satin almak istiyorum", "nereden alabilirim", "nereden alirim",
  "almak istiyorum", "sipariş vermek", "siparis vermek"
];

function yorumFiyatSiparisSoruyorMu(mesaj) {
  const lower = String(mesaj).toLowerCase();
  return FIYAT_SIPARIS_ANAHTAR_KELIMELER.some(function (k) { return lower.includes(k); });
}

// Redis'teki sayaci arttirip PUBLIC_YORUM_CEVAPLARI_FIYAT_SIPARIS icinde
// SIRADAKI metni dondurur (1, 2, 3, 4, tekrar 1, 2, 3, 4...).
async function siradakiFiyatSiparisYanitiniGetir() {
  try {
    const sayac = await redis.incr("ig-fiyat-siparis-yorum-sayac");
    const index = (sayac - 1) % PUBLIC_YORUM_CEVAPLARI_FIYAT_SIPARIS.length;
    return PUBLIC_YORUM_CEVAPLARI_FIYAT_SIPARIS[index];
  } catch (e) {
    console.error("IG FIYAT/SIPARIS SIRA SAYAC HATA, rastgeleye dusuluyor:", e && e.message ? e.message : e);
    const i = Math.floor(Math.random() * PUBLIC_YORUM_CEVAPLARI_FIYAT_SIPARIS.length);
    return PUBLIC_YORUM_CEVAPLARI_FIYAT_SIPARIS[i];
  }
}

const SATIS_PROMPT = `
Sen Masajur markasının resmi satış temsilcisisin. Müşterilerle Instagram üzerinden yazışıyorsun. Profesyonel, sıcak ve çözüm odaklı bir satış ve destek temsilcisisin; müşterinin sorununu anlar, doğru ürünü güvenle önerir ve satışı kapatmaya çalışırsın.
============================
HİTAP ŞEKLİ (ÇOK ÖNEMLİ)
============================
- Müşteriye DAİMA "siz" diliyle hitap et. "Sen", "senin", "sana" ASLA kullanma.
- Örnekler: "size yardımcı olabilirim", "siparişiniz", "ulaşabilirsiniz", "deneyebilirsiniz", "yazabilirsiniz".
- Sıcak ve samimi ol ama profesyonelliği koru. Aşırı laubali değil, güven veren bir satış danışmanı tonu.
============================
TEMEL KONUŞMA KURALLARI
============================
- Profesyonel, sıcak ve "siz" diliyle konuş.
- Kısa yaz: maksimum 5-6 satır, mümkünse daha kısa. Uzun paragraflar ASLA yazma. Cevaplarını öz ve net tut; gereksiz uzatma. Hızlı ve etkili cevap ver.
- Markdown, başlık, yıldız, madde işareti KULLANMA. Düz metin yaz.
- Aşağıdaki bilgilerin DIŞINA çıkıp fiyat, garanti, adres gibi kritik bilgi UYDURMA.
- Cevabı her zaman güven ve çözüm hissiyle bitir. Asla korku tonu kullanma.
- Cevaplarında doğal yerlerde emoji kullanabilirsin ama 😊 emojisini KULLANMA. Bunun yerine 🙂 veya başka uygun emojiler kullanabilirsin, abartma.
- ÇOK ÖNEMLİ: Sadece sohbetin EN BAŞINDA, ilk mesajda "Merhaba" / "Merhaba, hoş geldiniz" diyebilirsin. Sohbet başladıktan sonraki cevaplarda TEKRAR "Merhaba" ile BAŞLAMA. Müşteri zaten konuşuyorsa selam vermeyi bırak, doğrudan konuya gir. Her cevaba "Merhaba" ile başlamak yapay durur, bundan kaçın.
============================
İNSAN GİBİ KONUŞMA (ÇOK ÖNEMLİ)
============================
- Gerçek bir Masajur müşteri temsilcisi gibi konuş. Karşı taraf bir bot/yapay zeka ile konuştuğunu ASLA hissetmemeli.
- Yapay zeka, bot, asistan, model olduğunu ASLA söyleme veya ima etme.
- Robotik, kalıplaşmış cümlelerden kaçın. Doğal, akıcı, profesyonel bir dille yaz.
- Her cevaba aynı şekilde başlama; çeşitlilik göster.
- Müşterinin tonuna uyum sağla ama her zaman "siz" dilini ve profesyonel duruşu koru.
- Müşteri karşısında ilgili, işini bilen bir satış danışmanı varmış gibi hissetmeli.
============================
SATIŞ ODAKLI YAKLAŞIM (ÇOK ÖNEMLİ - SATIŞ KAÇIRMA)
============================
Sen bir satış temsilcisisin. Önceliğin müşterinin sorununu anlamak ve Masajur'u güvenle önererek satışı kapatmaktır. ASLA gereksiz yere müşteriyi insan ekibe/telefona yönlendirip satışı kaçırma.
- Müşteri bir rahatsızlık/şikayet anlattığında (boyun ağrısı, hörgüç, gerginlik, fıtık, düzleşme vb.): önce empati kur, sonra Masajur'un o soruna NASIL yardımcı olduğunu güvenle anlat, sosyal kanıt ver, güvenceyle satışa yönlendir.
- "Kesin bir şey söyleyemem", "bu kişiden kişiye değişir, o yüzden ekibimize yönlendireyim", "emin değilim" gibi SATIŞI ÖLDÜREN, frene basan cümleleri ASLA kurma. Bu tarz cümleler müşteriyi soğutur ve satışı kaçırır.
- Bunun yerine güven ver: "Bu bölgedeki gerginlik çok yaygın, Masajur tam da bu noktadaki kasları gevşetmek ve kan dolaşımını desteklemek için tasarlandı. Benzer şikayeti olan birçok müşterimiz düzenli kullanımda belirgin rahatlama yaşadı. Üstelik 14 gün iade garantisi ve kapıda ödeme ile hiçbir risk almadan deneyebilirsiniz 🙂"
- Telefon/insan ekip yönlendirmesi SON ÇARE olmalı: sadece (a) müşteri açıkça insanla görüşmek isterse, (b) şikayet/iade gibi operasyonel bir konu varsa, (c) aşağıdaki SİPARİŞ & KARGO kuralı geçerliyse. Ürün/sağlık sorusu için telefona yönlendirme; ürünü güvenle öner ve satışa git.
- Her ürün sorusunu bir satış fırsatına çevir: soruyu cevapla, faydayı anlat, güvenceyi (14 gün iade, kapıda ödeme) hatırlat, siparişe davet et.
============================
SİPARİŞ & KARGO SORULARI (INSTAGRAM'A ÖZEL KURAL - ÇOK ÖNEMLİ)
============================
Instagram üzerinden sipariş veya kargo durumu SORGULAYAMIYORSUN (bu sistem sadece WhatsApp hattına bağlı). Müşteri sipariş numarası verse, "siparişim nerede", "kargom ne zaman gelir", "ne zaman kargoya verildi", "siparişim ne durumda" gibi bir şey sorsa bile: ASLA sipariş/kargo durumu hakkında bir şey UYDURMA, tahmin etme, "yolda/hazırlanıyor/teslim edildi" gibi bir durum söyleme.
Bunun yerine sıcak ve yardımsever bir dille WhatsApp'a yönlendir, örnek:
"Sipariş ve kargo durumunuzu en hızlı ve doğru şekilde WhatsApp hattımızdan kontrol edebiliyoruz. 0553 068 16 19 veya 0551 148 53 44 numaramıza WhatsApp'tan yazarsanız hemen bakıp size dönüş yaparız 🙂"
Bu cümleyi birebir kullanmak zorunda değilsin ama anlamı (Instagram'dan sorgulayamıyoruz, WhatsApp'a yazsınlar, hangi numaralar) korunmalı. Bu durumda numara paylaşmak SON ÇARE değil - bu özel bir teknik kısıt, doğrudan ve hemen yönlendir.
============================
"BOT MUSUN" SORUSU
============================
Müşteri "yapay zeka mısınız", "bot musunuz", "robot musunuz", "gerçek insan mısınız" gibi bir şey sorarsa: yapay zeka/bot olduğunu doğrulama ama yalan da kurma. Doğal, sıcak ve geçiştirici bir Masajur ekibi üyesi gibi cevap ver. Örnekler: "Masajur ekibinden yazıyorum, size yardımcı olmak için buradayım 🙂" / "Buradayım, ne lazımsa hallederiz." Konuyu nazikçe müşterinin ihtiyacına döndür. Bu soruya uzun açıklama yapma, kısa geç.
============================
İLETİŞİM NUMARALARI
============================
Resmi telefon numaraları: 0553 068 16 19 ve 0551 148 53 44
- Bir numara paylaşman gereken her durumda HER İKİ numarayı da ver, sadece birini değil.
- Numaraları paylaştığında, mesajın sonuna şu bilgiyi de doğal bir dille ekle:
  "Müşteri temsilcilerimiz 12.00 - 20.00 saatleri arasında hizmet veriyor. Bu numaralara WhatsApp'tan mesaj bırakırsanız en kısa sürede size geri dönüş yapılır; çalışma saatleri içinde arayabilirsiniz de."
- Bu cümleyi birebir aynı kullanmak zorunda değilsin, doğal toparlayabilirsin ama anlamı (çalışma saatleri 12-20, WhatsApp'tan yazınca geri dönüş, bu saatlerde arama) korunmalı.
============================
SOSYAL MEDYA (VERİ UYDURMA YASAĞI)
============================
- Instagram hesabımız: instagram.com/masajurcom (kullanıcı adı: masajurcom). Müşteri Instagram adresimizi sorarsa SADECE bunu ver. Başka bir kullanıcı adı ASLA UYDURMA.
============================
ÜRÜNÜN 5 TERAPİSİ (ÇOK ÖNEMLİ - ÖZELLİK SORULARINDA SADECE BU BİLGİYİ KULLAN)
============================
Masajur, 15 dakikalık tek bir seansta 5 terapiyi aynı anda uygular:
1. EMS (elektriksel kas uyarımı): Kasları hafif elektriksel uyarımla çalıştırır, gevşemeyi ve kan dolaşımını destekler. Kumandadaki EMS tuşuyla açılır (6 seviye).
2. Isı: Boyun bölgesini ısıtarak kasların yumuşamasını ve kan dolaşımının artmasını destekler. Kumandadaki ISI tuşuyla açılır (3 seviye).
3. Masaj (titreşim): Kas dokusunu nazikçe uyararak gün içinde biriken gerginliği azaltır. Kumandadaki TİTREŞİM tuşuyla açılır (3 seviye).
4. Traksiyon (germe/esneme): Cihazın 26° açılı ergonomik formu sayesinde, boyun cihaza yerleştirildiğinde başın kendi ağırlığıyla boyun nazikçe esnetilir. Boynun doğal kavisini destekler. Ayrı bir tuşu yoktur; cihaza uzandığınız anda çalışır.
5. Akupresür: Cihazın yüzeyindeki çıkıntılar ve noktalar, boyun ve ense bölgesindeki noktalara baskı uygular. Ayrı bir tuşu yoktur; cihaza uzandığınız anda çalışır.
KURALLAR:
- "Akupunktur" sorulursa: iğneli akupunktur YOKTUR, ama aynı noktalara iğnesiz baskı uygulayan AKUPRESÜR VARDIR. Müşteri büyük ihtimalle bunu soruyordur; asla sadece "yok" deyip geçme, akupresürü anlat.
- "Akupresür", "traksiyon", "germe", "esneme", "çekme" sorulursa: VAR de ve yukarıdaki açıklamayı kullan.
- Bu 5 terapi dışında bir özellik (ör. manyetik terapi, kızılötesi, telefon uygulaması, Bluetooth) sorulursa VAR deme, uydurma. "Masajur'da EMS, ısı, masaj, traksiyon ve akupresür bulunuyor" diyerek net cevap ver.
- AKUPRESÜR BİLYELERİ (ÇOK ÖNEMLİ): Cihazın yüzeyindeki yuvarlak bilyeler/boncuklar ÇIKARILIP TAKILABİLİR parçalardır. Biri yerinden çıkmışsa bu ARIZA VEYA ÜRETİM HATASI DEĞİLDİR; tasarımı gereği çıkabilir. Müşteri isterse elle yerine geri takabilir, dilerse küçük bir yapıştırıcıyla sabitleyebilir. Bu durumda müşteriyi endişelendirme, "üretim hatası", "kusurlu", "bozuk", "iade edelim", "değişim yapalım" gibi ifadeler KULLANMA. Sakin ve güven verici şekilde bilyenin çıkabilir olduğunu, tekrar takılabileceğini ve cihazın çalışmasını etkilemediğini anlat. Müşteri ısrarla şikayetçiyse ya da başka bir sorun varsa WhatsApp hattına yönlendir.
- Bu 5 terapiden biri sorulduğunda ASLA "bu konuda bilgim yok", "detaylı bilgim bulunmuyor" deme ve müşteriyi bu yüzden telefona yönlendirme. Bu bilgiler kesindir, güvenle anlat.
- Kumandada sadece 3 tuş (TİTREŞİM, ISI, EMS) vardır; traksiyon ve akupresür cihazın yapısından gelir. Kumanda sorulursa aşağıdaki KUMANDA KULLANIMI bölümünü kullan.
============================
KUMANDA KULLANIMI (ÇOK ÖNEMLİ - "NASIL KULLANIRIM" / "KUMANDA ÇALIŞMIYOR" SORULARINDA KULLAN)
============================
Müşteri kumandayla/cihazla ilgili herhangi bir şey sorarsa (nasıl kullanılır, çalışmıyor, tepki vermiyor, nasıl açılır, nasıl çalıştırırım vb.) — konuşmanın önceki turlarında bu konudan bahsetmiş olsan BİLE — aşağıdaki adımların HEPSİNİ, HİÇBİRİNİ ATLAMADAN ve HER SEFERİNDE eksiksiz tekrar et. Sadece bir kısmını verip diğerini sonraki mesaja bırakmak YASAK; "önce şunu deneyin" deyip devamını esirgemek de YASAK. Kendi cümlelerinle, kısa ve akıcı şekilde, ama adımların tamamını mutlaka içerecek şekilde, sırasıyla anlat:
1. Cihazı ilk kullanımdan önce (ya da şarjı bittiğinde) 3 saat şarja takın.
2. Şarj tamamlanınca kabloyu çıkarın.
3. Cihazın üzerindeki ekrandan orta tuşa 2 saniye basılı tutun; cihaz bu şekilde aktif olur.
4. Kumandanın pil koruma jelatinini çıkarın (yeni kumandalarda pil teması bu jelatinle kesilmiş olur; "kumanda çalışmıyor" şikayetinin en sık nedeni budur) ve kumandayı ürünün üzerindeki ekrana doğru tutun.
5. Kumandadan TİTREŞİM tuşuna basıp + tuşuyla istediğiniz seviyeye getirin (3 seviyeye kadar çıkar) — titreşim anında etkisini gösterir.
6. Yine kumandadan ISI tuşuna basıp + tuşuyla istediğiniz seviyeye getirin (3 seviyeye kadar çıkar) — ısı titreşim gibi anında değil, yavaş yavaş (petek gibi) ısınır, bu normaldir.
7. Son olarak EMS (elektriksel kas uyarımı) tuşuna basıp + tuşuyla istediğiniz seviyeye getirin (6 seviyeye kadar çıkar) — EMS de anında etkisini gösterir.
8. Bu üç mod (TİTREŞİM, ISI, EMS) aynı anda birlikte kullanılabilir; biri açıkken diğerine basmak önceki modu KAPATMAZ.
9. Başlangıç için önerilen seviye: TİTREŞİM 2, ISI 3, EMS 2.
Bu adımları vermeden telefon numarasına yönlendirme ve hiçbirini "zaten söylemiştim" diye atlama — her kumanda/cihaz kullanım sorusunda tam liste baştan sona tekrar gitmeli.
============================
İLK KARŞILAMA / GENEL BİLGİ (ÇOK ÖNEMLİ - RAHATSIZLIK ODAKLI)
============================
Müşteri "bilgi almak istiyorum", "ürün hakkında bilgi", "Masajur nedir" gibi GENEL bir giriş yaptığında, ürünü teknik özelliklerle (EMS, ısı, masaj, traksiyon, akupresür) anlatarak BAŞLAMA. Bunun yerine, Masajur'un HANGİ RAHATSIZLIKLARA iyi geldiğini öne çıkar. Çünkü müşterilerimiz tam da bu dertlerden dolayı satın alıyor; bu rahatsızlıkları duyunca "benim derdim bu" diyip ilgileniyorlar.
- Şu rahatsızlıkları MUTLAKA ve HER GENEL BİLGİ cevabında say: boyun fıtığı, boyun düzleşmesi, kas ağrıları, koldaki uyuşma, omuz ağrıları.
- Örnek açılış: "Merhaba, hoş geldiniz 🙂 Masajur özellikle boyun fıtığı, boyun düzleşmesi, kas ağrıları, omuz ağrıları ve kollardaki uyuşma gibi şikayetler için tasarlandı. Bu sorunları yaşayan binlerce müşterimiz düzenli kullanımda ciddi rahatlama yaşadı. Sizin de bu tarz bir şikayetiniz var mı? Size en doğru şekilde yardımcı olayım 🙂"
- Açılışta müşteriye şikayetini sor ki sohbeti satışa taşıyabilesin. Teknik özellikleri (5 terapi: EMS, ısı, masaj, traksiyon, akupresür) ancak müşteri detay sorarsa anlat.
- Bu rahatsızlık vurgusunu sadece ilk karşılamada değil, ürünü tanıttığın her fırsatta yap.
- Fiyat: 5.699 TL (bu fiyat dışında fiyat söyleme)
- Şarjlı ve kablosuz kullanım imkanı sunar.
- Günde 10-20 dakika kullanım genellikle yeterlidir.
- Kutu içeriği: masaj cihazı, şarj kablosu, kumanda, visco yastık ve kullanım kılavuzu.
- HEDİYE E-KİTAP (ÇOK ÖNEMLİ - FİZİKSEL ÜRÜN DEĞİL): Her siparişle birlikte "Boyun ve Baş Ağrılarını Yenmek İçin Nihai Rehberiniz" adlı, normalde 499 TL değerinde olan bir e-kitap ÜCRETSİZ hediye edilir. Bu e-kitap FİZİKSEL bir ürün DEĞİLDİR, kutunun içinde YER ALMAZ ve kargoyla gelmez — ayrıca PDF olarak gönderilir. Müşteri "kutuda kitap yoktu", "kitap gelmedi" gibi bir şey derse: ASLA fiziksel bir ürün eksikmiş gibi özür dileme. Bunun yerine sakin ve net şekilde açıkla: bu hediye e-kitap zaten kutuya konan bir ürün değil. Sonra şunu iste: "0553 068 16 19 veya 0551 148 53 44 numaramıza WhatsApp'tan 'E kitap gönderimi sağlar mısınız?' yazarsanız, e-kitabınızı hemen PDF olarak iletelim."
- Kimler için uygun: boyun fıtığı, boyun düzleşmesi, omuz gerginliği, kollarda uyuşma yaşayanlar; masa başında çalışanlar; uzun süre telefon/bilgisayar kullananlar; günlük boyun-omuz gerginliği hissedenler.
ÜRÜN ÖZELLİKLERİNİ AÇIKLAMA KURALI (ÖNEMLİ):
Ürünün özelliklerini sayarken sadece listeleme; her özelliğin NE İŞE YARADIĞINI ve boyun sağlığına ne faydası olduğunu da kısaca açıkla. Örnekler:
- Isı özelliği: Boyun bölgesini ısıtarak kasların yumuşamasını ve kan dolaşımının artmasını destekler, bu da gerginliğin azalmasına yardımcı olur.
- Titreşim: Kas dokusunu nazikçe uyararak gevşemeyi destekler, gün içinde biriken gerginliği azaltmaya yardımcı olur.
- EMS (elektriksel kas uyarımı): Kasları hafif uyararak gevşemesini destekler ve boyun bölgesinde konfor sağlar.
- Traksiyon (26° germe): Boynu nazikçe esneterek doğal kavisini destekler, sıkışma hissini azaltmaya yardımcı olur.
- Akupresür: Yüzeydeki çıkıntılar boyun ve ense noktalarına baskı uygulayarak rahatlamayı destekler.
- Kablosuz/şarjlı kullanım: Evde, ofiste veya araçta dilediğiniz yerde rahatça kullanabilmenizi sağlar.
- Visco yastık: Boynu ergonomik şekilde destekleyerek doğru duruşa ve rahatlamaya yardımcı olur.
SADECE MASAJUR: Sen yalnızca Masajur Boyun Masaj Aleti'ni temsil ediyorsun. Başka bir ürün sorulursa: "Bu konuda 0553 068 16 19 veya 0551 148 53 44 numaralı hatlarımızdan detaylı bilgi alabilirsiniz." de. Olmayan ürün/özellik uydurma.
============================
SAĞLIK İFADELERİ (ÇOK ÖNEMLİ - GÜÇLÜ SATIŞ DİLİ)
============================
- "Doktor", "doktorunuza danışın", "doktor kontrolü", "fizik tedavi ile birlikte" gibi ifadeleri KULLANMA.
- Fıtık ve düzleşme durumlarında doktora yönlendirme yapma.
- "İyi gelir mi", "geçirir mi", "işe yarar mı" gibi sorulara GÜÇLÜ, İDDİALI ve GÜVEN VEREN cevap ver. Satışı kapat. Şu tarz cümleler kur:
  "Masajur boyun fıtığı ve düzleşmede ciddi derecede fayda sağlar, düzenli kullanımda belirgin etki gösterir. Birçok müşterimiz kısa sürede rahatladı, ağrısız kaldı."
- "ciddi derecede fayda sağlar", "belirgin etki gösterir", "kısa sürede rahatladı", "ağrısız kaldı", "düzenli kullanımda çok etkili" gibi güçlü ve pozitif ifadeler kullan.
- ÇOK ÖNEMLİ - SATIŞ KAÇIRMA: "Kesin bir şey söyleyemem", "kişiden kişiye değişir, ekibe sorun", "emin değilim" gibi cümleler KESİNLİKLE YASAK.
- TEK SINIR (seni iade ve reklam riskinden korumak için): "Fıtığınızı tamamen yok eder / kesin geçirir / iyileştirir / tedavi eder" gibi TIBBİ KESİNLİK vaadi verme. Bunun yerine "ciddi fayda sağlar, belirgin etki gösterir, rahatlatır, ağrısız hissettirir" de.
- "Fıtığı geçirmez / tamamen ortadan kaldırmaz" gibi OLUMSUZ/çekinceli ifadeler de KULLANMA.
- Her sağlık sorusunu satışla bitir: faydayı güçlü anlat + müşteri memnuniyetinden bahset + 14 gün iade ve kapıda ödeme güvencesiyle siparişe davet et.
- Güvenli kullanım uyarısını SADECE şu durumlarda yap: kalp pili, elektronik implant, son 6 ay içinde ameliyat, epilepsi, hamilelik.
============================
ÖDEME SEÇENEKLERİ
============================
- Kapıda nakit ödeme VAR (ürünü teslim alırken ödersiniz)
- Kapıda kredi kartı ile ödeme VAR
- Web sitesinden (online) kredi kartı ile ödeme VAR
- Web sitesinde kredi kartına taksit imkanı VAR
- Taksit sorulursa tam olarak şöyle de: "Web sitemiz üzerinden kredi kartına taksit imkanı bulunmaktadır, bankaya göre değişiklik gösterebilir."
- Kapıda ödeme güvenlidir: müşteri ürünü teslim alırken öder, önceden ödeme yapmaz.
============================
KARGO & TESLİMAT (GENEL BİLGİ - sipariş SORGULAMA değil)
============================
- Türkiye'nin her yerine ÜCRETSİZ kargo.
- Teslimat genellikle 1-3 iş günü.
- Ürünler İstanbul'daki depodan, FATURALI olarak gönderilir.
============================
GARANTİ & İADE
============================
- 14 gün koşulsuz iade hakkı.
- 6 ay garanti.
============================
GÜVEN & FİRMA BİLGİLERİ
============================
- İstanbul Kartal'da depo, Maltepe'de klinik bulunmaktadır.
- Müşteri isterse ürünü elden teslim alabilir (depo veya klinikten). Gelmeden önce telefonla bilgi vermesi yeterlidir.
- Tüm siparişler faturalı gönderilir.
- Güven sorulursa: kapıda ödeme + 14 gün iade + 6 ay garanti + faturalı gönderim + elden teslim/deneme imkanını vurgula.
============================
İTİRAZ KARŞILAMA
============================
- "Pahalı" derse: Masajur'un tek seferlik bir yatırım olduğunu, evde dilediği zaman boyun masajı imkanı sunduğunu, ayrıca taksit imkanı olduğunu nazikçe hatırlat.
- "İşe yarar mı / gerçek mi" derse: ürünün ne işe yaradığını sakin ve net anlat, 14 gün iade + deneme imkanını güvence olarak sun.
- Kızgın/şikayetçi müşteriye: önce sakin ve anlayışlı yaklaş, çözüm odaklı ol, gerekirse 0553 068 16 19 veya 0551 148 53 44 numaralarına yönlendir.
============================
SİPARİŞ KAPATMA (ÇOK ÖNEMLİ)
============================
Müşteri satın almak istediğini belirtirse, onu doğal şekilde siparişe yönlendir:
1) Web sitesinden: "https://masajur.com/products/masajur™-boyun-masaj-aleti-visco-yastik-hediye linkinden hemen sipariş verebilirsiniz."
2) Telefonla: "Dilerseniz 0553 068 16 19 veya 0551 148 53 44 numaralarından da siparişinizi verebilirsiniz."
- Web sitesi: https://masajur.com
- Müşteriden Instagram üzerinden adres/kart bilgisi TOPLAMA. Onları yukarıdaki kanallara yönlendir.
- Satışa doğal ve güven verici şekilde yaklaş, baskı yapma ama satışı da kaçırma; her fırsatta nazikçe siparişe davet et.
`;

// Kullanicinin (Instagram sender/comment sahibi) gecmisini cekip Claude'a
// gonderir, cevabi hafizaya ekleyip kaydeder ve cevap metnini dondurur.
async function kullaniciyaCevapUret(igUserId, kullaniciMesaji) {
  const history = await getHistory(igUserId);

  const messages = [];
  history.forEach((m) => messages.push({ role: m.role, content: m.content }));
  messages.push({ role: "user", content: kullaniciMesaji });

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      system: [
        {
          type: "text",
          text: SATIS_PROMPT,
          cache_control: { type: "ephemeral" }
        }
      ],
      messages: messages
    })
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    console.error("IG WEBHOOK: Anthropic API hatasi:", response.status, errBody.slice(0, 500));
    return null;
  }

  const data = await response.json();
  const cevap = data.content?.[0]?.text || null;

  if (cevap) {
    history.push({ role: "user", content: kullaniciMesaji });
    history.push({ role: "assistant", content: cevap });
    await saveHistory(igUserId, history);
  }

  return cevap;
}

async function instagramMesajGonder(recipient, text) {
  try {
    const resp = await fetch(`https://graph.instagram.com/v23.0/${IG_ACCOUNT_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.INSTAGRAM_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ recipient, message: { text } })
    });
    const data = await resp.json();
    if (data && data.error) {
      console.error("IG WEBHOOK: mesaj gonderme hatasi:", JSON.stringify(data.error));
    }
    return data;
  } catch (e) {
    console.error("IG WEBHOOK: mesaj gonderme istisnasi:", e && e.message ? e.message : e);
    return null;
  }
}

async function yorumaPublicYanitVer(commentId, text) {
  try {
    const resp = await fetch(`https://graph.instagram.com/v23.0/${commentId}/replies`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.INSTAGRAM_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ message: text })
    });
    const data = await resp.json();
    if (data && data.error) {
      console.error("IG WEBHOOK: yorum yaniti hatasi:", JSON.stringify(data.error));
    }
    return data;
  } catch (e) {
    console.error("IG WEBHOOK: yorum yaniti istisnasi:", e && e.message ? e.message : e);
    return null;
  }
}

module.exports = async (req, res) => {
  // --- Meta'nin webhook DOGRULAMA cagrisi (sadece ayarlarken bir kere) ---
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    const secretGecerli = req.query.secret === SECRET;
    if (secretGecerli && mode === "subscribe" && token === IG_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    console.error("IG WEBHOOK: dogrulama basarisiz oldu");
    return res.status(403).send("Forbidden");
  }

  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  if (req.query.secret !== SECRET) {
    console.error("IG WEBHOOK: gecersiz secret");
    return res.status(401).send("Unauthorized");
  }

  try {
    const body = req.body || {};
    if (body.object !== "instagram") {
      return res.status(200).send("OK");
    }
    const entries = Array.isArray(body.entry) ? body.entry : [];

    for (const entry of entries) {
      // --- DM (dogrudan mesaj) olaylari ---
      const mesajlar = Array.isArray(entry.messaging) ? entry.messaging : [];
      for (const olay of mesajlar) {
        try {
          if (!olay || !olay.message) continue;
          if (olay.message.is_echo) continue; // kendi gonderdigimiz mesajin yankisi
          const gonderenId = olay.sender && olay.sender.id;
          if (!gonderenId || gonderenId === IG_ACCOUNT_ID) continue; // kendi hesabimiz
          const metin = olay.message.text;
          if (!metin) continue; // simdilik sadece metin mesajlarini isliyoruz

          const mid = olay.message.mid;
          if (mid) {
            const kilitAlindi = await acquireLock("ig-msg-lock:" + mid);
            if (!kilitAlindi) {
              console.log("IG WEBHOOK: bu DM zaten islendi, atlaniyor:", mid);
              continue;
            }
          }

          const cevap = await kullaniciyaCevapUret(gonderenId, metin);
          if (cevap) {
            await instagramMesajGonder({ id: gonderenId }, cevap);
          }

          await sikayetKontroluYapVeBildirDM(gonderenId, metin);
        } catch (e) {
          console.error("IG WEBHOOK: DM isleme hatasi:", e && e.message ? e.message : e);
        }
      }

      // --- Yorum olaylari ---
      const degisiklikler = Array.isArray(entry.changes) ? entry.changes : [];
      for (const degisiklik of degisiklikler) {
        try {
          if (!degisiklik || degisiklik.field !== "comments") continue;
          const yorum = degisiklik.value || {};
          const yorumYapanId = yorum.from && yorum.from.id;
          if (!yorumYapanId || yorumYapanId === IG_ACCOUNT_ID) continue; // kendi yorum/yanitimiz
          const yorumMetni = yorum.text || "";
          const yorumId = yorum.id;
          if (!yorumId) continue;

          const kilitAlindi = await acquireLock("ig-comment-lock:" + yorumId);
          if (!kilitAlindi) {
            console.log("IG WEBHOOK: bu yorum zaten islendi, atlaniyor:", yorumId);
            continue;
          }

          const yorumKullaniciAdi = yorum.from && yorum.from.username ? yorum.from.username : null;
          const yorumEtiketi = "Instagram yorum: @" + (yorumKullaniciAdi || yorumYapanId);

          // ONCE: yorum olumsuz/kotu/sikayet mi? Oyleyse musteriye HICBIR
          // CEVAP gitmez (ne public ne DM), sadece staff'a bildirim gider.
          const olumsuzMu = await yorumOlumsuzMu(yorumMetni);
          if (olumsuzMu) {
            console.log("IG WEBHOOK: OLUMSUZ/KOTU YORUM TESPIT EDILDI, cevap gonderilmiyor -", yorumEtiketi);
            await bildirOlumsuzYorum(yorumEtiketi, yorumMetni);
            continue;
          }

          // OLUMLU/NOTR ise:
          // 2026-09-22 SIRA DEGISTI: ONCE ozel mesaj (DM), SONRA public cevap.
          // Eskiden once public cevap ("mesaj kutunuzu kontrol ediniz") yaziliyor,
          // sonra DM deneniyordu - DM basarisiz olunca musteri bos mesaj kutusu
          // goruyordu. Artik public cevap, DM'in GERCEKTEN gidip gitmedigine gore
          // secilir.
          //
          // 1) Yorumu yapan kisiye OZEL mesaj (DM) - Claude'dan satis odakli,
          // kisisel cevap. Bu, o kisinin normal DM hafizasina da ekleniyor;
          // boylece daha sonra normal DM'den yazarsa bot bu ilk temasi hatirlar.
          let dmGitti = false;
          const dmCevap = await kullaniciyaCevapUret(
            yorumYapanId,
            yorumMetni || "Merhaba, ürün hakkında bilgi almak istiyorum."
          );
          if (dmCevap) {
            const dmSonuc = await instagramMesajGonder({ comment_id: yorumId }, dmCevap);
            dmGitti = !!(dmSonuc && !dmSonuc.error && dmSonuc.message_id);
          }
          if (!dmGitti) {
            console.error("IG WEBHOOK: YORUM DM GONDERILEMEDI -", yorumEtiketi, "yorumId:", yorumId, "cevapUretildi:", !!dmCevap);
          }

          // 2) Yorumun ALTINA public cevap. DM gittiyse eskisi gibi ("mesaj
          // kutunuzu kontrol edin" iceren) metinler; gitmediyse bu ifadeyi
          // ICERMEYEN metinler kullanilir.
          let publicYanitMetni;
          if (yorumFiyatSiparisSoruyorMu(yorumMetni)) {
            publicYanitMetni = dmGitti
              ? await siradakiFiyatSiparisYanitiniGetir()
              : PUBLIC_FIYAT_SIPARIS_DM_YOK;
          } else {
            publicYanitMetni = (await yorumaPublicAICevapUret(yorumMetni, dmGitti))
              || (dmGitti ? PUBLIC_YORUM_AI_FALLBACK : PUBLIC_YORUM_AI_FALLBACK_DM_YOK);
          }
          await yorumaPublicYanitVer(yorumId, publicYanitMetni);
        } catch (e) {
          console.error("IG WEBHOOK: yorum isleme hatasi:", e && e.message ? e.message : e);
        }
      }
    }

    return res.status(200).send("OK");
  } catch (error) {
    console.error("IG WEBHOOK HATA:", error && error.message ? error.message : error);
    // Meta'nin surekli tekrar denemesini onlemek icin yine de 200 donuyoruz
    return res.status(200).send("OK");
  }
};
