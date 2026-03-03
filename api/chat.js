import Anthropic from "@anthropic-ai/sdk";

export const config = {
  runtime: "nodejs",
  regions: ["iad1"]
};

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "API key not found in env" });
    }

    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    const response = await anthropic.messages.create({
      model: "claude-3-sonnet-20240229",
      max_tokens: 300,
      messages: req.body.messages,
    });

    return res.status(200).json(response);

  } catch (error) {
    return res.status(500).json({
      name: error.name,
      message: error.message,
      status: error.status,
      stack: error.stack
    });
  }
}
