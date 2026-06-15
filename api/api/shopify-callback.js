// api/shopify-callback.js
// Shopify OAuth callback - yükleme sonrası gelen "code"u access token ile değiştirir
// ve token'ı ekranda gösterir. Token'ı kopyalayıp SHOPIFY_TOKEN olarak kullanacaksın.
//
// Gerekli env değişkenleri:
//   SHOPIFY_CLIENT_ID      -> İstemci Kimliği (32c0a7d6557b4a5f38533e23ec2171d3)
//   SHOPIFY_CLIENT_SECRET  -> Gizli anahtar (shpss_...)

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

module.exports = async (req, res) => {
  try {
    const { code, shop, hmac, host } = req.query || {};

    if (!code || !shop) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(
        "<h2>Eksik parametre</h2><p>code veya shop gelmedi. Yukleme linkini kullanarak tekrar deneyin.</p>"
      );
    }

    // code -> access_token degisimi
    const tokenResp = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: code
      })
    });

    const data = await tokenResp.json().catch(() => ({}));

    res.setHeader("Content-Type", "text/html; charset=utf-8");

    if (data.access_token) {
      return res.status(200).send(`
        <div style="font-family:sans-serif;max-width:700px;margin:40px auto;padding:20px;">
          <h2 style="color:#0a0">Token alindi!</h2>
          <p>Asagidaki token'i kopyala ve Vercel'de <b>SHOPIFY_TOKEN</b> olarak kaydet, sonra redeploy yap.</p>
          <textarea style="width:100%;height:80px;font-size:14px;padding:10px;" readonly>${data.access_token}</textarea>
          <p style="color:#888;font-size:13px;">Bu token <b>shpat_</b> ile baslar. Guvende tut, kimseyle paylasma.</p>
        </div>
      `);
    } else {
      return res.status(200).send(`
        <div style="font-family:sans-serif;max-width:700px;margin:40px auto;padding:20px;">
          <h2 style="color:#c00">Token alinamadi</h2>
          <pre style="background:#f4f4f4;padding:12px;overflow:auto;">${JSON.stringify(data, null, 2)}</pre>
        </div>
      `);
    }
  } catch (error) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(
      `<h2>Hata</h2><pre>${(error && error.message) || error}</pre>`
    );
  }
};
