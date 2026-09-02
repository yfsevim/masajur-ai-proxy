// api/yorum.js
// QStash tarafindan (kargodan ~4 gun sonra) tetiklenir.
// Gonderim ONCESI Yurtici Kargo'dan gercek teslim durumu kontrol edilir:
// sadece DLV (teslim edildi) ise yorum_istek gonderilir. Kapidan donen
// (AAB/MSA gibi) veya hala yolda olan siparislere yorum istegi GITMEZ.
// Yurtici'ye ulasilamazsa (gecici hata/devre kesici acik) eski davranisa
// donulur: yine de gonderilir - boylece bir API kesintisi butun yorum
// akisini durdurmaz.

const https = require("https");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { Redis } = require("@upstash/redis");
const redis = Redis.fromEnv();

const SECRET = "masajur_yakkoholding_2128";
const TEMPLATE_NAME = "yorum_istek";
const TEMPLATE_LANG = "tr";

// ============================================================
// YURTICI KARGO SORGUSU (teslim-kontrol.js / webhook-process.js ile ayni mantik)
// ============================================================
const YK_HOST = "ws.yurticikargo.com";
const YK_PATH = "/KOPSWebServices/ShippingOrderDispatcherServices";
const YK_USER = process.env.YK_USER;
const YK_PASS = process.env.YK_PASS;
const YK_REQ_TIMEOUT_MS = 8000;
const YK_MAX_TRIES = 3;
const YK_HARD_DEADLINE_MS = 20000;

// QUOTAGUARDSTATIC_URL varsa sabit IP proxy'si uzerinden gider (Yurtici'nin
// whitelist'i icin) - teslim-kontrol.js / webhook-process.js ile ayni ayar.
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

// Devre kesici - teslim-kontrol.js ile ORTAK Redis anahtarlari kullanir
// (ikisi de arka plan/batch isi, musteri sohbetini etkilemez).
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
      console.error("YURTICI DEVRE KESICI ACILDI - " + CB_COOLDOWN_SECONDS + "sn boyunca denenmeyecek");
    }
  } catch (e) {}
}
async function recordYurticiSuccess() {
  try { await redis.set(CB_KEY_FAILS, 0); } catch (e) {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function backoffDelay(attempt) { return 500 * Math.pow(2, attempt - 1) + Math.random() * 300; }
function hardDeadline(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("sert son tarih asildi")), ms));
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
    '<addHistoricalData>false</addHistoricalData>' +
    '<onlyTracking>false</onlyTracking>' +
    '</ser:queryShipment>' +
    '</soapenv:Body></soapenv:Envelope>';
}

function ykTag(xml, name) {
  const m = xml.match(new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">"));
  return m ? m[1].trim() : null;
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
      console.error("YORUM SOAP DENEME " + i + ": bos cevap");
    } catch (e) {
      lastErr = e;
      console.error("YORUM SOAP DENEME " + i + " HATA:", e && e.message ? e.message : e);
    }
    if (i < YK_MAX_TRIES) await sleep(backoffDelay(i));
  }
  throw lastErr || new Error("bilinmeyen SOAP hatasi");
}

// Siparisin gercek teslim durumunu getirir. null donerse (devre kesici acik
// veya sorgu basarisiz) durum BILINMIYOR demektir - cagiran taraf bu durumda
// eski davranisa (yorum gonder) donmeli.
async function getTeslimDurumu(orderNumber) {
  const key = String(orderNumber).replace(/[^0-9]/g, "");
  if (!key) return null;

  if (await isCircuitOpen()) {
    console.log("YORUM: devre kesici ACIK, Yurtici'ye gidilmiyor");
    return null;
  }

  try {
    const xml = await Promise.race([
      ykSoapPostWithRetry(ykBuildSoap(key)),
      hardDeadline(YK_HARD_DEADLINE_MS)
    ]);
    await recordYurticiSuccess();
    return {
      status: ykTag(xml, "operationStatus"),
      reasonId: ykTag(xml, "cargoReasonId"),
      reasonExplanation: ykTag(xml, "cargoReasonExplanation")
    };
  } catch (e) {
    await recordYurticiFailure();
    console.error("YORUM: kargo sorgu HATA:", e && e.message ? e.message : e);
    return null;
  }
}
// ============================================================

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// WhatsApp API cevabindan gercek gonderim durumunu cikar
function readWaStatus(waData) {
  try {
    if (waData && waData.messages && waData.messages[0] && waData.messages[0].id) {
      return "Gonderildi OK (" + waData.messages[0].id + ")";
    }
    if (waData && waData.error) {
      const code = waData.error.code != null ? " [" + waData.error.code + "]" : "";
      const msg = waData.error.message || "bilinmeyen hata";
      return "GITMEDI HATA" + code + ": " + msg;
    }
    return "BELIRSIZ: " + JSON.stringify(waData).slice(0, 150);
  } catch (e) {
    return "DURUM OKUNAMADI: " + (e && e.message ? e.message : e);
  }
}

// Yorum mesaji kaydini Google Sheets'e yaz (type:yorum -> "Yorum Mesajları" sekmesi)
async function logYorumToSheets(phone, name, orderNumber, status) {
  try {
    if (!process.env.SHEETS_URL) return;
    await fetchWithTimeout(
      process.env.SHEETS_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "yorum",
          phone: phone,
          name: name,
          orderNumber: orderNumber,
          status: status
        })
      },
      8000
    );
  } catch (e) {
    console.error("YORUM SHEETS LOG HATA:", e && e.message ? e.message : e);
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(200).send("OK");
  }

  // Gizli anahtar kontrolu (QStash cagrisinda ?secret=... ile gelir)
  const secret = req.query && req.query.secret;
  if (secret !== SECRET) {
    console.error("YORUM: gecersiz secret");
    return res.status(401).send("Unauthorized");
  }

  try {
    // QStash gorevinde gonderdigimiz veri: { orderNumber, phone, name }
    const body = req.body || {};
    const orderNumber = body.orderNumber ? String(body.orderNumber) : "";
    const phone = body.phone ? String(body.phone) : "";
    const name = body.name ? String(body.name) : "Merhaba";

    console.log("YORUM TETIKLENDI:", JSON.stringify({ orderNumber, phone, name }));

    if (!phone) {
      console.error("YORUM: phone yok, mesaj gonderilemedi");
      await logYorumToSheets("", name, orderNumber, "GITMEDI: telefon yok");
      return res.status(200).send("OK");
    }

    // Once gercekten teslim edilmis mi kontrol et. Durum bilinmiyorsa
    // (Yurtici'ye ulasilamadi / devre kesici acik) eski davranisa don:
    // yine de gonder - bir API kesintisi butun yorum akisini durdurmasin.
    const detail = await getTeslimDurumu(orderNumber);
    console.log("YORUM TESLIM DURUMU:", orderNumber, "->", JSON.stringify(detail));

    if (detail && detail.status && detail.status !== "DLV") {
      const not = detail.reasonId ? detail.status + "/" + detail.reasonId : detail.status;
      console.log("YORUM: siparis teslim edilmemis (" + not + "), yorum istegi ATLANIYOR:", orderNumber);
      await logYorumToSheets(phone, name, orderNumber, "ATLANDI: teslim edilmemis (" + not + ")");
      return res.status(200).send("OK - teslim edilmemis, yorum istegi gonderilmedi");
    }

    // detail null (durum bilinmiyor) VEYA detail.status === "DLV" -> gonder
    const waResp = await fetchWithTimeout(
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
            name: TEMPLATE_NAME,
            language: { code: TEMPLATE_LANG },
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: name }
                ]
              }
            ]
          }
        })
      },
      8000
    );
    const waData = await waResp.json();
    console.log("YORUM WHATSAPP SONUCU:", JSON.stringify(waData));

    // Gercek gonderim durumunu Sheets'e yaz
    const waStatus = readWaStatus(waData);
    await logYorumToSheets(phone, name, orderNumber, waStatus);

    return res.status(200).send("OK - sent");
  } catch (error) {
    console.error("YORUM HATA:", error && error.message ? error.message : error);
    return res.status(200).send("OK");
  }
};
