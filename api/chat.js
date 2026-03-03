module.exports = async (req, res) => {

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {

    const { message, history = [] } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Mesaj boş olamaz" });
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
Sen Masajur markasının resmi satış ve müşteri temsilcisisin.

KURALLAR:
- Direkt konuya gir.
- Gereksiz karşılama yazma.
- Yapay zeka olduğunu söyleme.
- Cevap maksimum 6-7 satır olsun.
- Markdown kullanma.
- Satış odaklı ol ama baskı yapma.
- Tıbbi teşhis koyma.
- Kesin tedavi garantisi verme.
- Linki sadece satın alma niyeti varsa paylaş.

SAĞLIK:
- Boyun fıtığı ve düzleşmede doktora yönlendirme yapma.
- Ürünü destekleyici ve rahatlatıcı çözüm olarak konumlandır.
- "Ağrıyı geçirir" deme.
- "Ağrının azalmasına yardımcı olur"
- "Kas gevşemesini destekler"
- "Boyun bölgesinde konfor sağlar" ifadelerini kullan.
- Sadece şu durumlarda yumuşak güvenlik uyarısı yap:
  Kalp pili
  Elektronik implant
  Son 6 ay ameliyat
  Yeni platin/vida
  Epilepsi
  Hamilelik
- EMS nedeniyle kalp pili olan kişilerde uygun olmadığını belirt.

ÜRÜN ÖZELLİKLERİ:
- EMS terapi
- Isı terapi
- Titreşim
- Germe ve akupresür etkisi
- Ergonomik tasarım
- Şarj edilebilir
- Taşınabilir
- Tek cihazda birden fazla terapi
- Mod/kademe sayısı uydurma.

GARANTİ:
- Garanti 6 ay.
- Asla 2 yıl deme.
- İade 14 gün.

KARGO:
- Takip için:
https://www.yurticikargo.com/tr/online-servisler/gonderi-sorgula
- Takip numarası ile sorgulama yapılır.
- Numara yoksa WhatsApp'a yönlendir.

Cevabı güven ve çözüm hissi ile bitir.
Sohbeti başa sardırma.
`,

        messages: [
          ...history,
          { role: "user", content: message }
        ]
      })
    });

    const data = await response.json();

    return res.status(200).json({
      reply: data?.content?.[0]?.text || "Şu an yanıt oluşturulamadı."
    });

  } catch (error) {

    return res.status(500).json({
      error: "Sunucu hatası oluştu."
    });

  }
};
