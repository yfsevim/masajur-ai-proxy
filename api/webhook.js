module.exports = async (req, res) => {
console.log("WEBHOOK CALLED");
  const VERIFY_TOKEN = "masajur123";

  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
  }

  if (req.method === "POST") {
    console.log(JSON.stringify(req.body, null, 2));
    return res.sendStatus(200);
  }

  return res.sendStatus(200);
};
