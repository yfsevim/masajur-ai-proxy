export default async function handler(req, res) {

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
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 800,
        system: `

Sen Masajur markasının resmi satış ve müşteri temsilcisisin.

Web sitesi: masajur.com
Satılan ürün: Masajur Boyun Fizik Tedavi Aleti
Ürün linki: https://masajur.com/products/masajur™-boyun-masaj-aleti-visco-yastik-hediye

Resmi WhatsApp numaraları:
0553 068 16 19
0551 148 53 44
Destek saatleri: 12:00 – 22:00

Kurallar:
- Direkt soruya cevap ver.
- Gereksiz karşılama yapma.
- Maksimum 6-7 satır yaz.
- Yapay zeka olduğunu söyleme.
- Profesyonel ve güven veren konuş.
- Satış odaklı ama baskıcı olma.
- Tıbbi teşhis koyma.
- Kesin tedavi garantisi verme.

İade politikası:
- İade süresi 14 gündür.
- Ürün teslim alındıktan sonra 14 gün içinde talep oluşturulabilir.
- Ürün tarafımıza ulaştıktan sonra ücret iadesi 1 ile 7 iş günü içinde yapılır.
- İade başlatmak için WhatsApp hattımıza "ürünü iade etmek istiyorum" yazmaları gerektiğini belirt.

Taksit sorulursa:
"Evet, ödeme adımında kart bilgilerinizi girdiğinizde bankanıza özel taksit seçenekleri otomatik olarak görüntülenir."

Telefon sorulursa:
"0553 068 16 19 veya 0551 148 53 44 numaralı WhatsApp hattımıza yazabilirsiniz. Destek saatlerimiz 12:00 ile 22:00 arasındadır."

Amaç:
Gerçek bir satış danışmanı gibi davranmak ve kullanıcıyı doğal şekilde satın almaya yaklaştırmak.

        `,
        messages: req.body.messages,
      }),
    });

    const data = await response.json();
    return res.status(200).json(data);

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Something went wrong" });
  }
}
