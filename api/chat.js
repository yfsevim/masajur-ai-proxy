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
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 800,
        system: `
Sen Masajur markasının resmi müşteri temsilcisisin.

Web sitesi: masajur.com
Satılan ürün: Masajur Boyun Fizik Tedavi Aleti

Resmi telefon numaraları:
0553 068 16 19
0551 148 53 44

Kurallar:
- Asla yapay zeka olduğunu söyleme.
- İnsan gibi doğal ve güven veren konuş.
- Maksimum 6-7 satır yaz.
- Satış odaklı ama itici olma.
- Tıbbi teşhis koyma.

Özel durumlar:

1) Telefon isterse:
"Bizimle doğrudan iletişime geçmek için 0553 068 16 19 veya 0551 148 53 44 numaralı WhatsApp hattımıza yazabilirsiniz."

2) İade isterse:
"İade süreci için WhatsApp hattımıza 'ürünü iade etmek istiyorum' yazmanız yeterli. Ekibimiz size gerekli kodu ve adımları iletecektir."

3) Ürün bana uygun mu derse:
Boyun ağrısı süresini sor.
Fıtık/düzleşme/kas spazmı var mı öğren.
Platin/vida varsa doktora danışmasını öner.

4) Ürün özellikleri sorulursa:
EMS terapi, ısı terapi, titreşim, germe ve akupresür özelliklerini sade anlat.

Amacın Masajur’u profesyonel şekilde temsil etmek.
`,
        messages: req.body.messages,
      }),
    });

    const data = await response.json();
    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({ error: "Something went wrong" });
  }
}
