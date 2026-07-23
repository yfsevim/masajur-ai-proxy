// api/teslim-kontrol.js
// QStash tarafindan cagrilir. Siparisin Yurtici Kargo durumunu kontrol eder.
// Henuz teslim edilmediyse (DLV degilse) belirli bir sure sonra kendini
// yeniden zamanlar. Teslim edildiyse fatura-kes.js'i tetikler.
//
// Akis: fulfillment.js (kargoya verildi webhook'u) -> ilk teslim-kontrol
//       gorevini QStash'e birakir -> bu dosya calisir -> DLV degilse
//       kendini X saat sonraya yeniden zamanlar -> DLV olunca fatura-kes'i cagirir.

const https = require("https");

const SECRET = "masajur_yakkoholding_2128";
const RECHECK_DELAY = "1h";       // 6h -> 1h: teslimat tespiti cok daha hizli olsun
// fatura-baslat.js ilk kontrolu 1 gun sonra baslatiyor. Buradan itibaren
// 1 saatte bir kontrol edilirse 96 deneme = 4 gun -> toplam ~5 gun (oncekiyle ayni sinir).
// NOT: 1 saatlik aralik, QStash gorev sayisini 6 kata cikarir - hacim arttikca
// (gunde 30+ siparis) QStash kullanim kotasini takip etmekte fayda var.
const MAX_DENEME = 96;
// NOT: Bu sinira ulasilirsa fatura KESILMEZ. Sadece Google Sheets'e alarm
// kaydi dusulur, sen Mysoft panelinden manuel kontrol edip karar verirsin.
// Sadece gercekten "teslim edildi" (DLV) onayi gelen siparislere fatura kesilir.

const YK_HOST = "ws.yurticikargo.com";
const YK_PATH = "/KOPSWebServices/ShippingOrderDispatcherServices";
const YK_USER = process.env.YK_USER;
const YK_PASS = process.env.YK_PASS;
const REQ_TIMEOUT_MS = 8000;   // Yurtiçi bazen yavaş cevap veriyor (16sn'ye kadar gorduk).
                                // vercel.json'da bu fonksiyona 30sn suresi taninmis durumda,
                                // 3 deneme x 8sn = en kotu ihtimalle 24sn, sinirin icinde kalir.
const MAX_TRIES = 3;   // kargo.js ile ayni: ayni calisma icinde 3 kere dene

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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

// kargo.js'deki ile ayni mantik: bos/hatali cevapta ayni calisma icinde
// 3 kere ust uste dener. Uc denemede de basarisiz olursa hata firlatir
// (disaridaki handler bunu yakalayip RECHECK_DELAY suresi sonraya yeniden zamanlar).
async function soapPostWithRetry(body) {
  let lastErr;
  for (let i = 1; i <= MAX_TRIES; i++) {
    try {
      const xml = await soapPostOnce(body);
      if (xml && xml.length > 50) return xml;
      lastErr = new Error("bos cevap");
      console.error("TESLIM-KONTROL SOAP DENEME " + i + ": bos cevap");
    } catch (e) {
      lastErr = e;
      console.error("TESLIM-KONTROL SOAP DENEME " + i + " HATA:", e && e.message ? e.message : e);
    }
  }
  throw lastErr || new Error("bilinmeyen SOAP hatasi");
}

async function getKargoStatus(orderNumber) {
  const xml = await soapPostWithRetry(buildSoap(orderNumber));
  const operationStatus = tag(xml, "operationStatus");
  return operationStatus; // "DLV" = teslim edildi, null/baska deger = henuz degil
}

// Bir sonraki kontrolu QStash'e birak
async function scheduleRecheck(orderNumber, deneme) {
  if (!process.env.QSTASH_TOKEN) {
    console.log("QSTASH_TOKEN yok, tekrar deneme birakilamadi");
    return;
  }
  const targetUrl = "https://masajur-ai-proxy.vercel.app/api/teslim-kontrol?secret=" + SECRET;
  await fetch("https://qstash.upstash.io/v2/publish/" + targetUrl, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.QSTASH_TOKEN,
      "Content-Type": "application/json",
      "Upstash-Delay": RECHECK_DELAY
    },
    body: JSON.stringify({ orderNumber: orderNumber, deneme: deneme + 1 })
  });
}

// Teslim edildi -> fatura-kes.js'i tetikle
async function triggerFatura(orderNumber) {
  const url = "https://masajur-ai-proxy.vercel.app/api/fatura-kes?secret=" + SECRET;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderNumber: orderNumber })
  });
  const data = await resp.json().catch(() => ({}));
  console.log("TESLIM-KONTROL: fatura-kes tetiklendi:", JSON.stringify(data));
}

// 5 gun gecmesine ragmen teslim onayi gelmediyse: fatura KESILMEZ,
// sadece Google Sheets'e alarm kaydi dusulur (manuel kontrol icin).
async function logTeslimAlarmToSheets(orderNumber, deneme) {
  try {
    if (!process.env.SHEETS_URL) {
      console.error("SHEETS_URL yok, alarm kaydedilemedi:", orderNumber);
      return;
    }
    await fetchWithTimeout(process.env.SHEETS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "fatura_alarm",
        orderNumber: orderNumber,
        deneme: deneme,
        status: "5 GUN GECTI - TESLIM ONAYLANAMADI - FATURA KESILMEDI - MANUEL KONTROL GEREKLI"
      })
    }, 8000);
    console.log("TESLIM-KONTROL: alarm Sheets'e kaydedildi:", orderNumber);
  } catch (e) {
    console.error("TESLIM-KONTROL ALARM LOG HATA:", e && e.message ? e.message : e);
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("OK");

  const secret = req.query && req.query.secret;
  if (secret !== SECRET) {
    console.error("TESLIM-KONTROL: gecersiz secret");
    return res.status(401).send("Unauthorized");
  }

  try {
    const body = req.body || {};
    const orderNumber = body.orderNumber ? String(body.orderNumber) : "";
    const deneme = body.deneme || 1;

    if (!orderNumber) {
      console.error("TESLIM-KONTROL: siparis no yok");
      return res.status(200).send("OK");
    }

    console.log("TESLIM-KONTROL:", orderNumber, "deneme:", deneme);

    const status = await getKargoStatus(orderNumber);
    console.log("TESLIM-KONTROL DURUM:", orderNumber, "->", status);

    if (status === "DLV") {
      await triggerFatura(orderNumber);
      return res.status(200).send("OK - teslim edildi, fatura tetiklendi");
    }

    if (deneme >= MAX_DENEME) {
      console.error("TESLIM-KONTROL: max deneme asildi (5 gun), siparis:", orderNumber);
      await logTeslimAlarmToSheets(orderNumber, deneme);
      return res.status(200).send("OK - 5 gun asildi, alarm kaydedildi, fatura kesilmedi");
    }

    await scheduleRecheck(orderNumber, deneme);
    return res.status(200).send("OK - henuz teslim edilmedi, tekrar zamanlandi");
  } catch (error) {
    console.error("TESLIM-KONTROL HATA:", error && error.message ? error.message : error);
    // Hata olsa da tekrar dene (aginin gecici sorunu olabilir)
    try {
      const body = req.body || {};
      if (body.orderNumber) await scheduleRecheck(String(body.orderNumber), body.deneme || 1);
    } catch (e2) {}
    return res.status(200).send("OK");
  }
};
