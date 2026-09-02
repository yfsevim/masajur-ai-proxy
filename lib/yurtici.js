// lib/yurtici.js
// Yurtici Kargo SOAP sorgu istemcisi - api/webhook-process.js, api/teslim-kontrol.js
// ve api/yorum.js tarafindan ORTAK kullanilir. QuotaGuard sabit IP proxy'si,
// devre kesici (circuit breaker) ve retry/hard-deadline mantigi artik TEK
// YERDE - boylece biri guncellenirken digerinin eski kalmasi riski ortadan
// kalkar (2026-09-02'de tam bu yuzden bir regresyon yasanmisti).
//
// ONEMLI: Bu dosya api/ klasorunun DISINDADIR. Vercel sadece api/ altindaki
// dosyalari serverless fonksiyon olarak sayar; bu dosya sadece require()
// edilen sıradan bir kod dosyasidir, 12 fonksiyon sinirina dahil DEGILDIR.

const https = require("https");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { Redis } = require("@upstash/redis");

const YK_HOST = "ws.yurticikargo.com";
const YK_PATH = "/KOPSWebServices/ShippingOrderDispatcherServices";
const YK_USER = process.env.YK_USER;
const YK_PASS = process.env.YK_PASS;
const YK_REQ_TIMEOUT_MS = 8000;
const YK_MAX_TRIES = 3;
const YK_HARD_DEADLINE_MS = 20000;

// QUOTAGUARDSTATIC_URL varsa sabit IP proxy'si uzerinden gider (Yurtici'nin
// whitelist'i icin) - eskiden her dosyada ayri ayri tanimliydi, artik tek yerde.
const ykTlsOptions = {
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 10,
  minVersion: "TLSv1",
  rejectUnauthorized: false,
  ciphers: "DEFAULT:@SECLEVEL=0"
};
const ykAgent = process.env.QUOTAGUARDSTATIC_URL
  ? new HttpsProxyAgent(process.env.QUOTAGUARDSTATIC_URL, ykTlsOptions)
  : new https.Agent(ykTlsOptions);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function backoffDelay(attempt) { return 500 * Math.pow(2, attempt - 1) + Math.random() * 300; }
function hardDeadline(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("sert son tarih asildi")), ms));
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
    '<addHistoricalData>false</addHistoricalData>' +
    '<onlyTracking>false</onlyTracking>' +
    '</ser:queryShipment>' +
    '</soapenv:Body></soapenv:Envelope>';
}

function tag(xml, name) {
  const m = xml.match(new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">"));
  return m ? m[1].trim() : null;
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
    req.setTimeout(YK_REQ_TIMEOUT_MS, function () { req.destroy(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

async function soapPostWithRetry(body, logPrefix) {
  let lastErr;
  for (let i = 1; i <= YK_MAX_TRIES; i++) {
    try {
      const xml = await soapPostOnce(body);
      if (xml && xml.length > 50) return xml;
      lastErr = new Error("bos cevap");
      console.error(logPrefix + " SOAP DENEME " + i + ": bos cevap");
    } catch (e) {
      lastErr = e;
      console.error(logPrefix + " SOAP DENEME " + i + " HATA:", e && e.message ? e.message : e);
    }
    if (i < YK_MAX_TRIES) await sleep(backoffDelay(i));
  }
  throw lastErr || new Error("bilinmeyen SOAP hatasi");
}

// Devre kesici olusturucu - her cagiran kendi Redis anahtar on-ekini verir.
// webhook-process.js musteri sohbeti oldugu icin AYRI anahtar kullanir
// ("yurtici-cb-canli"), teslim-kontrol.js ve yorum.js arka plan isi oldugu
// icin ORTAK anahtar kullanir ("yurtici-cb") - eskisiyle birebir ayni davranis.
function createCircuitBreaker(keyPrefix) {
  const redis = Redis.fromEnv();
  const CB_KEY_FAILS = keyPrefix + ":fails";
  const CB_KEY_OPEN_UNTIL = keyPrefix + ":open-until";
  const CB_THRESHOLD = 5;
  const CB_COOLDOWN_SECONDS = 600;

  return {
    async isOpen() {
      try {
        const openUntil = await redis.get(CB_KEY_OPEN_UNTIL);
        return !!(openUntil && Date.now() < Number(openUntil));
      } catch (e) {
        return false;
      }
    },
    async recordFailure() {
      try {
        const fails = await redis.incr(CB_KEY_FAILS);
        if (fails >= CB_THRESHOLD) {
          await redis.set(CB_KEY_OPEN_UNTIL, Date.now() + CB_COOLDOWN_SECONDS * 1000);
          await redis.set(CB_KEY_FAILS, 0);
          console.error("YURTICI DEVRE KESICI ACILDI (" + keyPrefix + ") - " + CB_COOLDOWN_SECONDS + "sn boyunca denenmeyecek");
        }
      } catch (e) {}
    },
    async recordSuccess() {
      try { await redis.set(CB_KEY_FAILS, 0); } catch (e) {}
    }
  };
}

// Ana fonksiyon: siparis numarasiyla Yurtici'yi sorgular, ham etiket
// degerlerini doner. Devre kesici aciksa veya sorgu basarisiz olursa null doner.
async function queryShipment(orderNumber, circuitBreaker, logPrefix) {
  const key = String(orderNumber).replace(/[^0-9]/g, "");
  if (!key) return null;

  if (await circuitBreaker.isOpen()) {
    console.log(logPrefix + ": devre kesici ACIK, Yurtici'ye gidilmiyor");
    return null;
  }

  try {
    const xml = await Promise.race([
      soapPostWithRetry(buildSoap(key), logPrefix),
      hardDeadline(YK_HARD_DEADLINE_MS)
    ]);
    await circuitBreaker.recordSuccess();
    return {
      operationMessage: tag(xml, "operationMessage"),
      operationStatus: tag(xml, "operationStatus"),
      trackingUrl: tag(xml, "trackingUrl"),
      receiverCustName: tag(xml, "receiverCustName"),
      deliveryUnitName: tag(xml, "deliveryUnitName"),
      cargoEventExplanation: tag(xml, "cargoEventExplanation"),
      cargoReasonId: tag(xml, "cargoReasonId"),
      cargoReasonExplanation: tag(xml, "cargoReasonExplanation")
    };
  } catch (e) {
    await circuitBreaker.recordFailure();
    console.error(logPrefix + ": kargo sorgu HATA:", e && e.message ? e.message : e);
    return null;
  }
}

module.exports = { createCircuitBreaker, queryShipment };
