// api/fb-debug.js
// GECICI TESHIS ENDPOINT'I - sorun cozulunce silinebilir.
// Amac: Meta'nin bu token'i hangi Sayfa icin tanidigini ve o Sayfanin
// gercekten "feed" alanina abone olup olmadigini DOGRUDAN Graph API'den sormak.

const SECRET = "masajur_yakkoholding_2128";
const FB_PAGE_ID = "902600429599178";

module.exports = async (req, res) => {
  if (req.query.secret !== SECRET) {
    return res.status(401).send("Unauthorized");
  }

  const token = process.env.FACEBOOK_ACCESS_TOKEN;
  if (!token) {
    return res.status(500).json({ error: "FACEBOOK_ACCESS_TOKEN env degiskeni bulunamadi" });
  }

  const sonuc = {};

  try {
    // 1) Bu token hangi Sayfa'ya ait? (Page Access Token'in "me" cagrisi kendi Sayfasini dondurur)
    const meResp = await fetch(
      `https://graph.facebook.com/v23.0/me?fields=id,name&access_token=${token}`
    );
    sonuc.token_sahibi_sayfa = await meResp.json();
  } catch (e) {
    sonuc.token_sahibi_sayfa_hata = e.message;
  }

  try {
    // 2) FB_PAGE_ID (902600429599178) icin hangi Sayfa bilgisi donuyor?
    const pageResp = await fetch(
      `https://graph.facebook.com/v23.0/${FB_PAGE_ID}?fields=id,name&access_token=${token}`
    );
    sonuc.kod_icindeki_page_id_bilgisi = await pageResp.json();
  } catch (e) {
    sonuc.kod_icindeki_page_id_hata = e.message;
  }

  try {
    // 3) Bu Sayfa gercekten bizim App'e abone mi, hangi alanlarla?
    const subResp = await fetch(
      `https://graph.facebook.com/v23.0/${FB_PAGE_ID}/subscribed_apps?access_token=${token}`
    );
    sonuc.abonelik_durumu = await subResp.json();
  } catch (e) {
    sonuc.abonelik_durumu_hata = e.message;
  }

  return res.status(200).json(sonuc, null, 2);
};
