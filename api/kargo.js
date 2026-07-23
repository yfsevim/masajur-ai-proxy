// api/kargo.js - Yurtici (ws.yurticikargo.com, HTTPS) - calisan surum
// addHistoricalData=false (hizli) + agresif retry. Eski TLS uyumlulugu.
const https = require("https");

const YK_HOST = "ws.yurticikargo.com";
const YK_PATH = "/KOPSWebServices/ShippingOrderDispatcherServices";
const YK_USER = process.env.YK_USER;
const YK_PASS = process.env.YK_PASS;
const YK_LANG = "TR";

const REQ_TIMEOUT_MS = 8000;   // 4000 -> 8000: Yurtici bazen 16sn'ye kadar yavas cevap veriyor
const MAX_TRIES = 3;

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
    '<addHistoricalData>false</addHistoricalData>' +
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

function soapPostOnce(body) {
  return new Promise(function (resolve, reject) {
    const options = {
      host: YK_HOST,
      port: 443,
      path: YK_PATH,
      method: "POST",
