const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function getGeminiKeys() {
  const keys = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY,
  ].filter(Boolean);
  return keys;
}

async function callGeminiWithKey(key, image, prompt) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
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
  return { text, finishReason };
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
    const keys = getGeminiKeys();

    if (!keys.length) return res.status(500).json({ error: "No hay API keys de Gemini configuradas." });

    let lastError;
    for (const key of keys) {
      try {
        const result = await callGeminiWithKey(key, image, prompt);
        return res.status(200).json({
          content: [{ type: "text", text: result.text }],
          finishReason: result.finishReason
        });
      } catch (err) {
        lastError = err;
        if (!err.isQuota) break; // error que no es de cuota → no sirve rotar
        // cuota agotada → probar siguiente key
      }
    }

    res.status(500).json({ error: lastError?.message || "Error procesando imagen." });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
