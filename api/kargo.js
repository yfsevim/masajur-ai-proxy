// api/kargo.js
// WhatsApp bot (webhook.js) tarafindan cagrilir. Musteriye ANLIK kargo durumu
// gostermek icin Yurtici Kargo SOAP servisine sorgu atar.
// teslim-kontrol.js'teki AYNI SOAP mantigi kullanilir (Keep-Alive, retry,
// devre kesici Redis anahtarlari ORTAK - hepsi ayni Yurtici servisine gidiyor).
//
// ONEMLI: Bu fonksiyon NE OLURSA OLSUN HTTP 200 + JSON doner (hata durumunda
// bile {found:false} doner). webhook.js bu cevabi resp.json() ile parse ediyor;
// eger buradan HTML/hata sayfasi donerse "Unexpected token" hatasi alir ve
// musteriye yanlislikla "henuz kargoya verilmedi" der. Bu yuzden asla throw
// etmeden, hep JSON ile cikiyoruz.

const https = require("https");
const { Redis } = require("@upstash/redis");
const redis = Redis.fromEnv();

const YK_HOST = "ws.yurticikargo.com";
const YK_PATH = "/KOPSWebServices/ShippingOrderDispatcherServices";
const YK_USER = process.env.YK_USER;
const YK_PASS = process.env.YK_PASS;
const REQ_TIMEOUT_MS = 8000;
const MAX_TRIES = 3;
// webhook.js bu endpoint'e 25000ms timeout ile istek atiyor (jsonFetch(... ,25000)).
// Bu yuzden kendi sert son tarihimizi bunun altinda tutuyoruz.
const HARD_DEADLINE_MS = 20000;

const ykAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 10,
  minVersion: "TLSv1",
  rejectUnauthorized: false,
  ciphers: "DEFAULT:@SECLEVEL=0"
});

// ============================================================
// DEVRE KESICI (Circuit Breaker) - teslim-kontrol.js / webhook-process.js
// ile ORTAK Redis anahtarlari kullanir, cunku hepsi ayni Yurtici servisine gidiyor.
// ============================================================
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
      console.error("YURTICI DEVRE KESICI ACILDI (kargo.js) - " + CB_COOLDOWN_SECONDS + "sn boyunca denenmeyecek");
    }
  } catch (e) {}
}
async function recordYurticiSuccess() {
  try { await redis.set(CB_KEY_FAILS, 0); } catch (e) {}
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function backoffDelay(attempt) { return 500 * Math.pow(2, attempt - 1) + Math.random() * 300; }

function hardDeadline(ms) {
  return new Promise(function (_, reject) {
    setTimeout(function () { reject(new Error("sert son tarih asildi")); }, ms);
  });
}

function buildSoap(key) {
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

function tag(xml, name) {
  const m = xml.match(new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">"));
  return m ? m[1].trim() : null;
}

function allBlocks(xml, blockName) {
  const re = new RegExp("<" + blockName + ">([\\s\\S]*?)</" + blockName + ">", "g");
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function soapPostOnce(body) {
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
    req.setTimeout(REQ_TIMEOUT_MS, function () { req.destroy(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

// teslim-kontrol.js ile ayni: bos/hatali cevapta ayni calisma icinde 3 kere
// ust uste dener, her denemeden sonra artan bir sure bekler.
async function soapPostWithRetry(body) {
  let lastErr;
  for (let i = 1; i <= MAX_TRIES; i++) {
    try {
      const xml = await soapPostOnce(body);
      if (xml && xml.length > 50) return xml;
      lastErr = new Error("bos cevap");
      console.error("KARGO SOAP DENEME " + i + ": bos cevap");
    } catch (e) {
      lastErr = e;
      console.error("KARGO SOAP DENEME " + i + " HATA:", e && e.message ? e.message : e);
    }
    if (i < MAX_TRIES) await sleep(backoffDelay(i));
  }
  throw lastErr || new Error("bilinmeyen SOAP hatasi");
}

// Yurtici'nin eventDate/eventTime alanlari genelde "dd.MM.yyyy" / "HH:mm:ss"
// formatinda geliyor; karsilastirilabilir bir zaman damgasina ceviriyoruz.
function toSortableDate(dateStr, timeStr) {
  if (!dateStr) return 0;
  const dParts = dateStr.split(".");
  if (dParts.length !== 3) return 0;
  const iso = dParts[2] + "-" + dParts[1] + "-" + dParts[0] + "T" + (timeStr || "00:00:00");
  const t = Date.parse(iso);
  return isNaN(t) ? 0 : t;
}

function parseKargoXml(xml) {
  const operationCode = tag(xml, "operationCode");
  const operationMessage = tag(xml, "operationMessage");
  const operationStatus = tag(xml, "operationStatus");

  const blocks = allBlocks(xml, "InvDocCargoVO");
  const events = blocks.map(function (b) {
    return {
      unitName: tag(b, "unitName"),
      eventName: tag(b, "eventName"),
      reasonName: tag(b, "reasonName"),
      eventDate: tag(b, "eventDate"),
      eventTime: tag(b, "eventTime"),
      cityName: tag(b, "cityName"),
      townName: tag(b, "townName")
    };
  });
  // Yurtici'nin donduruma sirasina guvenmiyoruz, kendimiz en yeniye gore siraliyoruz.
  events.sort(function (a, b) {
    return toSortableDate(b.eventDate, b.eventTime) - toSortableDate(a.eventDate, a.eventTime);
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
    deliveredTo: operationStatus === "DLV" ? (tag(xml, "recipientName") || null) : null,
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
      soapPostWithRetry(buildSoap(orderNumber)),
      hardDeadline(HARD_DEADLINE_MS)
    ]);
    await recordYurticiSuccess();
    console.log("KARGO XML CEVABI (" + orderNumber + "):", xml.slice(0, 800));
    return parseKargoXml(xml);
  } catch (e) {
    await recordYurticiFailure();
    console.error("KARGO HATA (" + orderNumber + "):", e && e.message ? e.message : e);
    return { found: false, reason: "error" };
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).json({ found: false });

  try {
    const body = req.body || {};
    const orderNumber = body.orderNumber ? String(body.orderNumber) : "";
    if (!orderNumber) return res.status(200).json({ found: false });

    console.log("KARGO SORGU:", orderNumber);
    const result = await getKargoInfo(orderNumber);
    return res.status(200).json(result);
  } catch (error) {
    console.error("KARGO GENEL HATA:", error && error.message ? error.message : error);
    return res.status(200).json({ found: false });
  }
};
