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
    console.log("BODY:");
    console.log(JSON.stringify(req.body, null, 2));

    try {
      const value =
        req.body?.entry?.[0]?.changes?.[0]?.value;
      const message =
        value?.messages?.[0]?.text?.body;
      const phone =
        value?.messages?.[0]?.from;

      console.log("MESAJ:", message);
      console.log("TELEFON:", phone);

      if (!message || !phone) {
        console.log("MESAJ VEYA TELEFON YOK");
        return res.status(200).send("OK");
      }

      // ---------------------------------------------------------
      // SIPARIS SORGUSU TESPITI (A yöntemi)
      // ---------------------------------------------------------
      // Mesajda sipariş numarası var mı? (#1234 veya 3+ haneli rakam)
      let orderNote = ""; // Claude'a verilecek sistem notu

      const lower = message.toLowerCase();
      const orderIntent =
        lower.includes("sipariş") ||
        lower.includes("siparis") ||
        lower.includes("kargo") ||
        lower.includes("takip") ||
        lower.includes("nerede");

      // #1234  veya  4+ haneli rakam grubu yakala
      const hashMatch = message.match(/#\s*(\d{3,})/);
      const numMatch = message.match(/\b(\d{3,})\b/);
      const orderNumber = hashMatch
        ? hashMatch[1]
        : (numMatch ? numMatch[1] : null);

      if (orderNumber) {
        // Shopify'dan siparişi çek
        console.log("SIPARIS SORGUSU:", orderNumber);
        try {
          const sipResp = await fetch(
            "https://masajur-ai-proxy.vercel.app/api/siparis",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ orderNumber })
            }
          );
          const sip = await sipResp.json();
          console.log("SIPARIS SONUCU:", JSON.stringify(sip));

          if (sip.found) {
            let trackingText = "Henüz kargo takip numarası oluşmadı.";
            if (sip.tracking && sip.tracking.number) {
              trackingText =
                "Kargo takip no: " + sip.tracking.number +
                (sip.tracking.company ? " (" + sip.tracking.company + ")" : "");
            }
            orderNote =
              "[SİPARİŞ BİLGİSİ - bu bilgileri kullanarak müşteriye doğal ve sıcak bir dille cevap ver. Uydurma, sadece bunları kullan.]\n" +
              "Sipariş: " + sip.orderName + "\n" +
              "Durum: " + sip.status + "\n" +
              "Ödeme: " + sip.payment + "\n" +
              trackingText;
          } else if (sip.reason === "not_found") {
            orderNote =
              "[SİSTEM NOTU: " + orderNumber + " numaralı sipariş sistemde bulunamadı. Müşteriye nazikçe sipariş numarasını kontrol etmesini söyle; emin değilse 0553 068 16 19 veya 0551 148 53 44 numaralarından yardımcı olunabileceğini belirt. Numara uydurma.]";
          } else {
            orderNote =
              "[SİSTEM NOTU: Sipariş bilgisine şu an ulaşılamadı. Müşteriye nazikçe biraz sonra tekrar denemesini ya da 0553 068 16 19 / 0551 148 53 44 numaralarından ulaşmasını söyle.]";
          }
        } catch (e) {
          console.error("SIPARIS FETCH HATA:", e?.message || e);
          orderNote =
            "[SİSTEM NOTU: Sipariş bilgisine şu an ulaşılamadı. Müşteriye nazikçe 0553 068 16 19 veya 0551 148 53 44 numaralarından ulaşmasını söyle.]";
        }
      } else if (orderIntent) {
        // Sipariş/kargo soruyor ama numara vermemiş
        orderNote =
          "[SİSTEM NOTU: Müşteri siparişini/kargosunu soruyor ama sipariş numarası vermedi. Ondan sipariş numarasını (#1234 gibi) iste ki durumu kontrol edebilesin. Doğal ve samimi bir dille sor.]";
      }
      // ---------------------------------------------------------

      console.log("CLAUDE'A GONDERILIYOR");

      // Mesajı Claude'a gönder; sipariş notu varsa mesajın başına ekle
      const claudeMessage = orderNote
        ? orderNote + "\n\nMüşteri mesajı: " + message
        : message;

      const claudeResponse = await fetch(
        "https://masajur-ai-proxy.vercel.app/api/chat",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            message: claudeMessage
          })
        }
      );

      const claudeData = await claudeResponse.json();
      console.log("CLAUDE CEVABI:");
      console.log(claudeData);

      const reply =
        claudeData.reply || "Yanıt oluşturulamadı.";

      console.log("WHATSAPP'A GONDERILIYOR:");
      console.log(reply);

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
            text: {
              body: reply
            }
          })
        }
      );

      const whatsappData = await whatsappResponse.json();
      console.log("WHATSAPP SONUCU:");
      console.log(whatsappData);

      return res.status(200).send("OK");
    } catch (error) {
      console.error("HATA:");
      console.error(error);
      return res.status(200).send("OK");
    }
  }

  return res.status(200).send("OK");
};
