export default async function handler(req, res) {
  // Sadece mesaj gönderme (POST) işlemlerine izin ver
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Sadece POST metodu geçerlidir." });
  }

  // Şifrenin Vercel'e girilip girilmediğini kontrol et
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "API Anahtarı bulunamadı." });
  }

  try {
    // Claude'a bağlanıyoruz
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 500,
        messages: req.body.messages
      })
    });

    const data = await response.json();
    return res.status(200).json(data);
    
  } catch (error) {
    return res.status(500).json({ error: "Sunucu hatası oluştu." });
  }
}
