// api/webhook-process.js
// QStash tarafindan (webhook.js'in devrettigi) cagrilir. Asil is burada:
// Shopify siparis + Yurtici kargo + Claude -> WhatsApp cevabi.
// Bu dosyanin webhook.js'den ayri olmasinin tek sebebi: Meta'nin 5sn
// kuralindan bagimsiz olarak, Yurtici yavas oldugunda bile rahat calisabilsin
// (vercel.json'da bu fonksiyona 45sn suresi tanimli).
//
// Yurtici Kargo sorgusu (eskiden ayri api/kargo.js dosyasiydi) buraya
// dogrudan gomuldu - hem bir HTTP round-trip'i ortadan kaldirir hem de
// Vercel Hobby'nin 12 fonksiyon sinirinda yer acar.
//
// + Her mesaj Google Sheets'e kaydedilir (SHEETS_URL).
// + Riskli kelimelerde yetkililere 'temsilci_bildirim' sablonu gonderilir.
// + Konusma hafizasi (Upstash Redis): son mesajlar hatirlanir.
// + Mukerrer isleme korumasi (Redis kilidi, wamid bazli): QStash veya Meta
//   ayni mesaji birden fazla kez teslim etse bile bot ayni soruya sadece
//   BIR KERE cevap yazar.

const https = require("https");

const BASE = "https://masajur-ai-proxy.vercel.app";
const SECRET = "masajur_yakkoholding_2128";

// ============================================================
// YURTICI KARGO SORGUSU (eskiden api/kargo.js)
// ============================================================
const YK_HOST = "ws.yurticikargo.com";
const YK_PATH = "/KOPSWebServices/ShippingOrderDispatcherServices";
const YK_USER = process.env.YK_USER;
const YK_PASS = process.env.YK_PASS;
const YK_LANG = "TR";
const YK_REQ_TIMEOUT_MS = 8000;
const YK_MAX_TRIES = 3;

function ykBuildSoap(key) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="http://yurticikargo.com.tr/ShippingOrderDispatcherServices">' +
    '<soapenv:Header/><soapenv:Body>' +
    '<ser:queryShipment>' +
    '<wsUserName>' + YK_USER + '</wsUserName>' +
    '<wsPassword>' + YK_PASS + '</wsPassword>' +
    '<wsLanguage>' + YK_LANG + '</wsLanguage>' +
    '<keys>' + key + '</keys>' +
    '<keyType>0</keyType>' +
    '<addHistoricalData>false</addHistoricalData>' +
    '<onlyTracking>false</onlyTracking>' +
    '</ser:queryShipment>' +
    '</soapenv:Body></soapenv:Envelope>';
}

function ykTag(xml, name) {
  const m = xml.match(new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">"));
  return m ? m[1].trim() : null;
}
function ykFmtDate(d, t) {
  if (!d || d.length < 8) return null;
  const day = d.slice(6, 8), mon = d.slice(4, 6), yr = d.slice(0, 4);
  let time = "";
  if (t && t.length >= 4) { const tt = ("000000" + t).slice(-6); time = " " + tt.slice(0,2) + ":" + tt.slice(2,4); }
  return day + "." + mon + "." + yr + time;
}

function ykSoapPostOnce(body) {
  return new Promise(function (resolve, reject) {
    const options = {
      host: YK_HOST, port: 443, path: YK_PATH, method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        "SOAPAction": "",
        "Content-Length": Buffer.byteLength(body)
      },
      rejectUnauthorized: false,
      minVersion: "TLSv1",
      ciphers: "DEFAULT:@SECLEVEL=0"
    };
    const req = https.request(options, function (resp) {
      let data = "";
      resp.setEncoding("utf8");
      resp.on("data", function (c) { data += c; });
      resp.on("end", function () { resolve(data); });
    });
    req.on("error", function (e) { reject(e); });
    req.setTimeout(YK_REQ_TIMEOUT_MS, function () { req.destroy(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

async function ykSoapPost(body) {
  let lastErr;
  for (let i = 1; i <= YK_MAX_TRIES; i++) {
    try {
      const xml = await ykSoapPostOnce(body);
      if (xml && xml.length > 50) return xml;
      lastErr = new Error("empty");
      console.error("KARGO DENEME " + i + ": bos cevap");
    } catch (e) {
      lastErr = e;
      console.error("KARGO DENEME " + i + " HATA:", e && e.message ? e.message : e);
    }
  }
  throw lastErr || new Error("timeout");
}

function ykParseXml(xml, key) {
  const operationMessage = ykTag(xml, "operationMessage");
  const operationStatus = ykTag(xml, "operationStatus");
  const trackingUrl = ykTag(xml, "trackingUrl");
  const receiver = ykTag(xml, "receiverInfo");
  const events = [];
  const re = /<invDocCargoVOArray>([\s\S]*?)<\/invDocCargoVOArray>/g;
  let mm;
  while ((mm = re.exec(xml)) !== null) {
    const b = mm[1];
    events.push({ unit: ykTag(b,"unitName"), event: ykTag(b,"eventName"), city: ykTag(b,"cityName"), town: ykTag(b,"townName"), date: ykTag(b,"eventDate"), time: ykTag(b,"eventTime") });
  }
  if (!operationMessage && events.length === 0) return { found: false, reason: "not_found", orderNumber: key };
  const last = events.length ? events[events.length - 1] : null;
  return {
    found: true, orderNumber: key,
    statusMessage: operationMessage, statusCode: operationStatus,
    lastEvent: last ? last.event : null,
    lastUnit: last ? last.unit : null,
    lastCity: last ? (last.town + " / " + last.city) : null,
    lastDate: last ? ykFmtDate(last.date, last.time) : null,
    deliveredTo: (operationStatus === "DLV") ? receiver : null,
    trackingUrl: trackingUrl
  };
}

async function getKargoInfo(orderNumber) {
  const key = String(orderNumber).replace(/[^0-9]/g, "");
  if (!key) return { found: false, reason: "no_number" };
  try {
    const xml = await ykSoapPost(ykBuildSoap(key));
    return ykParseXml(xml, key);
  } catch (error) {
    console.error("KARGO ERROR:", error && error.message ? error.message : error);
    return { found: false, reason: "error", detail: (error && error.message) ? error.message : String(error) };
  }
}
// ============================================================

// --- Konusma hafizasi + mukerrer isleme kilidi (Upstash Redis) ---
const { Redis } = require("@upstash/redis");
const redis = Redis.fromEnv();
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
      4000
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

      const sipPromise = jsonFetch(BASE + "/api/siparis", { orderNumber }, 6000)
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
          "[SİPARİŞ & KARGO BİLGİSİ - Aşağıdaki gerçek bilgileri kullanarak müşteriye doğal, sıcak ve net bir dille cevap ver. Asla bilgi uydurma, sadece bunları kullan. Kargo teslim edildiyse bunu olumlu söyle; yoldaysa nerede olduğunu ve güncel durumunu söyle.]\n";

        if (sip && sip.found) {
          orderNote += "Sipariş No: " + sip.orderName + "\n";
          orderNote += "Sipariş Durumu: " + sip.status + "\n";
          orderNote += "Ödeme: " + sip.payment + "\n";
        } else {
          orderNote += "Sipariş No: " + orderNumber + "\n";
        }

        if (kargo && kargo.found) {
          if (kargo.statusMessage) orderNote += "Kargo Durumu: " + kargo.statusMessage + "\n";
          if (kargo.lastEvent) orderNote += "Son Hareket: " + kargo.lastEvent + "\n";
          if (kargo.lastUnit) orderNote += "Bulunduğu Yer: " + kargo.lastUnit + (kargo.lastCity ? " (" + kargo.lastCity + ")" : "") + "\n";
          if (kargo.lastDate) orderNote += "Son Güncelleme: " + kargo.lastDate + "\n";
          if (kargo.statusCode === "DLV" && kargo.deliveredTo) orderNote += "Teslim Alan: " + kargo.deliveredTo + "\n";
          if (kargo.trackingUrl) orderNote += "Takip Linki: " + kargo.trackingUrl + "\n";
        } else {
          orderNote += "Kargo Durumu: Sipariş henüz kargoya verilmemiş olabilir veya kargo bilgisi sisteme düşmemiş olabilir. Müşteriye nazikçe siparişin hazırlandığını/yakında kargolanacağını söyle.\n";
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
      const claudeData = await jsonFetch(
        BASE + "/api/chat",
        { message: claudeMessage, history: history },
        9000
      );
      reply = claudeData.reply || reply;
    } catch (e) {
      console.error("CLAUDE HATA:", e?.message || e);
      reply = "Şu an kısa bir yoğunluk yaşıyoruz, birkaç dakika sonra tekrar yazabilir misiniz? Acil ise 0553 068 16 19 veya 0551 148 53 44 numaralarından bize ulaşabilirsiniz 🙂";
    }

    console.log("WHATSAPP'A GONDERILIYOR:", reply);

    const whatsappResponse = await fetch(
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
      }
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
