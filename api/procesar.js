const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function callGemini(image, prompt) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: "image/png", data: image } },
            { text: prompt }
          ]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 8192,
          responseMimeType: "application/json"
        }
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    const msg = data.error?.message || "Error de Gemini";
    const isQuota = response.status === 429 || msg.toLowerCase().includes("quota");
    const err = new Error(msg);
    err.isQuota = isQuota;
    throw err;
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  const finishReason = data.candidates?.[0]?.finishReason || "";
  return { text, finishReason, provider: "gemini" };
}

async function callClaude(image, prompt) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8192,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: image } },
          { type: "text", text: prompt }
        ]
      }]
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || "Error de Claude");
  }

  const text = data.content?.[0]?.text || "{}";
  return { text, finishReason: data.stop_reason || "", provider: "claude" };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  // Verify authenticated user with rol=dueno
  const authHeader = req.headers["authorization"] || "";
  const userJwt = authHeader.replace("Bearer ", "").trim();
  if (!userJwt) return res.status(401).json({ error: "Unauthorized" });
  try {
    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${userJwt}` }
    });
    if (!authRes.ok) return res.status(401).json({ error: "Invalid session" });
    const authData = await authRes.json();
    const userId = authData?.id;
    if (!userId) return res.status(401).json({ error: "Invalid session" });

    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/perfiles?id=eq.${userId}&select=rol&limit=1`,
      { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    const perfilesRaw = await profileRes.text();
    let perfiles = [];
    try { perfiles = JSON.parse(perfilesRaw); } catch(e){}
    if (!Array.isArray(perfiles) || perfiles[0]?.rol !== "dueno")
      return res.status(403).json({ error: "Forbidden" });
  } catch(e) {
    return res.status(401).json({ error: "Auth check failed" });
  }

  try {
    const { image, prompt } = req.body;
    let result;

    try {
      result = await callGemini(image, prompt);
    } catch (geminiErr) {
      if (!geminiErr.isQuota) throw geminiErr;
      // Gemini quota exceeded — fall back to Claude
      result = await callClaude(image, prompt);
    }

    res.status(200).json({
      content: [{ type: "text", text: result.text }],
      finishReason: result.finishReason,
      provider: result.provider
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
