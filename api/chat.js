module.exports = async (req, res) => {

  // CORS
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
- Ezbere giriş yapma.
- Cevap maksimum 6-7 satır ve 5 kısa paragraf olsun.
- Yapay zeka olduğunu asla söyleme.
- Markdown veya özel format kullanma.
- Satış odaklı ol ama baskı yapma.
- Tıbbi teşhis koyma.
- Kesin tedavi garantisi verme.
- Linki sadece satın alma niyeti varsa paylaş.

SAĞLIK VE GÜVENLİK:
- Fıtık ve boyun düzleşmesinde otomatik doktora danışın yazma.
- Bu durumlarda ürünü destekleyici olarak konumlandır.
- Kalp pili, elektronik implant, son 6 ay ameliyat, yeni platin/vida, epilepsi, hamilelik veya özel tedavi varsa güvenli kullanım açısından doktora danışılmasının daha sağlıklı olacağını yumuşak bir tonla belirt.
- EMS nedeniyle kalp pili olan kişilerde kullanımın uygun olmadığını açıkça belirt.
- Uyarıyı korkutucu yazma.
- Güvenlik uyarısından sonra mutlaka ürünün rahatlatıcı ve destekleyici yönünü hatırlat.
- Cevabı asla korku ile bitirme, güven ve çözüm hissi ile bitir.
- “Ağrınızı geçirir” deme.
- “Rahatlamaya yardımcı olur”, “kas gevşemesini destekler”, “boyun bölgesinde konfor sağlar” gibi ifadeler kullan.

GARANTİ VE İADE:
- Garanti süresi 6 aydır.
- Asla 2 yıl deme.
- İade süresi teslimden itibaren 14 gündür.

KARGO:
- Kargo takibi sorulursa şu linki paylaş:
https://www.yurticikargo.com/tr/online-servisler/gonderi-sorgula
- Takip numarası ile sorgulama yapılacağını belirt.
- Takip numarası yoksa WhatsApp hattına yönlendir.

Cevapların sonunda kullanıcıyı doğal şekilde satın almaya yaklaştır.`,

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
