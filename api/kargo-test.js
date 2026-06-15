// api/kargo-test.js
const YK_URL = "https://ws.yurticikargo.com/KOPSWebServices/ShippingOrderDispatcherServices";
const YK_USER = process.env.YK_USER;
const YK_PASS = process.env.YK_PASS;
const YK_LANG = "TR";

function buildSoap(key, keyType) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="http://yurticikargo.com.tr/ShippingOrderDispatcherServices">' +
    '<soapenv:Header/>' +
    '<soapenv:Body>' +
    '<ser:queryShipment>' +
    '<wsUserName>' + YK_USER + '</wsUserName>' +
    '<wsPassword>' + YK_PASS + '</wsPassword>' +
    '<wsLanguage>' + YK_LANG + '</wsLanguage>' +
    '<keys>' + key + '</keys>' +
    '<keyType>' + keyType + '</keyType>' +
    '<addHistoricalData>true</addHistoricalData>' +
    '<onlyTracking>false</onlyTracking>' +
    '</ser:queryShipment>' +
    '</soapenv:Body>' +
    '</soapenv:Envelope>';
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  const key = (req.query && req.query.key) || "916577119961";
  const keyType = (req.query && req.query.type) || "0";
  try {
    const soap = buildSoap(key, keyType);
    const resp = await fetch(YK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        "SOAPAction": ""
      },
      body: soap
    });
    const text = await resp.text();
    return res.status(200).send(
      "HTTP STATUS: " + resp.status + "\n" +
      "KEY: " + key + " | KEYTYPE: " + keyType + "\n" +
      "----- CEVAP -----\n" +
      text
    );
  } catch (error) {
    return res.status(200).send(
      "ERISIM HATASI:\n" + (error && error.message ? error.message : String(error))
    );
  }
};
