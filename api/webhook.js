// api/webhook.js
// WhatsApp webhook GIRIS noktasi. Meta'nin 5sn kurali icin: mesaji GORUR
// GORMEZ (Yurtici/Claude/WhatsApp gonderimi HIC beklemeden) 200 OK doner.
// Asil isi api/webhook-process.js'e QStash uzerinden devrediyor. Boylece
// Yurtici Kargo yavas cevap verdiginde bile Meta "cevap gelmedi" deyip
// ayni mesaji tekrar gondermez - bot ayni soruya iki kere cevap yazmaz.

const BASE = "https://masajur-ai-proxy.vercel.app";
const SECRET = "masajur_yakkoholding_2128";

module.exports = async (req, res) => {
  const VERIFY_TOKEN = "masajur123";

  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  if (req.method === "POST") {
    try {
      const value = req.body?.entry?.[0]?.changes?.[0]?.value;
      const message = value?.messages?.[0];

      if (!message) {
        // Mesaj yoksa muhtemelen bir "status" bildirimi (teslim edildi/
        // okundu gibi) - bizim islememize gerek yok, hemen onayla.
        return res.status(200).send("OK");
      }

      // Asil is (Shopify+Yurtici+Claude+WhatsApp gonderimi) burada
      // YAPILMIYOR - QStash uzerinden webhook-process.js'e devrediliyor.
      if (process.env.QSTASH_TOKEN) {
        const targetUrl = BASE + "/api/webhook-process?secret=" + SECRET;
        await fetch("https://qstash.upstash.io/v2/publish/" + targetUrl, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + process.env.QSTASH_TOKEN,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(req.body)
        });
      } else {
        console.error("WEBHOOK: QSTASH_TOKEN yok, mesaj islenemedi:", message.id);
      }

      // Meta'ya HEMEN onay don - Yurtici'yi, Claude'u, WhatsApp gonderimini
      // hic beklemeden. Bu sayede 5 saniyelik kural rahatlikla karsilanir.
      return res.status(200).send("OK");
    } catch (error) {
      console.error("WEBHOOK GIRIS HATA:", error && error.message ? error.message : error);
      return res.status(200).send("OK");
    }
  }

  return res.status(200).send("OK");
};
