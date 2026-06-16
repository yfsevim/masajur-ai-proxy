// api/kargo.js - Yurtici (eski TLS sunucu) icin https modulu + gevsek TLS ayari
// Agresif retry: ilk istek soguk/asili gelirse hizlica kes, hemen yeniden dene.
// Her deneme 3sn, en fazla 4 deneme. addHistoricalData=true (sube/sehir/tarih).
const https = require("https");

const YK_HOST = "ws.yurticikargo.com";
const YK_PATH = "/KOPSWebServices/ShippingOrderDispatcherServices";
const YK_USER = process.env.YK_USER;
const YK_PASS = process.env.YK_PASS;
const YK_LANG = "TR";

const REQ_TIMEOUT_MS = 3000; // her deneme kisa beklesin
const MAX_TRIES = 4;         // soguk istekleri hizla atlayip yeniden dene

function buildSoap(key) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="http://yurticikargo.com.tr/ShippingOrderDispatcherServices">' +
    '<soapenv:Header/><soapenv:Body>' +
    '<ser:queryShipment>' +
    '<wsUserName>' + YK_USER + '</wsUserName>' +
    '<wsPassword>' + YK_PASS + '</wsPassword>' +
    '<wsLanguage>' + YK_LANG + '</wsLanguage>' +
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
function fmtDate(d, t) {
  if (!d || d.length < 8) return null;
  const day = d.slice(6, 8), mon = d.slice(4, 6), yr = d.slice(0, 4);
  let time = "";
  if (t && t.length >= 4) { const tt = ("000000" + t).slice(-6); time = " " + tt.slice(0,2) + ":" + tt.slice(2,4); }
  return day + "." + mon + "." + yr + time;
}

// Tek deneme
function soapPostOnce(body) {
  return new Promise(function (resolve, reject) {
    const options = {
      host: YK_HOST,
      port: 443,
      path: YK_PATH,
      method: "POST",
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
    req.setTimeout(REQ_TIMEOUT_MS, function () { req.destroy(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

// Gecerli XML donene kadar dene. Timeout veya bos cevapta tekrar dener.
async function soapPost(body) {
  let lastErr;
  for (let i = 1; i <= MAX_TRIES; i++) {
    try {
      const xml = await soapPostOnce(body);
      // bazen baglanti aciliyor ama bos/yarim cevap donuyor; bunu da retry say
      if (xml && xml.indexOf("queryShipment") !== -1 || (xml && xml.indexOf("operationMessage") !== -1)) {
        return xml;
      }
      if (xml && xml.length > 50) return xml; // dolu bir cevapsa kabul et
      console.error("KARGO DENEME " + i + ": bos/kisa cevap, tekrar deneniyor");
      lastErr = new Error("empty");
      continue;
    } catch (e) {
      lastErr = e;
      console.error("KARGO DENEME " + i + " HATA:", e && e.message ? e.message : e);
      continue; // timeout dahil her durumda kalan deneme varsa tekrar dene
    }
  }
  throw lastErr || new Error("timeout");
}

function parseXml(xml, key) {
  const operationMessage = tag(xml, "operationMessage");
  const operationStatus = tag(xml, "operationStatus");
  const trackingUrl = tag(xml, "trackingUrl");
  const receiver = tag(xml, "receiverInfo");
  const events = [];
  const re = /<invDocCargoVOArray>([\s\S]*?)<\/invDocCargoVOArray>/g;
  let mm;
  while ((mm = re.exec(xml)) !== null) {
    const b = mm[1];
    events.push({ unit: tag(b,"unitName"), event: tag(b,"eventName"), city: tag(b,"cityName"), town: tag(b,"townName"), date: tag(b,"eventDate"), time: tag(b,"eventTime") });
  }
  if (!operationMessage && events.length === 0) return { found: false, reason: "not_found", orderNumber: key };
  const last = events.length ? events[events.length - 1] : null;
  return {
    found: true, orderNumber: key,
    statusMessage: operationMessage, statusCode: operationStatus,
    lastEvent: last ? last.event : null,
    lastUnit: last ? last.unit : null,
    lastCity: last ? (last.town + " / " + last.city) : null,
    lastDate: last ? fmtDate(last.date, last.time) : null,
    deliveredTo: (operationStatus === "DLV") ? receiver : null,
    trackingUrl: trackingUrl
  };
}

module.exports = async (req, res) => {
  let orderNumber;
  if (req.method === "GET") orderNumber = req.query && req.query.key;
  else orderNumber = req.body && req.body.orderNumber;

  if (!orderNumber) return res.status(200).json({ found: false, reason: "no_number" });
  const key = String(orderNumber).replace(/[^0-9]/g, "");
  if (!key) return res.status(200).json({ found: false, reason: "no_number" });

  try {
    const xml = await soapPost(buildSoap(key));
    return res.status(200).json(parseXml(xml, key));
  } catch (error) {
    console.error("KARGO ERROR:", error && error.message ? error.message : error);
    return res.status(200).json({ found: false, reason: "error", detail: (error && error.message) ? error.message : String(error) });
  }
};
