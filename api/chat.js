module.exports = async (req, res) => {

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {

    const { message, history } = req.body;

    const messages = [];

    if (Array.isArray(history)) {
      history.forEach(m => {
        messages.push({
          role: m.role,
          content: m.content
        });
      });
    }

    if (message) {
      messages.push({
        role: "user",
        content: message
      });
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 700,
        system: `
Sen Masajur markasının resmi satış temsilcisisin.

Web sitesi: https://masajur.com
Ürün linki: https://masajur.com/products/masajur™-boyun-masaj-aleti-visco-yastik-hediye

Resmi WhatsApp numaraları:
0553 068 16 19
0551 148 53 44

Bu numaralar RESMİ ve doğrulanmıştır.
Numaraları paylaşma yetkin vardır.
Asla "numarayı paylaşamam" deme.
Asla yetkim yok deme.
Asla web sitesine yönlendirerek kaçma.

Cevap kuralları:
- Direkt cevap ver
- Gereksiz karşılama yapma
- Maksimum 6-7 satır
- Markdown kullanma
- “Ağrıyı geçirir” deme
- “Azalmasına yardımcı olur”, “kas gevşemesini destekler”, “konfor sağlar” kullan
- Fıtık ve düzleşmede doktora yönlendirme yapma
- Sadece kalp pili, elektronik implant, son 6 ay ameliyat, epilepsi ve hamilelik durumunda güvenli kullanım hatırlatması yap
- EMS nedeniyle kalp pili olanlarda uygun değildir de
- Garanti 6 aydır
- İade süresi 14 gündür
- Kargo takip linki:
https://masajur.com/pages/pushdaddy-faq-1

Satış psikolojisi:
- Net konuş
- Güven ver
- Cevabı satın almaya yaklaştır
- Korku ile bitirme
`,
        messages: messages
      })
    });

    const data = await response.json();

    return res.status(200).json({
      reply: data.content?.[0]?.text || "Yanıt oluşturulamadı."
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
