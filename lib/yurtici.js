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
// 2026-09-05 DUZELTME: hesap artik Vercel Pro'da, cagiran dosyalarin
// (teslim-kontrol.js 180sn, webhook-process.js 90sn, yorum.js 60sn) hepsinde
// bol vakit var - eskiden 8sn/deneme + 20sn toplam sinir, Yurtici hafif
// yavas oldugunda bile sorguyu ERKEN VE GEREKSIZ YERE basarisiz sayip
// "sorgu basarisiz"/devre kesici hata sayacini artiriyordu. Artik daha
// sabirli: 10sn/deneme, 30sn toplam sert sinir (3 deneme + backoff icin
// yeterli).
const YK_REQ_TIMEOUT_MS = 10000;
const YK_MAX_TRIES = 2;   // 2026-09-28: 3 -> 2 (kota tasarrufu)
const YK_HARD_DEADLINE_MS = 30000;

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

// 2026-09-28 TESHIS EKLENDI: her sey "bos cevap" diye loglaniyordu, HTTP
// durum kodu hic bakilmiyordu - yani Yurtici 403/407/502 donse bile sebebi
// goremiyorduk. Artik durum kodu ve govdenin ilk 200 karakteri loglaniyor.
// Ayrica modul yuklenirken yapilandirma ozeti basiliyor (DEGERLER DEGIL,
// sadece "VAR"/"EKSIK") - eksik ortam degiskenini saniyede gormek icin.
console.log("YURTICI ISTEMCI: proxy=" + (process.env.QUOTAGUARDSTATIC_URL ? "VAR" : "YOK") +
  " | YK_USER=" + (YK_USER ? "VAR" : "EKSIK") +
  " | YK_PASS=" + (YK_PASS ? "VAR" : "EKSIK") +
  " | node=" + process.version);

// 2026-09-28 EKLENDI - SORGU ONBELLEGI
// Ayni siparis hem saatlik QStash zincirinden hem 30 dakikalik taramadan
// sorgulanabiliyordu; ayni cevap icin iki kez proxy kotasi yaniyordu.
// Artik basarili cevaplar 20 dakika Redis'te tutuluyor. Kargo durumu 20
// dakikada bir degisen bir sey degil, veri tazeligi acisindan kayip yok.
const CACHE_SANIYE = 20 * 60;
let _cacheRedis = null;
function cacheRedis() {
  if (!_cacheRedis) { try { _cacheRedis = Redis.fromEnv(); } catch (e) { _cacheRedis = null; } }
  return _cacheRedis;
}
async function onbellektenOku(key) {
  try {
    const r = cacheRedis(); if (!r) return null;
    const v = await r.get("yk-sorgu:" + key);
    if (!v) return null;
    return typeof v === "string" ? JSON.parse(v) : v;
  } catch (e) { return null; }
}
async function onbellegeYaz(key, sonuc) {
  try {
    const r = cacheRedis(); if (!r) return;
    await r.set("yk-sorgu:" + key, JSON.stringify(sonuc), { ex: CACHE_SANIYE });
  } catch (e) {}
}

// 2026-09-28 EKLENDI - PROXY ARIZASI ALARMI
// QuotaGuard kotasi doldugunda sistem GUNLERCE sessizce calismadi, kimse
// fark etmedi. Artik yetki/proxy hatasi gorulunce Google Sheets'e alarm
// dusuyor (6 saatte bir, spam olmasin diye). Hata disari yayilmaz.
async function proxyAlarmi(durum, detay) {
  try {
    const r = cacheRedis(); if (!r) return;
    const bayrak = "yk-proxy-alarm";
    const varMi = await r.get(bayrak);
    if (varMi) return;
    await r.set(bayrak, "1", { ex: 6 * 3600 });
    if (!process.env.SHEETS_URL) return;
    await fetch(process.env.SHEETS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "fatura_alarm",
        orderNumber: "SISTEM",
        deneme: 0,
        status: "!!! KARGO SORGUSU CALISMIYOR - PROXY HTTP " + durum +
          " - QuotaGuard kotasi dolmus veya sifre gecersiz olabilir. " +
          "Fatura kesme, teslimat gunu mesaji ve kapidan donen alarmlari DURDU. " +
          "Detay: " + String(detay || "").slice(0, 200)
      })
    });
    console.error("YURTICI: PROXY ALARMI Sheets'e dusuruldu (HTTP " + durum + ")");
  } catch (e) {}
}

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
      // DEGISTI: artik sadece govdeyi degil, HTTP durum kodunu da donduruyoruz.
      resp.on("end", function () { resolve({ status: resp.statusCode, body: data }); });
    });
    req.on("error", function (e) { reject(e); });
    req.setTimeout(YK_REQ_TIMEOUT_MS, function () { req.destroy(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

// 2026-09-28: proxy/yetki hatalarinda (401/403/407) TEKRAR DENEMEK ANLAMSIZ -
// bu hatalar kendiliginden duzelmez, her deneme QuotaGuard kotasindan bir
// istek daha yakar. 22.187 istekle aylik 20.000 limitin asilmasinin sebeplerinden
// biri tam buydu: proxy 407 donmeye basladigi anda her sorgu 1 yerine 3 istek
// harcamaya baslamisti. Artik bu durumda ilk denemede pes ediyoruz.
function yetkiHatasiMi(durum) {
  return durum === 401 || durum === 403 || durum === 407;
}

async function soapPostWithRetry(body, logPrefix) {
  let lastErr;
  for (let i = 1; i <= YK_MAX_TRIES; i++) {
    try {
      const cevap = await soapPostOnce(body);
      const xml = (cevap && cevap.body) || "";
      const durum = cevap ? cevap.status : 0;
      if (durum >= 200 && durum < 300 && xml.length > 50) return xml;
      // Neyin ters gittigini artik ACIKCA yaziyoruz: durum kodu + govde uzunlugu
      // + govdenin basi. Proxy hatasi, kimlik hatasi ve gercek bos cevap
      // boylece birbirinden ayirt edilebiliyor.
      const ozet = xml.replace(/\s+/g, " ").slice(0, 200);
      lastErr = new Error("HTTP " + durum + " / govde " + xml.length +
        " karakter: " + (ozet || "(tamamen bos)"));
      console.error(logPrefix + " SOAP DENEME " + i + ": " + lastErr.message);
      if (yetkiHatasiMi(durum)) {
        lastErr.yetkiHatasi = true;
        lastErr.durum = durum;
        console.error(logPrefix + ": PROXY/YETKI HATASI (" + durum + ") - tekrar denenmeyecek, kota bosa harcanmasin");
        throw lastErr;
      }
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

// 2026-09-02 KRITIK DUZELTME: Yurtici, bir paket musteriye ulastirilamayip
// GONDERENE (bize) iade oldugunda da operationStatus="DLV" ("teslim edildi")
// donduruyor - cunku paket gercekten "teslim edilmis" oluyor, sadece
// musteriye degil, bizim kendi sirketimize. Bu durumda receiverCustName
// musterinin adi degil, kendi sirket unvanimiz oluyor (gercek Yurtici
// panelinde dogrulandi - "İade Durumu" filtresiyle bulunan siparislerde
// Alici Adi = "YAKKO MEDIKAL VE TIBBI URUNLER SANAYI VE TICARET LIMITED
// SIRKETI"). Bu ayrimi yapmadan ham DLV'ye guvenmek, iade olan siparislere
// yanlislikla fatura kesilmesine ve musteriye yanlislikla "teslim edildi"
// denmesine yol aciyordu. Asagidaki KENDI_SIRKET_ADI_DESENI ile bu
// ayirt ediliyor.
const KENDI_SIRKET_ADI_DESENI = /yakko/i;

// 2026-09-02 UCUNCU DUZELTME (#12415 vakasi, debug-kargo ile GERCEK XML
// cevabi incelendi): Yurtici, alici pakati kabul etmeyip iade ettiginde
// "Alici Adi"nda musteri ismini AYNEN BIRAKIYOR (bizim sirket adimiza
// degismiyor) - asil kesin sinyal ayri iki alanda geliyor:
//   rejectStatus / rejectStatusExplanation  -> orn. "10" / "İade Sonlandırıldı"
//   rejectDescription / rejectReasonExplanation -> orn. "AKE" /
//     "Alıcı Kabul Etmedi (Ücret, Ürün Bedeli, Eksik İrsaliye/Fatura vb.)"
// Bu alanlar dolu geldiginde operationStatus "DLV" olsa bile paket
// GERCEKTEN musteriye ulasmis/kabul edilmis SAYILMAZ.
//
// Ayrica onceki "ham XML'de 'iade' kelimesi var mi" kontrolu /iade/i
// regex'i ile yapiliyordu - bu, Turkce buyuk "İ" harfini (U+0130)
// JavaScript'in varsayilan Unicode kucuk harfe cevirmesi "iade" ile
// ESLESMEDIGI icin "İade Sonlandırıldı" gibi degerleri KACIRIYORDU (bizzat
// #12415'te oldugu gibi - bu yuzden bir onceki "guvenlik agi" da bu vakayi
// yakalayamadi). Asagida buyuk/kucuk Turkce I varyantlarinin hepsi acikca
// listelenerek bu hata da giderildi.
function turkceIadeGeciyorMu(metin) {
  if (!metin) return false;
  return metin.indexOf("iade") !== -1 ||
    metin.indexOf("İade") !== -1 ||
    metin.indexOf("IADE") !== -1 ||
    metin.indexOf("İADE") !== -1 ||
    metin.indexOf("Iade") !== -1;
}

// 2026-09-03 DORDUNCU DUZELTME (gercek Sheets verisiyle bulundu, "Manuel
// Kontrol Gerekli" sekmesinde beklenenden cok satir birikince incelendi):
// rejectStatus alaninin TEK BASINA dolu olmasi da YETERLI DEGILMIS. Yurtici,
// GERCEKTEN VE BASARIYLA teslim edilmis - operationMessage="Kargo teslim
// edilmistir.", gercek deliveryDate/deliveryTime, gercek kurye adi (delEmpName)
// olan - siparislerde bile rejectStatus="7" / rejectStatusExplanation=
// "Teslim Iptal" / rejectDescription="POS Entegrasyon" donduruyor. Bu, kargo
// tahsilat/POS entegrasyonuyla ilgili AYRI bir ic durum kodu olup paketin
// fiziksel olarak iade edildigi anlamina GELMIYOR. debug-kargo ile 6 gercek
// siparis (12450, 12494, 12503, 12510, 12513, 12529) dogrulandi: hepsi bu
// kaliba uyuyor ve hepsinde rejectReasonExplanation aynen "Sorun Yok" (Yurtici
// kendisi "sorun yok" diyor). Buna karsilik GERCEK iadelerde (rejectStatus=
// "10" / "Iade Sonlandirildi") rejectReasonExplanation HER ZAMAN somut bir
// sebep icermisti (orn. "Alici Kabul Etmedi...", "Adres Sorunu...", "Musteri
// Istegi"), asla "Sorun Yok" degildi.
// Bu yuzden artik rejectStatus dolu olsa BILE, rejectReasonExplanation acikca
// "Sorun Yok" diyorsa iade SAYILMIYOR. Bilinmeyen/bos bir aciklama durumunda
// ise (Yurtici'nin "sorun yok" demedigi her durum) BILINCLI OLARAK eski
// (temkinli) davranis korunuyor - yani supheli sayilmaya devam ediyor, cunku
// bir faturanin YANLISLIKLA kesilmesi, bir faturanin manuel kontrole
// dusmesinden cok daha kotu bir sonuc.
function turkceSorunYokMu(metin) {
  if (!metin) return false;
  return metin.trim().toLowerCase() === "sorun yok";
}

// Ana fonksiyon: siparis numarasiyla Yurtici'yi sorgular, ham etiket
// degerlerini doner. Devre kesici aciksa veya sorgu basarisiz olursa null doner.
async function queryShipment(orderNumber, circuitBreaker, logPrefix) {
  const key = String(orderNumber).replace(/[^0-9]/g, "");
  if (!key) return null;

  // 2026-09-28: YK_USER/YK_PASS tanimli degilse buildSoap XML'e "undefined"
  // yaziyordu ve Yurtici anlasilmaz bir cevap donduruyordu. Artik net soyluyoruz.
  if (!YK_USER || !YK_PASS) {
    console.error(logPrefix + ": YK_USER veya YK_PASS ortam degiskeni TANIMLI DEGIL - Yurtici sorgusu yapilamaz");
    return null;
  }

  if (await circuitBreaker.isOpen()) {
    console.log(logPrefix + ": devre kesici ACIK, Yurtici'ye gidilmiyor");
    return null;
  }

  // 20 dakikalik onbellek - ayni siparis icin tekrar proxy kotasi yakma
  const onbellek = await onbellektenOku(key);
  if (onbellek) {
    console.log(logPrefix + ": onbellekten okundu (" + key + "), Yurtici'ye gidilmedi");
    return onbellek;
  }

  try {
    const xml = await Promise.race([
      soapPostWithRetry(buildSoap(key), logPrefix),
      hardDeadline(YK_HARD_DEADLINE_MS)
    ]);
    await circuitBreaker.recordSuccess();

    const operationStatus = tag(xml, "operationStatus");
    const receiverCustName = tag(xml, "receiverCustName");
    // DLV oldugu halde alici bizim kendi sirketimizse, bu gercek bir
    // musteri teslimati DEGIL - paket bize iade edilmis demektir.
    const adAdresEslesmesi = !!receiverCustName && KENDI_SIRKET_ADI_DESENI.test(receiverCustName);

    // #12415 debug-kargo cikisiyla dogrulanan KESIN sinyal:
    const rejectStatus = tag(xml, "rejectStatus");
    const rejectStatusExplanation = tag(xml, "rejectStatusExplanation");
    const rejectDescription = tag(xml, "rejectDescription");
    const rejectReasonExplanation = tag(xml, "rejectReasonExplanation");
    // rejectReasonExplanation acikca "Sorun Yok" diyorsa (Yurtici kendisi
    // "problem yok" demis), rejectStatus dolu olsa bile GERCEK bir iade
    // SAYILMIYOR (bkz. yukaridaki turkceSorunYokMu yorum bloğu, #12450 vb.
    // gercek vakalarla dogrulandi). Aciklama bos veya baska bir sey diyorsa
    // eski temkinli davranis (supheli say) aynen koruniyor.
    const rejectAcikcaSorunsuz = turkceSorunYokMu(rejectReasonExplanation);
    const reddedilmisVeIadeEdilmis = !!rejectStatus && rejectStatus.trim() !== "" &&
      rejectStatus.trim() !== "0" && !rejectAcikcaSorunsuz;

    // Turkce-farkli "iade" metin taramasi - artik/hala ikinci bir guvenlik
    // katmani olarak duruyor (rejectStatus alani bir gun bosaltilir/degisirse
    // diye), ama artik dogru calisiyor.
    const xmlIcindeIadeGeciyor = turkceIadeGeciyorMu(xml);

    const sirketeIadeEdildi = operationStatus === "DLV" &&
      (adAdresEslesmesi || reddedilmisVeIadeEdilmis || xmlIcindeIadeGeciyor);

    if (sirketeIadeEdildi) {
      const sebep = adAdresEslesmesi
        ? "alici adi kendi sirketimiz (" + receiverCustName + ")"
        : reddedilmisVeIadeEdilmis
          ? "rejectStatus dolu: " + rejectStatus + "/" + rejectStatusExplanation +
            (rejectDescription ? " (" + rejectDescription + ": " + rejectReasonExplanation + ")" : "")
          : "ham XML cevabinda 'iade' kelimesi gecti (hangi alanda oldugu debug-kargo ile kontrol edilebilir)";
      console.log(logPrefix + ": DLV ama supheli - PAKET MUSTERIYE GERCEKTEN TESLIM EDILMEMIS/KABUL EDILMEMIS OLABILIR (" + sebep + ")");
    }

    const sonuc = {
      operationMessage: tag(xml, "operationMessage"),
      operationStatus: operationStatus, // HAM deger - degistirilmedi, loglama/debug icin oldugu gibi kalir
      trackingUrl: tag(xml, "trackingUrl"),
      receiverCustName: receiverCustName,
      deliveryUnitName: tag(xml, "deliveryUnitName"),
      cargoEventExplanation: tag(xml, "cargoEventExplanation"),
      cargoReasonId: tag(xml, "cargoReasonId"),
      cargoReasonExplanation: tag(xml, "cargoReasonExplanation"),
      // YENI: tuketen taraflar (teslim-kontrol.js, yorum.js, webhook-process.js)
      // artik "operationStatus === 'DLV'" yerine BUNU kullanmali - gercekten
      // musteriye mi teslim edildi, yoksa bize mi iade edildi ayrimini yapar.
      gercektenMusteriyeTeslimEdildi: operationStatus === "DLV" && !sirketeIadeEdildi,
      sirketeIadeEdildi: sirketeIadeEdildi,
      // Iade/red sebebini okunabilir bicimde tasir - Sheets alarmlarinda ve
      // (ileride) musteri notlarinda "neden" gosterebilmek icin.
      rejectStatusExplanation: rejectStatusExplanation,
      rejectReasonExplanation: rejectReasonExplanation,
      // 2026-09-02: #12415 vakasi ile ortaya cikti ki sirketeIadeEdildi
      // tespiti (receiverCustName kendi sirket adimiz mi) TEK BASINA
      // YETERSIZ - Yurtici bazi iadelerde Alici Adi'ni musteri olarak
      // birakip "Teslim Alan" ve ayri bir "Iade Durumu" alaniyla isaretliyor,
      // bu alanlar asagida ozel olarak parse edilmedigi icin kacabiliyordu.
      // Ham XML'i de donduruyoruz ki hem debug endpoint'i hem ileride
      // eklenecek daha dogru tespit mantigi buna erisebilsin.
      rawXml: xml
    };

    // Onbellege HAM XML olmadan yaziyoruz - Redis'te gereksiz yer kaplamasin.
    // Donen nesnede rawXml yine var (debug ucu icin), sadece saklanmiyor.
    try {
      const saklanacak = Object.assign({}, sonuc);
      delete saklanacak.rawXml;
      await onbellegeYaz(key, saklanacak);
    } catch (e) {}

    return sonuc;
  } catch (e) {
    await circuitBreaker.recordFailure();
    console.error(logPrefix + ": kargo sorgu HATA:", e && e.message ? e.message : e);
    if (e && e.yetkiHatasi) {
      await proxyAlarmi(e.durum, e.message);
    }
    return null;
  }
}

module.exports = { createCircuitBreaker, queryShipment };
