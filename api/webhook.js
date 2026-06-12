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

    return res.status(403).send("Forbidden");
  }

  if (req.method === "POST") {
    console.log("POST DATA:");
    console.log(JSON.stringify(req.body, null, 2));

    return res.status(200).send("OK");
  }

  return res.status(200).send("OK");
};
