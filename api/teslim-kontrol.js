// api/teslim-kontrol.js
// QStash tarafindan cagrilir. Siparisin Yurtici Kargo durumunu kontrol eder.
// Henuz teslim edilmediyse (DLV degilse) belirli bir sure sonra kendini
// yeniden zamanlar. Teslim edildiyse fatura-kes.js'i tetikler.
//
// Akis: fulfillment.js (kargoya verildi webhook'u) -> ilk teslim-kontrol
//       gorevini QStash'e birakir -> bu dosya calisir -> DLV degilse
//       kendini X saat sonraya yeniden zamanlar -> DLV olunca fatura-kes'i cagirir.
//
// Ayrica: kurye teslimatta basarisiz olursa (orn. Yurtici reason kodu "AAB" =
// Alici Adreste Bulunamadi, "MSA" = Musteri Subeden Alacak) musteriye bir
// kereye mahsus "subeden teslim alabilirsiniz" WhatsApp bildirimi gonderir
// (teslim_basarisiz sablonu).
//
// Yurtici Kargo sorgusu artik ../lib/yurtici.js'deki ORTAK istemciyi kullanir
// (webhook-process.js, teslim-kontrol.js ve yorum.js ayni koddan besleniyor).

const { Redis } = require("@upstash/redis");
const redis = Redis.fromEnv();
const yurtici = require("../lib/yurtici");

const SECRET = "masajur_yakkoholding_2128";
const RECHECK_DELAY = "1h";       // 6h -> 1h: teslimat tespiti cok daha hizli olsun
// fatura-baslat.js ilk kontrolu 1 gun sonra baslatiyor. Buradan itibaren
// 1 saatte bir kontrol edilirse 96 deneme = 4 gun -> toplam ~5 gun (oncekiyle ayni sinir).
const MAX_DENEME = 96;
// NOT: Bu sinira ulasilirsa fatura KESILMEZ. Sadece Google Sheets'e alarm
// kaydi dusulur, sen Mysoft panelinden manuel kontrol edip karar verirsin.
// Sadece gercekten "teslim edildi" (DLV) onayi gelen siparislere fatura kesilir.

// Teslim basarisiz (kapida bulunamadi) bildirimi icin sablon + tekrar
// gonderimi engelleyen Redis anahtari. AAB (Alici Adreste Bulunamadi) ve
// MSA (Musteri Subeden Alacak) - IGH (2 gunluk hat, otomatik tekrar
// denenecek) kasitli olarak DISINDA, cunku gercek bir sorun degil.
const FAILED_REASON_CODES = ["AAB", "MSA"];
const TESLIM_BASARISIZ_TEMPLATE = "teslim_basarisiz";
const TESLIM_BASARISIZ_LANG = "tr";

// Arka plan/batch isi oldugu icin webhook-process.js'in musteri sohbeti
// devre kesicisinden AYRI, kendi ortak anahtarini kullanir.
const cb = yurtici.createCircuitBreaker("yurtici-cb");

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getKargoDetail(orderNumber) {
  const raw = await yurtici.queryShipment(orderNumber, cb, "TESLIM-KONTROL");
  if (!raw) return null;
  return {
    status: raw.operationStatus,          // "DLV" = teslim edildi
    reasonId: raw.cargoReasonId,          // orn. "AAB"/"MSA"
    reasonExplanation: raw.cargoReasonExplanation,
    branch: raw.deliveryUnitName          // gonderinin bekledigi sube
  };
}

// Bir sonraki kontrolu QStash'e birak
async function scheduleRecheck(orderNumber, deneme, phone, name) {
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
    body: JSON.stringify({ orderNumber: orderNumber, deneme: deneme + 1, phone: phone, name: name })
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

// Ayni siparis icin "teslim basarisiz" bildirimini bir kereden fazla
// gondermemek icin Redis'te bayrak tutuyoruz (her saat tekrar denendigi icin).
async function alreadyNotifiedFailed(orderNumber) {
  try {
    const v = await redis.get("teslim-basarisiz-bildirildi:" + orderNumber);
    return !!v;
  } catch (e) {
    return false; // Redis erisilemezse guvenli taraf: bildirim gondermeye izin ver
  }
}
async function markNotifiedFailed(orderNumber) {
  try {
    await redis.set("teslim-basarisiz-bildirildi:" + orderNumber, "1", { ex: 30 * 24 * 3600 });
  } catch (e) {}
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

// Teslim basarisiz bildirimini Google Sheets'e yaz (type:teslim_basarisiz)
async function logTeslimBasarisizToSheets(phone, name, orderNumber, branch, status) {
  try {
    if (!process.env.SHEETS_URL) return;
    await fetchWithTimeout(process.env.SHEETS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "teslim_basarisiz",
        phone: phone,
        name: name,
        orderNumber: orderNumber,
        branch: branch,
        status: status
      })
    }, 8000);
  } catch (e) {
    console.error("TESLIM-KONTROL: teslim-basarisiz Sheets log HATA:", e && e.message ? e.message : e);
  }
}

// Kurye teslim edemedi (orn. AAB/MSA) -> musteriye "subeden teslim alabilirsiniz" mesaji
async function sendTeslimBasarisizMesaji(phone, name, orderNumber, branch) {
  let waStatus;
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
          to: phone,
          type: "template",
          template: {
            name: TESLIM_BASARISIZ_TEMPLATE,
            language: { code: TESLIM_BASARISIZ_LANG },
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: String(name || "Merhaba") },
                  { type: "text", text: String(orderNumber) },
                  { type: "text", text: String(branch || "en yakın şube") }
                ]
              }
            ]
          }
        })
      },
      8000
    );
    const data = await resp.json().catch(() => ({}));
    console.log("TESLIM-KONTROL: teslim-basarisiz mesaji sonucu:", JSON.stringify(data));
    waStatus = readWaStatus(data);
  } catch (e) {
    console.error("TESLIM-KONTROL: teslim-basarisiz mesaji HATA:", e && e.message ? e.message : e);
    waStatus = "GITMEDI HATA: " + (e && e.message ? e.message : e);
  }
  await logTeslimBasarisizToSheets(phone, name, orderNumber, branch, waStatus);
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
    const phone = body.phone ? String(body.phone) : "";
    const name = body.name ? String(body.name) : "Merhaba";

    if (!orderNumber) {
      console.error("TESLIM-KONTROL: siparis no yok");
      return res.status(200).send("OK");
    }

    console.log("TESLIM-KONTROL:", orderNumber, "deneme:", deneme);

    const detail = await getKargoDetail(orderNumber);
    console.log("TESLIM-KONTROL DURUM:", orderNumber, "->", JSON.stringify(detail));

    if (detail && detail.status === "DLV") {
      await triggerFatura(orderNumber);
      return res.status(200).send("OK - teslim edildi, fatura tetiklendi");
    }

    // Kurye teslim edemedi (orn. "AAB"/"MSA") ve musteriye daha once bildirim
    // gonderilmediyse: bir kereye mahsus "subeden teslim alabilirsiniz" mesajini gonder.
    if (detail && detail.reasonId && FAILED_REASON_CODES.includes(detail.reasonId) && phone) {
      const already = await alreadyNotifiedFailed(orderNumber);
      if (!already) {
        console.log("TESLIM-KONTROL: teslim basarisiz (" + detail.reasonId + "), bildirim gonderiliyor:", orderNumber);
        await sendTeslimBasarisizMesaji(phone, name, orderNumber, detail.branch);
        await markNotifiedFailed(orderNumber);
      }
    }

    if (deneme >= MAX_DENEME) {
      console.error("TESLIM-KONTROL: max deneme asildi (5 gun), siparis:", orderNumber);
      await logTeslimAlarmToSheets(orderNumber, deneme);
      return res.status(200).send("OK - 5 gun asildi, alarm kaydedildi, fatura kesilmedi");
    }

    await scheduleRecheck(orderNumber, deneme, phone, name);
    return res.status(200).send("OK - henuz teslim edilmedi, tekrar zamanlandi");
  } catch (error) {
    console.error("TESLIM-KONTROL HATA:", error && error.message ? error.message : error);
    // Hata olsa da tekrar dene (aginin gecici sorunu olabilir) - ama 5 gunluk
    // sinira ulasildiysa burada da alarm dusur, sonsuz donguye girmesin.
    try {
      const body = req.body || {};
      const deneme = body.deneme || 1;
      const phone = body.phone ? String(body.phone) : "";
      const name = body.name ? String(body.name) : "Merhaba";
      if (body.orderNumber) {
        if (deneme >= MAX_DENEME) {
          console.error("TESLIM-KONTROL: max deneme asildi (hata yolunda), siparis:", body.orderNumber);
          await logTeslimAlarmToSheets(String(body.orderNumber), deneme);
        } else {
          await scheduleRecheck(String(body.orderNumber), deneme, phone, name);
        }
      }
    } catch (e2) {}
    return res.status(200).send("OK");
  }
};
