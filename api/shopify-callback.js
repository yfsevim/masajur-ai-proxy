// api/shopify-callback.js
// Shopify OAuth callback - gelen "code"u access token ile degistirir ve ekranda gosterir.

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

module.exports = async (req, res) => {
  try {
    const code = req.query && req.query.code;
    const shop = req.query && req.query.shop;

    res.setHeader("Content-Type", "text/html; charset=utf-8");

    if (!code || !shop) {
      return res.status(200).send(
        "<h2>Eksik parametre</h2><p>code veya shop gelmedi. Bu sayfa calisiyor, yukleme akisindan gelmen gerekiyor.</p>"
      );
    }

    const tokenResp = await fetch("https://" + shop + "/admin/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: code
      })
    });

    const data = await tokenResp.json();

    if (data && data.access_token) {
      return res.status(200).send(
        "<div style='font-family:sans-serif;max-width:700px;margin:40px auto;padding:20px;'>" +
        "<h2 style='color:green'>Token alindi!</h2>" +
        "<p>Bu token'i kopyala, Vercel'de SHOPIFY_TOKEN olarak kaydet, sonra redeploy yap.</p>" +
        "<textarea style='width:100%;height:80px;font-size:14px;padding:10px' readonly>" + data.access_token + "</textarea>" +
        "<p style='color:gray;font-size:13px'>Bu token shpat_ ile baslar. Guvende tut.</p>" +
        "</div>"
      );
    }

    return res.status(200).send(
      "<div style='font-family:sans-serif;max-width:700px;margin:40px auto;padding:20px;'>" +
      "<h2 style='color:red'>Token alinamadi</h2>" +
      "<pre style='background:#f4f4f4;padding:12px'>" + JSON.stringify(data) + "</pre>" +
      "</div>"
    );
  } catch (error) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send("<h2>Hata</h2><pre>" + (error && error.message ? error.message : String(error)) + "</pre>");
  }
};
