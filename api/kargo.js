// api/kargo.js
// Yurtici queryShipment - siparis no (Shopify order name) ile canli kargo durumu.
// POST { orderNumber: "11583" }  -> JSON
// GET  /api/kargo?key=11583       -> ayni sorgu (tarayicidan test icin)

const YK_URL = "https://ws.yurticikargo.com/KOPSWebServices/ShippingOrderDispatcherServices";
const YK_USER = process.env.YK_USER;
const YK_PASS = process.env.YK_PASS;
const YK_LANG = "TR";

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
  if (t && t.length >= 4) {
    const tt = t.padStart(6, "0");
    time = " " + tt.slice(0, 2) + ":" + tt.slice(2, 4);
  }
  return day + "." + mon + "." + yr + time;
}

async function queryYurtici(key) {
  const resp = await fetch(YK_URL, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "" },
    body: buildSoap(key)
  });
  const xml = await resp.text();

  const operationMessage = tag(xml, "operationMessage");
  const operationStatus = tag(xml, "operationStatus");
  const trackingUrl = tag(xml, "trackingUrl");
  const receiver = tag(xml, "receiverInfo");

  const events = [];
  const re = /<invDocCargoVOArray>([\s\S]*?)<\/invDocCargoVOArray>/g;
  let mm;
  while ((mm = re.exec(xml)) !== null) {
    const block = mm[1];
    events.push({
      unit: tag(block, "unitName"),
      event: tag(block, "eventName"),
      city: tag(block, "cityName"),
      town: tag(block, "townName"),
      date: tag(block, "eventDate"),
      time: tag(block, "eventTime")
    });
  }

  if (!operationMessage && events.length === 0) {
    return { found: false, reason: "not_found", orderNumber: key };
  }

  const last = events.length ? events[events.length - 1] : null;
  const history = events.map(function (e) {
    return { event: e.event, unit: e.unit, city: e.city, town: e.town, date: fmtDate(e.date, e.time) };
  });

  return {
    found: true,
    orderNumber: key,
    statusMessage: operationMessage,
    statusCode: operationStatus,
    lastEvent: last ? last.event : null,
    lastUnit: last ? last.unit : null,
    lastCity: last ? (last.town + " / " + last.city) : null,
    lastDate: last ? fmtDate(last.date, last.time) : null,
    deliveredTo: (operationStatus === "DLV") ? receiver : null,
    trackingUrl: trackingUrl,
    history: history
  };
}

module.exports = async (req, res) => {
  try {
    let orderNumber;
    if (req.method === "GET") {
      orderNumber = req.query && req.query.key;
    } else {
      orderNumber = req.body && req.body.orderNumber;
    }

    if (!orderNumber) return res.status(200).json({ found: false, reason: "no_number" });
    const key = String(orderNumber).replace(/[^0-9]/g, "");
    if (!key) return res.status(200).json({ found: false, reason: "no_number" });

    const result = await queryYurtici(key);
    return res.status(200).json(result);
  } catch (error) {
    console.error("KARGO ERROR:", error && error.message ? error.message : error);
    return res.status(200).json({ found: false, reason: "error", detail: (error && error.message) ? error.message : String(error) });
  }
};
