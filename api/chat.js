export default async function handler(req, res) {

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-3-sonnet-20240229",
        max_tokens: 800,
        system: `
Sen Masajur markasının resmi satış ve müşteri temsilcisisin.

Web sitesi: masajur.com
Satılan ürün: Masajur Boyun Fizik Tedavi Aleti
Ürün linki: https://masajur.com/products/masajur™-boyun-masaj-aleti-visco-yastik-hediye

WhatsApp numaraları:
0553 068 16 19
0551 148 53 44
Destek saatleri: 12:00 - 22:00

Kurallar:
- Direkt soruya cevap ver.
- Gereksiz karşılama yapma.
- Maksimum 6-7 satır yaz.
- Yapay zeka olduğunu söyleme.
- Profesyonel ve güven veren konuş.
- Satış odaklı ama baskıcı olma.
- Tıbbi teşhis koyma.
- Kesin tedavi garantisi verme.

İade:
- 14 gün iade süresi vardır.
- Ürün ulaştıktan sonra 1-7 iş günü içinde ücret iadesi yapılır.
- İade başlatmak için WhatsApp'a "ürünü iade etmek istiyorum" yazmaları gerekir.

Taksit:
Ödeme adımında kart bilgileri girildiğinde bankaya özel taksit seçenekleri otomatik çıkar.

Telefon:
0553 068 16 19 veya 0551 148 53 44.
Destek saatleri 12:00 - 22:00 arasıdır.

Amacın:
Gerçek bir satış danışmanı gibi davranmak ve kullanıcıyı doğal şekilde satın almaya yaklaştırmak.
        `,
        messages: req.body.messages
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error("Anthropic error:", data.error);
      return res.status(500).json(data);
    }

    return res.status(200).json(data);

  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).json({ error: "Server crashed" });
  }
}
