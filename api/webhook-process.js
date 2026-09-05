// api/webhook-process.js
// QStash tarafindan (webhook.js'in devrettigi) cagrilir. Asil is burada:
// Shopify siparis + Yurtici kargo + Claude -> WhatsApp cevabi.
// Bu dosyanin webhook.js'den ayri olmasinin tek sebebi: Meta'nin 5sn
// kuralindan bagimsiz olarak, Yurtici/Claude yavas oldugunda bile rahat
// calisabilsin (vercel.json'da bu fonksiyona artik 90sn suresi tanimli -
// hesap Vercel Pro'da, bkz. 2026-09-05 notu asagida).
//
// Yurtici Kargo sorgusu artik ../lib/yurtici.js'deki ORTAK istemciyi kullanir
// (webhook-process.js, teslim-kontrol.js ve yorum.js ayni koddan besleniyor -
// QuotaGuard proxy + devre kesici + retry mantigi tek yerde).
//
// + Her mesaj Google Sheets'e kaydedilir (SHEETS_URL).
// + Riskli kelimelerde yetkililere 'temsilci_bildirim' sablonu gonderilir.
// + Konusma hafizasi (Upstash Redis): son mesajlar hatirlanir.
// + Mukerrer isleme korumasi (Redis kilidi, wamid bazli): QStash veya Meta
//   ayni mesaji birden fazla kez teslim etse bile bot ayni soruya sadece
//   BIR KERE cevap yazar.
//
// 2026-09-05 DUZELTME (musterilerin gordugu "kisa bir yogunluk yasiyoruz"
// mesaji cok sik cikiyordu): Claude'a (chat.js) giden ic istege sadece 9
// SANIYE sure taniniyordu - yapay zeka cevabi (ozellikle uzun cevaplarda
// veya yogun saatlerde) bundan kolayca uzun surebiliyor, bu da GERCEK bir
// yogunluk olmasa bile musteriye otomatik "yogunluk" mesaji gitmesine yol
// aciyordu. Hesap artik Vercel Pro'da ve bu fonksiyonun suresi 90 saniyeye
// cikarildigi icin: (1) chat.js'e taninan sure 9sn -> 40sn'ye cikarildi,
// (2) musteriye giden asil WhatsApp cevabi gonderimi eskiden HICBIR zaman
// asimi olmadan (sinirsiz bekleyebilen ciplak bir fetch ile) yapiliyordu -
// bu da teorik olarak fonksiyonu sonsuza kadar bekletip QStash'in mesaji
// tekrar denemesine (ve mukerrer cevaba) yol acabilirdi; artik diger tum
// WhatsApp cagrilarindaki gibi zaman asimli (15sn) yapiliyor.
//
// 2026-09-05 IKINCI (KRITIK) DUZELTME: jsonFetch() basarisiz HTTP
// durumlarini (4xx/5xx) kontrol etmiyordu, bu yuzden /api/chat herhangi bir
// nedenle (Anthropic API hatasi, gecersiz cevap, coken istek) basarisiz
// oldugunda, gercek musteriye GUZEL "yogunluk" mesaji DEGIL, chat.js'in ic
// fallback metni olan cıplak "Yanıt oluşturulamadı." yazisi WHATSAPP
// CEVABI OLARAK gonderiliyordu. Artik jsonFetch basarisiz HTTP durumunda
// hata firlatiyor, boylece asagidaki catch bloku devreye girip dogru
// "yogunluk" mesajini gonderiyor. Ayrica bkz. api/chat.js'teki es zamanli
// duzeltme (Anthropic cevabini kontrol etme).

const { Redis } = require("@upstash/redis");
const redis = Redis.fromEnv();
const yurtici = require("../lib/yurtici");

const BASE = "https://masajur-ai-proxy.vercel.app";
const SECRET = "masajur_yakkoholding_2128";

// ============================================================
// YURTICI KARGO SORGUSU (../lib/yurtici.js ile ORTAK istemci)
// ============================================================
// Musteri sohbeti oldugu icin teslim-kontrol.js/yorum.js'in arka plan
// devre kesicisinden AYRI anahtar kullanir - biri tikanirsa digeri etkilenmez.
const cb = yurtici.createCircuitBreaker("yurtici-cb-canli");

function ykParseXml(raw, key) {
  if (!raw) return { found: false, reason: "not_found", orderNumber: key };

  const operationMessage = raw.operationMessage;
  const operationStatus = raw.operationStatus;

  if (!operationMessage && !operationStatus && !raw.cargoEventExplanation) {
    return { found: false, reason: "not_found", orderNumber: key };
  }

  return {
    found: true, orderNumber: key,
    statusMessage: operationMessage, statusCode: operationStatus,
    lastEvent: raw.cargoEventExplanation || null,
    lastUnit: raw.deliveryUnitName || null,
    lastCity: null,
    lastDate: null,
    reasonId: raw.cargoReasonId || null,
    reasonExplanation: raw.cargoReasonExplanation || null,
    // 2026-09-02 DUZELTME: eskiden "operationStatus === 'DLV'" yeterli
    // sayiliyordu, ama Yurtici paket bize (sirkete) iade oldugunda da
    // DLV donduruyor - bu durumda receiverCustName musterinin degil KENDI
    // SIRKETIMIZIN adi oluyor. Musteriye yanlislikla kendi sirket adimizi
    // "teslim alan siz" gibi gostermemek icin, ve asagidaki gercekTeslim/
    // sirketeIadeEdildi alanlariyla dogru ayrimi yapabilmek icin bu iki alan
    // eklendi. deliveredTo artik SADECE gercek musteri teslimatinda dolduruluyor.
    gercekTeslim: raw.gercektenMusteriyeTeslimEdildi,
    sirketeIadeEdildi: raw.sirketeIadeEdildi,
    deliveredTo: raw.gercektenMusteriyeTeslimEdildi ? raw.receiverCustName : null,
    trackingUrl: raw.trackingUrl
  };
}

async function getKargoInfo(orderNumber) {
  const key = String(orderNumber).replace(/[^0-9]/g, "");
  if (!key) return { found: false, reason: "no_number" };

  const raw = await yurtici.queryShipment(key, cb, "WEBHOOK-PROCESS");
  if (!raw) return { found: false, reason: "error" };
  return ykParseXml(raw, key);
}
// ============================================================

// --- Konusma hafizasi + mukerrer isleme kilidi (Upstash Redis) ---
const HISTORY_MAX = 20;          // tutulacak son mesaj sayisi (user+assistant)
const HISTORY_TTL = 172800;      // 2 gun (saniye)

async function getHistory(phone) {
  try {
    const h = await redis.get("chat:" + phone);
    return Array.isArray(h) ? h : [];
  } catch (e) {
    console.error("HAFIZA OKUMA HATA:", e && e.message ? e.message : e);
    return [];
  }
}

async function saveHistory(phone, history) {
  try {
    const trimmed = history.slice(-HISTORY_MAX);
    await redis.set("chat:" + phone, trimmed, { ex: HISTORY_TTL });
  } catch (e) {
    console.error("HAFIZA YAZMA HATA:", e && e.message ? e.message : e);
  }
}

// Ayni WhatsApp mesajini (wamid) iki kere islemeyi engeller.
async function acquireMessageLock(messageId) {
  try {
    const result = await redis.set("wa-msg-lock:" + messageId, "1", { nx: true, ex: 3600 });
    return result !== null; // null donerse zaten islenmis/isleniyor demek
  } catch (e) {
    console.error("MESAJ KILIDI HATA, guvenli taraf - devam ediliyor:", e && e.message ? e.message : e);
    return true;
  }
}
// -----------------------------------------

// Sorun/sikayet sinyali veren kelimeler (kucuk harf, Turkce karakterli):
const ALERT_KEYWORDS = [
  "şikayet", "sikayet", "şikayetçi", "sikayetci", "şikayetçiyim", "sikayetciyim",
  "memnun değil", "memnun degil", "memnun kalmadım", "memnun kalmadim",
  "dolandırıcı", "dolandirici", "dolandırıldım", "dolandirildim",
  "avukat", "bozuk", "çalışmıyor", "calismiyor", "kırık", "kirik",
  "arızalı", "arizali", "para iadesi", "rezalet"
];

// Bildirim gidecek yetkili numaralar (90 formatinda):
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

async function jsonFetch(url, body, ms) {
  const resp = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    },
    ms
  );
  // 2026-09-05 KRITIK DUZELTME: resp.ok kontrolu YOKTU - /api/chat hata
  // durumunda (Anthropic API'den 401/429/5xx veya kendi catch'inde 500)
  // yine de 200 sanip JSON'u okuyorduk. Ozellikle /api/chat cagrisinda bu,
  // musteriye asagidaki guzel "yogunluk" mesaji yerine chat.js'in ic
  // fallback metni olan cıplak "Yanıt oluşturulamadı." yazisinin GERCEK
  // WHATSAPP CEVABI olarak gitmesine yol aciyordu. Artik basarisiz HTTP
  // durumunda hata firlatiliyor, boylece asagidaki catch bloklari (ve
  // /api/chat cagrisi icin dogru "yogunluk" mesaji) devreye giriyor.
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error("HTTP " + resp.status + " " + url + ": " + errText.slice(0, 300));
  }
  return await resp.json();
}

// Sohbeti Google Sheets'e yaz (hata olsa bile akisi bozma)
async function logToSheets(phone, message, reply) {
  try {
    if (!process.env.SHEETS_URL) return;
    await fetchWithTimeout(
      process.env.SHEETS_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone, message: message, reply: reply })
      },
      8000
    );
  } catch (e) {
    console.error("SHEETS LOG HATA:", e && e.message ? e.message : e);
  }
}

// Tek bir yetkiliye temsilci_bildirim sablonu gonder
async function sendAlertTo(toNumber, customerPhone, customerMessage) {
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
                  { type: "text", text: String(customerPhone) },
                  { type: "text", text: String(customerMessage).slice(0, 250) }
                ]
              }
            ]
          }
        })
      },
      6000
    );
    const data = await resp.json();
    console.log("ALERT SONUCU (" + toNumber + "):", JSON.stringify(data));
  } catch (e) {
    console.error("ALERT HATA (" + toNumber + "):", e && e.message ? e.message : e);
  }
}

// Mesajda riskli kelime var mi?
function needsAlert(message) {
  const lower = String(message).toLowerCase();
  return ALERT_KEYWORDS.some(function (k) { return lower.includes(k); });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("OK");

  const secret = req.query && req.query.secret;
  if (secret !== SECRET) {
    console.error("WEBHOOK-PROCESS: gecersiz secret");
    return res.status(401).send("Unauthorized");
  }

  console.log("WEBHOOK-PROCESS TETIKLENDI");

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0]?.text?.body;
    const phone = value?.messages?.[0]?.from;
    const messageId = value?.messages?.[0]?.id;

    console.log("MESAJ:", message);
    console.log("TELEFON:", phone);

    if (!message || !phone) {
      console.log("MESAJ VEYA TELEFON YOK");
      return res.status(200).send("OK");
    }

    // Mukerrer isleme korumasi - ayni mesaj (wamid) daha once islendiyse dur.
    if (messageId) {
      const kilitAlindi = await acquireMessageLock(messageId);
      if (!kilitAlindi) {
        console.log("WEBHOOK-PROCESS: bu mesaj zaten islendi, atlaniyor:", messageId);
        return res.status(200).send("OK - zaten islendi");
      }
    }

    // Bu musterinin gecmis konusmasini Redis'ten cek
    const history = await getHistory(phone);
    console.log("HAFIZA UZUNLUGU:", history.length);

    // ---------------------------------------------------------
    // SIPARIS + KARGO SORGUSU
    // ---------------------------------------------------------
    let orderNote = "";

    const lower = message.toLowerCase();
    const orderIntent =
      lower.includes("sipariş") ||
      lower.includes("siparis") ||
      lower.includes("kargo") ||
      lower.includes("takip") ||
      lower.includes("nerede");

    const hashMatch = message.match(/#\s*(\d{3,})/);
    const numMatch = message.match(/\b(\d{3,})\b/);
    const orderNumber = hashMatch ? hashMatch[1] : (numMatch ? numMatch[1] : null);

    if (orderNumber) {
      console.log("SIPARIS SORGUSU:", orderNumber);

      const sipPromise = jsonFetch(BASE + "/api/siparis", { orderNumber }, 8000)
        .then((d) => { console.log("SIPARIS SONUCU:", JSON.stringify(d)); return d; })
        .catch((e) => { console.error("SIPARIS HATA:", e?.message || e); return null; });

      // Artik ayri bir HTTP cagrisi degil, dogrudan yukaridaki getKargoInfo()
      // fonksiyonu cagriliyor - hem daha hizli hem daha guvenilir.
      const kargoPromise = getKargoInfo(orderNumber)
        .then((d) => { console.log("KARGO SONUCU:", JSON.stringify(d)); return d; })
        .catch((e) => { console.error("KARGO HATA:", e?.message || e); return null; });

      const [sip, kargo] = await Promise.all([sipPromise, kargoPromise]);

      if ((sip && sip.found) || (kargo && kargo.found)) {
        orderNote =
          "[SİPARİŞ & KARGO BİLGİSİ - Aşağıdaki gerçek bilgileri kullanarak müşteriye doğal, sıcak ve net bir dille cevap ver. Asla bilgi uydurma, sadece bunları kullan. Kargo GERÇEKTEN müşteriye teslim edildiyse bunu olumlu söyle; yoldaysa nerede olduğunu ve güncel durumunu söyle. Aşağıda başka bir yönlendirme varsa (örn. şirkete iade notu) onu MUTLAKA önceliklendir ve 'teslim edildi' diye olumlu sunma.]\n";

        if (sip && sip.found) {
          orderNote += "Sipariş No: " + sip.orderName + "\n";
          orderNote += "Sipariş Durumu: " + sip.status + "\n";
          orderNote += "Ödeme: " + sip.payment + "\n";
        } else {
          orderNote += "Sipariş No: " + orderNumber + "\n";
        }

        if (kargo && kargo.found && kargo.sirketeIadeEdildi) {
          // 2026-09-02 KRITIK DUZELTME: Yurtici, paket musteriye ulasmadan
          // bize (sirkete) geri dondugunde de operationStatus="DLV" ("teslim
          // edildi") donduruyor. Bunu duzeltmeden once bot musteriye "kargonuz
          // teslim edildi" diye YANLISLIKLA olumlu haber veriyordu, oysa paket
          // hicbir zaman musteriye ulasmamisti. Artik bu durumda net ve
          // dogru bir aciklama + acik bir "olumlu sunma" talimati veriliyor.
          orderNote += "Kargo Durumu: Paket müşteriye ulaştırılamadı, kargo firması tarafından şirketimize iade edildi.\n";
          orderNote += "[ÖNEMLİ SİSTEM NOTU: Bu siparişi KESİNLİKLE 'teslim edildi' diye olumlu sunma - paket müşteriye ulaşmadan bize geri döndü. Müşteriye durumu nazik ve net biçimde açıkla, yeniden gönderim veya iade konusunda ekibimizin ilgileneceğini belirt; gerekirse 0553 068 16 19 / 0551 148 53 44 numaralarını paylaş.]\n";
          if (kargo.lastEvent) orderNote += "Son Hareket: " + kargo.lastEvent + "\n";
          if (kargo.lastUnit) orderNote += "Bulunduğu Yer: " + kargo.lastUnit + "\n";
          if (kargo.reasonExplanation) orderNote += "Not: " + kargo.reasonExplanation + "\n";
          if (kargo.trackingUrl) orderNote += "Takip Linki: " + kargo.trackingUrl + "\n";
        } else if (kargo && kargo.found) {
          if (kargo.statusMessage) orderNote += "Kargo Durumu: " + kargo.statusMessage + "\n";
          if (kargo.lastEvent) orderNote += "Son Hareket: " + kargo.lastEvent + "\n";
          if (kargo.lastUnit) orderNote += "Bulunduğu Yer: " + kargo.lastUnit + (kargo.lastCity ? " (" + kargo.lastCity + ")" : "") + "\n";
          if (kargo.reasonExplanation) orderNote += "Not: " + kargo.reasonExplanation + "\n";
          if (kargo.lastDate) orderNote += "Son Güncelleme: " + kargo.lastDate + "\n";
          if (kargo.gercekTeslim && kargo.deliveredTo) orderNote += "Teslim Alan: " + kargo.deliveredTo + "\n";
          if (kargo.trackingUrl) orderNote += "Takip Linki: " + kargo.trackingUrl + "\n";
        } else {
          // ONEMLI: Yurtici'den anlik cevap gelmedi diye "henuz kargoya
          // verilmedi" diye TAHMIN YURUTME - sip.status (yukarida) zaten
          // dogru bilgiyi veriyor olabilir, onunla celismesin.
          orderNote += "Kargo Durumu: Şu an Yurtiçi Kargo sisteminden anlık takip bilgisine ulaşılamadı (sistem yoğun olabilir). Yukarıdaki Sipariş Durumu bilgisi geçerlidir; 'henüz kargoya verilmedi' gibi kesin bir iddia kullanma, sadece canlı takip verisinin şu an çekilemediğini söyle.\n";
        }
      } else if ((sip && sip.reason === "not_found") && (!kargo || !kargo.found)) {
        orderNote =
          "[SİSTEM NOTU: " + orderNumber + " numaralı sipariş bulunamadı. Müşteriye nazikçe sipariş numarasını kontrol etmesini söyle; emin değilse 0553 068 16 19 veya 0551 148 53 44 numaralarından yardımcı olunabileceğini belirt. Numara uydurma.]";
      } else {
        orderNote =
          "[SİSTEM NOTU: Sipariş/kargo bilgisine şu an ulaşılamadı. Müşteriye nazikçe biraz sonra tekrar denemesini ya da 0553 068 16 19 / 0551 148 53 44 numaralarından ulaşmasını söyle.]";
      }
    } else if (orderIntent) {
      orderNote =
        "[SİSTEM NOTU: Müşteri siparişini/kargosunu soruyor ama sipariş numarası vermedi. Ondan sipariş numarasını (#1234 gibi) iste ki kargo durumunu kontrol edebilesin. Doğal ve samimi bir dille sor.]";
    }
    // ---------------------------------------------------------

    console.log("CLAUDE'A GONDERILIYOR");

    const claudeMessage = orderNote
      ? orderNote + "\n\nMüşteri mesajı: " + message
      : message;

    let reply = "Yanıt oluşturulamadı.";
    try {
      // 2026-09-05 DUZELTME: 9sn -> 40sn. Eskiden Claude'un cevabi 9 saniyeyi
      // gecerse (yogun saatlerde/uzun cevaplarda sik oluyordu) musteri GERCEK
      // bir yogunluk olmasa bile asagidaki hazir "yogunluk" mesajini goruyordu.
      // Hesap artik Vercel Pro'da ve bu fonksiyonun toplam suresi 90sn oldugu
      // icin 40sn'lik bir bekleme rahatlikla sigiyor.
      const claudeData = await jsonFetch(
        BASE + "/api/chat",
        { message: claudeMessage, history: history },
        40000
      );
      reply = claudeData.reply || reply;
    } catch (e) {
      console.error("CLAUDE HATA:", e?.message || e);
      reply = "Şu an kısa bir yoğunluk yaşıyoruz, birkaç dakika sonra tekrar yazabilir misiniz? Acil ise 0553 068 16 19 veya 0551 148 53 44 numaralarından bize ulaşabilirsiniz 🙂";
    }

    console.log("WHATSAPP'A GONDERILIYOR:", reply);

    // 2026-09-05 DUZELTME: bu istek eskiden zaman asimi OLMADAN (ciplak
    // fetch) yapiliyordu - teorik olarak sonsuza kadar askida kalip
    // fonksiyonu (ve dolayisiyla QStash'in mesaji tekrar denemesini,
    // mukerrer cevap riskini) tetikleyebilirdi. Artik dosyadaki diger tum
    // WhatsApp cagrilariyla ayni desende, zaman asimli.
    const whatsappResponse = await fetchWithTimeout(
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
          type: "text",
          text: { body: reply }
        })
      },
      15000
    );

    const whatsappData = await whatsappResponse.json();
    console.log("WHATSAPP SONUCU:", JSON.stringify(whatsappData));

    // Bu turu hafizaya ekle (ham musteri mesaji + botun cevabi)
    history.push({ role: "user", content: message });
    history.push({ role: "assistant", content: reply });
    await saveHistory(phone, history);

    // Sohbeti Sheets'e kaydet
    await logToSheets(phone, message, reply);

    // Riskli kelime varsa yetkililere bildir
    if (needsAlert(message)) {
      console.log("ALERT TETIKLENDI");
      for (const num of ALERT_NUMBERS) {
        await sendAlertTo(num, phone, message);
      }
    }

    return res.status(200).send("OK");
  } catch (error) {
    console.error("WEBHOOK-PROCESS HATA:", error);
    return res.status(200).send("OK");
  }
};
