// api/webhook.js
// WhatsApp -> Shopify siparis + Yurtici kargo + Claude -> cevap
// Hobby plan (10sn limit) icin: siparis & kargo PARALEL + her fetch'e timeout.
// + Her mesaj Google Sheets'e kaydedilir (SHEETS_URL).

const BASE = "https://masajur-ai-proxy.vercel.app";

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function jsonFetch(url, body, ms) {
  const resp = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    },
    ms
  );
  return await resp.json();
}

// Sohbeti Google Sheets'e yaz (hata olsa bile akisi bozma)
async function logToSheets(phone, message, reply) {
  try {
    if (!process.env.SHEETS_URL) return;
    await fetchWithTimeout(
      process.env.SHEETS_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone, message: message, reply: reply })
      },
      4000
    );
  } catch (e) {
    console.error("SHEETS LOG HATA:", e && e.message ? e.message : e);
  }
}

module.exports = async (req, res) => {
  const VERIFY_TOKEN = "masajur123";

  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  if (req.method === "POST") {
    console.log("MESAJ GELDI");

    try {
      const value = req.body?.entry?.[0]?.changes?.[0]?.value;
      const message = value?.messages?.[0]?.text?.body;
      const phone = value?.messages?.[0]?.from;

      console.log("MESAJ:", message);
      console.log("TELEFON:", phone);

      if (!message || !phone) {
        console.log("MESAJ VEYA TELEFON YOK");
        return res.status(200).send("OK");
      }

      // ---------------------------------------------------------
      // SIPARIS + KARGO SORGUSU
      // ---------------------------------------------------------
      let orderNote = "";

      const lower = message.toLowerCase();
      const orderIntent =
        lower.includes("sipariş") ||
        lower.includes("siparis") ||
        lower.includes("kargo") ||
        lower.includes("takip") ||
        lower.includes("nerede");

      const hashMatch = message.match(/#\s*(\d{3,})/);
      const numMatch = message.match(/\b(\d{3,})\b/);
      const orderNumber = hashMatch ? hashMatch[1] : (numMatch ? numMatch[1] : null);

      if (orderNumber) {
        console.log("SIPARIS SORGUSU:", orderNumber);

        const sipPromise = jsonFetch(BASE + "/api/siparis", { orderNumber }, 6000)
          .then((d) => { console.log("SIPARIS SONUCU:", JSON.stringify(d)); return d; })
          .catch((e) => { console.error("SIPARIS HATA:", e?.message || e); return null; });

        const kargoPromise = jsonFetch(BASE + "/api/kargo", { orderNumber }, 6000)
          .then((d) => { console.log("KARGO SONUCU:", JSON.stringify(d)); return d; })
          .catch((e) => { console.error("KARGO HATA:", e?.message || e); return null; });

        const [sip, kargo] = await Promise.all([sipPromise, kargoPromise]);

        if ((sip && sip.found) || (kargo && kargo.found)) {
          orderNote =
            "[SİPARİŞ & KARGO BİLGİSİ - Aşağıdaki gerçek bilgileri kullanarak müşteriye doğal, sıcak ve net bir dille cevap ver. Asla bilgi uydurma, sadece bunları kullan. Kargo teslim edildiyse bunu olumlu söyle; yoldaysa nerede olduğunu ve güncel durumunu söyle.]\n";

          if (sip && sip.found) {
            orderNote += "Sipariş No: " + sip.orderName + "\n";
            orderNote += "Sipariş Durumu: " + sip.status + "\n";
            orderNote += "Ödeme: " + sip.payment + "\n";
          } else {
            orderNote += "Sipariş No: " + orderNumber + "\n";
          }

          if (kargo && kargo.found) {
            if (kargo.statusMessage) orderNote += "Kargo Durumu: " + kargo.statusMessage + "\n";
            if (kargo.lastEvent) orderNote += "Son Hareket: " + kargo.lastEvent + "\n";
            if (kargo.lastUnit) orderNote += "Bulunduğu Yer: " + kargo.lastUnit + (kargo.lastCity ? " (" + kargo.lastCity + ")" : "") + "\n";
            if (kargo.lastDate) orderNote += "Son Güncelleme: " + kargo.lastDate + "\n";
            if (kargo.statusCode === "DLV" && kargo.deliveredTo) orderNote += "Teslim Alan: " + kargo.deliveredTo + "\n";
            if (kargo.trackingUrl) orderNote += "Takip Linki: " + kargo.trackingUrl + "\n";
          } else {
            orderNote += "Kargo Durumu: Sipariş henüz kargoya verilmemiş olabilir veya kargo bilgisi sisteme düşmemiş olabilir. Müşteriye nazikçe siparişin hazırlandığını/yakında kargolanacağını söyle.\n";
          }
        } else if ((sip && sip.reason === "not_found") && (!kargo || !kargo.found)) {
          orderNote =
            "[SİSTEM NOTU: " + orderNumber + " numaralı sipariş bulunamadı. Müşteriye nazikçe sipariş numarasını kontrol etmesini söyle; emin değilse 0553 068 16 19 veya 0551 148 53 44 numaralarından yardımcı olunabileceğini belirt. Numara uydurma.]";
        } else {
          orderNote =
            "[SİSTEM NOTU: Sipariş/kargo bilgisine şu an ulaşılamadı. Müşteriye nazikçe biraz sonra tekrar denemesini ya da 0553 068 16 19 / 0551 148 53 44 numaralarından ulaşmasını söyle.]";
        }
      } else if (orderIntent) {
        orderNote =
          "[SİSTEM NOTU: Müşteri siparişini/kargosunu soruyor ama sipariş numarası vermedi. Ondan sipariş numarasını (#1234 gibi) iste ki kargo durumunu kontrol edebilesin. Doğal ve samimi bir dille sor.]";
      }
      // ---------------------------------------------------------

      console.log("CLAUDE'A GONDERILIYOR");

      const claudeMessage = orderNote
        ? orderNote + "\n\nMüşteri mesajı: " + message
        : message;

      let reply = "Yanıt oluşturulamadı.";
      try {
        const claudeData = await jsonFetch(BASE + "/api/chat", { message: claudeMessage }, 9000);
        reply = claudeData.reply || reply;
      } catch (e) {
        console.error("CLAUDE HATA:", e?.message || e);
        reply = "Şu an yoğunluk var, birkaç dakika sonra tekrar yazar mısın? Acil ise 0553 068 16 19'dan ulaşabilirsin.";
      }

      console.log("WHATSAPP'A GONDERILIYOR:", reply);

      const whatsappResponse = await fetch(
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
            type: "text",
            text: { body: reply }
          })
        }
      );

      const whatsappData = await whatsappResponse.json();
      console.log("WHATSAPP SONUCU:", JSON.stringify(whatsappData));

      // Sohbeti Sheets'e kaydet
      await logToSheets(phone, message, reply);

      return res.status(200).send("OK");
    } catch (error) {
      console.error("HATA:", error);
      return res.status(200).send("OK");
    }
  }

  return res.status(200).send("OK");
};
