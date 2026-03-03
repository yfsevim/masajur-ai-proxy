import Anthropic from "@anthropic-ai/sdk";

export const config = {
  runtime: "nodejs",
};

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    const response = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: "Merhaba"
        }
      ],
    });

    return res.status(200).json(response);

  } catch (error) {
    return res.status(500).json({
      error: error.message
    });
  }
}
