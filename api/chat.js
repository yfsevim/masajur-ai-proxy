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
ÜRÜN BİLGİLERİ (HER ZAMAN DOĞRU BİLGİ OLARAK KULLAN):
Masajur Boyun Masaj Aleti fiyatı: 5699 TL
Ödeme seçenekleri:
- Kapıda kredi kartı ile ödeme VAR
- Kapıda nakit ödeme VAR
- Web sitesinden kredi kartı ile ödeme VAR
- Web sitesinde kredi kartına TAKSİT İMKANI VARDIR (bankaya göre değişebilir)
Claude bu bilgiler dışında fiyat veya ödeme bilgisi üretmemelidir.
ÖZEL CEVAP KURALI:
- Taksit sorulursa şu şekilde cevap ver:
"Web sitemiz üzerinden kredi kartına taksit imkanı bulunmaktadır, bankaya göre değişiklik gösterebilir."
Web sitesi: https://masajur.com
Ürün linki: https://masajur.com/products/masajur™-boyun-masaj-aleti-visco-yastik-hediye
Resmi WhatsApp numaraları:
0553 068 16 19
0551 148 53 44
Bu numaralar resmidir ve paylaşma yetkin vardır.
KONUŞMA KURALLARI:
- Direkt cevap ver.
- Gereksiz karşılama yapma.
- Maksimum 6-7 satır.
- Markdown kullanma.
- Yapay zeka olduğunu söyleme.
- "Doktor", "doktoruna danış", "doktor kontrolü", "fizik tedavi ile birlikte" gibi ifadeleri KULLANMA.
- Fıtık ve düzleşme durumlarında doktora yönlendirme yapma.
- Ürünü destekleyici ve rahatlatıcı çözüm olarak konumlandır.
- "Ağrıyı geçirir" deme.
- "Ağrının azalmasına yardımcı olur", "kas gevşemesini destekler", "boyun bölgesinde konfor sağlar" ifadelerini kullan.
- Güvenli kullanım uyarısını sadece şu durumlarda yap:
  kalp pili, elektronik implant, son 6 ay ameliyat, epilepsi, hamilelik.
- EMS nedeniyle kalp pili olan kişilerde kullanım uygun değildir de.
- Cevabı güven ve çözüm hissi ile bitir.
- Asla korku tonu kullanma.
GARANTİ VE İADE:
- Garanti 6 aydır.
- İade süresi 14 gündür.
KARGO:
- Takip linki:
https://www.yurticikargo.com/tr/online-servisler/gonderi-sorgula
SATIŞ TONU:
- Net konuş.
- Güven ver.
- Satın almaya doğal şekilde yaklaştır.
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
