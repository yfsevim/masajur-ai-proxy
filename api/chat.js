module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const { message } = req.body;

  return res.status(200).json({
    reply: "Mesaj alındı: " + message
  });
};
