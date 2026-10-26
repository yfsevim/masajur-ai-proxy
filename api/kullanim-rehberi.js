// api/kullanim-rehberi.js
// 2026-09-06: fulfillment.js'in scheduleKullanimRehberi() fonksiyonu bu
// endpoint'i QStash uzerinden 1 GUN (ertesi gun ayni saat) GECIKMELI olarak
// cagirir. Amac: kargo bildirimi ile kullanim rehberi mesajinin ayni anda/
// arka arkaya gitmesini engellemek (ilk canli testte musteri bunu istemedi).
//
// Bu dosya SADECE bu tek gorevi yapar: kendisine QStash'ten gelen
// {orderNumber, phone, firstName} bilgisiyle onayli WhatsApp sablonunu
// gonderir. fulfillment.js'deki kargoBildirimKilidiAl() zaten siparis basina
// bu gorevin SADECE BIR KERE olusturulmasini garantiledigi icin burada ayrica
// bir mukerrer-onleme kontrolune gerek yok.
const SECRET = "masajur_yakkoholding_2128";
const KULLANIM_TEMPLATE_NAME = "urun_kullanim_rehberi_v1";
const TEMPLATE_LANG = "tr";

// --- SESSIZ SAAT (2026-10-26) ---
// 22:00 - 09:00 arasi musteriye mesaj gonderilmiyor.
// yorum.js ile AYNI desen: burayi QStash TEK SEFERLIK tetikliyor (kargodan
// 1 gun sonra). Sadece cikarsak rehber mesaji TAMAMEN KAYBOLUR; bu yuzden
// gorevi sabah 09:00'a erteleyip kuyruga geri koyuyoruz.
const SESSIZ_BASLANGIC = 22;
const SESSIZ_BITIS = 9;

function turkiyeSaati() {
  return (new Date().getUTCHours() + 3) % 24;
}

function sessizSaatteMiyiz() {
  const s = turkiyeSaati();
  return s >= SESSIZ_BASLANGIC || s < SESSIZ_BITIS;
}

function sabahaKalanSn() {
  const simdi = new Date();
  const saat = (simdi.getUTCHours() + 3) % 24;
  const dakika = simdi.getUTCMinutes();
  const kalanDakika = saat >= SESSIZ_BASLANGIC
    ? (24 - saat + SESSIZ_BITIS) * 60 - dakika
    : (SESSIZ_BITIS - saat) * 60 - dakika;
  return Math.max(60, kalanDakika * 60);
}

// Donen: true = ertelendi. false donerse cagiran taraf normal gonderime
// devam etmeli - erteleyemedik diye mesaji tamamen kaybetmek daha kotu.
async function sabahaErtele(govde) {
  try {
    if (!process.env.QSTASH_TOKEN) {
      console.log("KULLANIM-REHBERI: QSTASH_TOKEN yok, ertelenemedi - normal gonderime devam");
      return false;
    }
    const sn = sabahaKalanSn();
    const hedef = "https://masajur-ai-proxy.vercel.app/api/kullanim-rehberi?secret=" + SECRET;
    const resp = await fetch("https://qstash.upstash.io/v2/publish/" + hedef, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.QSTASH_TOKEN,
        "Content-Type": "application/json",
        "Upstash-Delay": sn + "s"
      },
      body: JSON.stringify(Object.assign({}, govde, { _ertelendi: true }))
    });
    const data = await resp.json().catch(function () { return {}; });
    if (data && data.messageId) {
      console.log("KULLANIM-REHBERI: sessiz saat, " + Math.round(sn / 60) + " dk sonraya ertelendi:", data.messageId);
      return true;
    }
    console.error("KULLANIM-REHBERI: erteleme basarisiz, normal gonderime devam:", JSON.stringify(data).slice(0, 200));
    return false;
  } catch (e) {
    console.error("KULLANIM-REHBERI: erteleme HATA, normal gonderime devam:", e && e.message ? e.message : e);
    return false;
  }
}

// WhatsApp API cevabindan gercek gonderim durumunu cikar.
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

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(200).send("OK");
  }
  const secret = req.query && req.query.secret;
  if (secret !== SECRET) {
    console.error("KULLANIM-REHBERI: gecersiz secret");
    return res.status(401).send("Unauthorized");
  }
  try {
    const body = req.body || {};
    const orderNumber = body.orderNumber;
    const phone = body.phone;
    const firstName = body.firstName || "Merhaba";

    if (!phone) {
      console.error("KULLANIM-REHBERI: telefon yok, mesaj gonderilemedi", orderNumber);
      return res.status(200).send("OK");
    }

    // Sessiz saat: gorevi sabaha ertele. _ertelendi bayragi ikinci kez
    // ertelemeyi onluyor.
    if (sessizSaatteMiyiz() && !body._ertelendi) {
      const ertelendi = await sabahaErtele({
        orderNumber: orderNumber, phone: phone, firstName: firstName
      });
      if (ertelendi) {
        return res.status(200).send("OK - sessiz saat, sabaha ertelendi");
      }
      // Ertelenemediyse asagidan normal akisa devam.
    }

    const waResp = await fetch(
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
            name: KULLANIM_TEMPLATE_NAME,
            language: { code: TEMPLATE_LANG },
            components: [
              {
                type: "body",
                parameters: [{ type: "text", text: String(firstName) }]
              }
            ]
          }
        })
      }
    );
    const waData = await waResp.json();
    console.log("KULLANIM REHBERI WHATSAPP SONUCU (siparis " + orderNumber + "):", JSON.stringify(waData));
    console.log("KULLANIM REHBERI WA DURUM:", readWaStatus(waData));

    return res.status(200).send("OK");
  } catch (error) {
    console.error("KULLANIM-REHBERI HATA:", error && error.message ? error.message : error);
    return res.status(200).send("OK");
  }
};
