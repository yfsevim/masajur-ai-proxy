// api/webhook.js
// WhatsApp -> Shopify siparis + Yurtici kargo + Claude -> cevap
// Hobby plan (10sn limit) icin: siparis & kargo PARALEL + her fetch'e timeout.
// + Her mesaj Google Sheets'e kaydedilir (SHEETS_URL).
// + Riskli kelimelerde yetkililere 'temsilci_bildirim' sablonu gonderilir.
// + Konusma hafizasi (Upstash Redis): son mesajlar hatirlanir.
// + Kargo sorgusu ARTIK AYRI BIR DOSYA (api/kargo.js) DEGIL - Hobby planin
//   12 fonksiyon sinirina takilmamak icin ve internal self-fetch'in 404
//   riskini ortadan kaldirmak icin dogrudan burada, ayni surecte calisiyor.

const BASE = "https://masajur-ai-proxy.vercel.app";
const https = require("https");

// --- Konusma hafizasi (Upstash Redis) ---
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

// NOT: Sheets log timeout webhook'un toplam suresini etkilemesin diye dusuk tutuldu.

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

// ============================================================
// YURTICI KARGO SORGUSU (eskiden ayri api/kargo.js dosyasi olacakti, Hobby
// planin 12 fonksiyon sinirina takilmamak icin dogrudan buraya tasindi).
// teslim-kontrol.js'teki AYNI SOAP mantigi (Keep-Alive, retry, devre kesici,
// ayni Redis anahtarlari - hepsi ayni Yurtici servisine gidiyor).
// ============================================================
const YK_HOST = "ws.yurticikargo.com";
const YK_PATH = "/KOPSWebServices/ShippingOrderDispatcherServices";
const YK_USER = process.env.YK_USER;
const YK_PASS = process.env.YK_PASS;
const YK_REQ_TIMEOUT_MS = 8000;
const YK_MAX_TRIES = 3;
const YK_HARD_DEADLINE_MS = 20000;

const ykAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 10,
  minVersion: "TLSv1",
  rejectUnauthorized: false,
  ciphers: "DEFAULT:@SECLEVEL=0"
});

const CB_KEY_FAILS = "yurtici-cb:fails";
const CB_KEY_OPEN_UNTIL = "yurtici-cb:open-until";
const CB_THRESHOLD = 5;
const CB_COOLDOWN_SECONDS = 600;

async function isCircuitOpen() {
  try {
    const openUntil = await redis.get(CB_KEY_OPEN_UNTIL);
    return !!(openUntil && Date.now() < Number(openUntil));
  } catch (e) {
    return false;
  }
}
async function recordYurticiFailure() {
  try {
    const fails = await redis.incr(CB_KEY_FAILS);
    if (fails >= CB_THRESHOLD) {
      await redis.set(CB_KEY_OPEN_UNTIL, Date.now() + CB_COOLDOWN_SECONDS * 1000);
      await redis.set(CB_KEY_FAILS, 0);
      console.error("YURTICI DEVRE KESICI ACILDI (webhook.js) - " + CB_COOLDOWN_SECONDS + "sn boyunca denenmeyecek");
    }
  } catch (e) {}
}
async function recordYurticiSuccess() {
  try { await redis.set(CB_KEY_FAILS, 0); } catch (e) {}
}

function ykSleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function ykBackoffDelay(attempt) { return 500 * Math.pow(2, attempt - 1) + Math.random() * 300; }
function ykHardDeadline(ms) {
  return new Promise(function (_, reject) {
    setTimeout(function () { reject(new Error("sert son tarih asildi")); }, ms);
  });
}

function ykBuildSoap(key) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="http://yurticikargo.com.tr/ShippingOrderDispatcherServices">' +
    '<soapenv:Header/><soapenv:Body>' +
    '<ser:queryShipment>' +
    '<wsUserName>' + YK_USER + '</wsUserName>' +
    '<wsPassword>' + YK_PASS + '</wsPassword>' +
    '<wsLanguage>TR</wsLanguage>' +
    '<keys>' + key + '</keys>' +
    '<keyType>0</keyType>' +
    '<addHistoricalData>true</addHistoricalData>' +
    '<onlyTracking>false</onlyTracking>' +
    '</ser:queryShipment>' +
    '</soapenv:Body></soapenv:Envelope>';
}

function ykTag(xml, name) {
  const m = xml.match(new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">"));
  return m ? m[1].trim() : null;
}

function ykAllBlocks(xml, blockName) {
  const re = new RegExp("<" + blockName + ">([\\s\\S]*?)</" + blockName + ">", "g");
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
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
      agent: ykAgent
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

async function ykSoapPostWithRetry(body) {
  let lastErr;
  for (let i = 1; i <= YK_MAX_TRIES; i++) {
    try {
      const xml = await ykSoapPostOnce(body);
      if (xml && xml.length > 50) return xml;
      lastErr = new Error("bos cevap");
      console.error("KARGO SOAP DENEME " + i + ": bos cevap");
    } catch (e) {
      lastErr = e;
      console.error("KARGO SOAP DENEME " + i + " HATA:", e && e.message ? e.message : e);
    }
    if (i < YK_MAX_TRIES) await ykSleep(ykBackoffDelay(i));
  }
  throw lastErr || new Error("bilinmeyen SOAP hatasi");
}

function ykToSortableDate(dateStr, timeStr) {
  if (!dateStr) return 0;
  const dParts = dateStr.split(".");
  if (dParts.length !== 3) return 0;
  const iso = dParts[2] + "-" + dParts[1] + "-" + dParts[0] + "T" + (timeStr || "00:00:00");
  const t = Date.parse(iso);
  return isNaN(t) ? 0 : t;
}

function ykParseXml(xml) {
  const operationCode = ykTag(xml, "operationCode");
  const operationMessage = ykTag(xml, "operationMessage");
  const operationStatus = ykTag(xml, "operationStatus");

  const blocks = ykAllBlocks(xml, "InvDocCargoVO");
  const events = blocks.map(function (b) {
    return {
      unitName: ykTag(b, "unitName"),
      eventName: ykTag(b, "eventName"),
      reasonName: ykTag(b, "reasonName"),
      eventDate: ykTag(b, "eventDate"),
      eventTime: ykTag(b, "eventTime"),
      cityName: ykTag(b, "cityName"),
      townName: ykTag(b, "townName")
    };
  });
  events.sort(function (a, b) {
    return ykToSortableDate(b.eventDate, b.eventTime) - ykToSortableDate(a.eventDate, a.eventTime);
  });
  const last = events[0] || null;

  const hasData = !!(operationStatus || last);
  if (!hasData) {
    console.log("KARGO: veri yok - operationCode:", operationCode, "operationMessage:", operationMessage);
    return { found: false, operationCode: operationCode, operationMessage: operationMessage };
  }

  return {
    found: true,
    statusCode: operationStatus || null,
    statusMessage: operationMessage || (last ? (last.eventName || last.reasonName) : null),
    lastEvent: last ? (last.eventName || last.reasonName) : null,
    lastUnit: last ? last.unitName : null,
    lastCity: last ? (last.cityName + (last.townName ? "/" + last.townName : "")) : null,
    lastDate: last ? (last.eventDate + (last.eventTime ? " " + last.eventTime : "")) : null,
    deliveredTo: operationStatus === "DLV" ? (ykTag(xml, "recipientName") || null) : null,
    trackingUrl: "https://www.yurticikargo.com/tr/online-servisler/gonderi-sorgula"
  };
}

async function getKargoInfo(orderNumber) {
  if (await isCircuitOpen()) {
    console.log("KARGO: devre kesici ACIK, Yurtici'ye gidilmiyor");
    return { found: false, reason: "circuit_open" };
  }
  try {
    const xml = await Promise.race([
      ykSoapPostWithRetry(ykBuildSoap(orderNumber)),
      ykHardDeadline(YK_HARD_DEADLINE_MS)
    ]);
    await recordYurticiSuccess();
    console.log("KARGO XML CEVABI (" + orderNumber + "):", xml.slice(0, 800));
    return ykParseXml(xml);
  } catch (e) {
    await recordYurticiFailure();
    console.error("KARGO HATA (" + orderNumber + "):", e && e.message ? e.message : e);
    return { found: false, reason: "error" };
  }
}

module.exports = async (req, res) => {
  const VERIFY_TOKEN = "masajur123";

  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  if (req.method === "POST") {
    console.log("MESAJ GELDI");

    try {
      const value = req.body?.entry?.[0]?.changes?.[0]?.value;
      const message = value?.messages?.[0]?.text?.body;
      const phone = value?.messages?.[0]?.from;

      console.log("MESAJ:", message);
      console.log("TELEFON:", phone);

      if (!message || !phone) {
        console.log("MESAJ VEYA TELEFON YOK");
        return res.status(200).send("OK");
      }

      // Bu musterinin gecmis konusmasini Redis'ten cek
      const history = await getHistory(phone);
      console.log("HAFIZA
