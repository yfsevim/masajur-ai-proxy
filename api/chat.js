export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: "ANTHROPIC_API_KEY not found in environment variables"
    });
  }

  try {
    console.log("HIT CHAT FUNCTION");

    const anthropicResponse = await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-3-haiku-20240307", // önce bunu test et
          max_tokens: 800,
          system: `Sen Masajur markasının resmi satış temsilcisisin.`,
          messages: req.body.messages.map((m) => ({
            role: m.role,
            content: [
              {
                type: "text",
                text: m.content
              }
            ]
          }))
        })
      }
    );

    const data = await anthropicResponse.json();

    console.log("ANTHROPIC RAW RESPONSE:", data);

    if (!anthropicResponse.ok) {
      return res.status(anthropicResponse.status).json(data);
    }

    return res.status(200).json(data);

  } catch (error) {
    console.error("SERVER CRASH:", error);
    return res.status(500).json({
      error: "Server crashed",
      details: error.message
    });
  }
}
