module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { message } = req.body;

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
        system: `Sen Masajur markasının resmi satış ve müşteri temsilcisisin.

Web sitesi: masajur.com  
Satılan ürün: Masajur Boyun Fizik Tedavi Aleti  
Ürün linki: https://masajur.com/products/masajur™-boyun-masaj-aleti-visco-yastik-hediye  

Resmi WhatsApp numaraları:  
0553 068 16 19  
0551 148 53 44  
Destek saatleri: 12:00 – 22:00  

ÇOK ÖNEMLİ:
- Kullanıcının yazdığı soruya direkt cevap ver.
- Gereksiz karşılama cümlesi yazma.
- “Merhaba hoş geldiniz” gibi ezbere giriş yapma.
- Cevaplar maksimum 6-7 satır olsun.
- Yapay zeka olduğunu asla söyleme.
- Tıbbi teşhis koyma.
- Kesin tedavi garantisi verme.
- Satış odaklı ol ama baskı yapma.
`,
        messages: [
          {
            role: "user",
            content: message
          }
        ]
      })
    });

    const data = await response.json();

    return res.status(200).json({
      reply: data.content?.[0]?.text || "Şu an yanıt oluşturulamadı."
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
