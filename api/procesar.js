const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function detectMime(base64) {
  if (base64.startsWith("/9j/"))   return "image/jpeg";
  if (base64.startsWith("iVBOR")) return "image/png";
  if (base64.startsWith("UklGR")) return "image/webp";
  return "image/jpeg";
}

// ── GROQ ─────────────────────────────────────────────────────────────────────
async function callGroq(key, image, prompt) {
  const mime = detectMime(image);
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`
    },
    body: JSON.stringify({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mime};base64,${image}` } },
          { type: "text", text: prompt }
        ]
      }],
      temperature: 0.1,
      max_tokens: 8192,
      response_format: { type: "json_object" }
    })
  });

  let data;
  try { data = await response.json(); }
  catch(e) { throw new Error("Groq: respuesta no válida"); }

  if (!response.ok) {
    const msg = data.error?.message || `Groq HTTP ${response.status}`;
    const err = new Error(msg);
    err.isQuota = response.status === 429;
    throw err;
  }

  const text = data.choices?.[0]?.message?.content || "{}";
  return { text, finishReason: data.choices?.[0]?.finish_reason || "", provider: "groq" };
}

// ── GEMINI ────────────────────────────────────────────────────────────────────
function getGeminiKeys() {
  return [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY,
  ].filter(Boolean);
}

async function callGeminiWithKey(key, image, prompt) {
  const mime = detectMime(image);
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mime, data: image } },
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

  let data;
  try { data = await response.json(); }
  catch(e) { throw new Error("Gemini: respuesta no válida (posible timeout)"); }

  if (!response.ok) {
    const msg = data.error?.message || `Gemini HTTP ${response.status}`;
    const isQuota = response.status === 429 || msg.toLowerCase().includes("quota");
    const err = new Error(msg);
    err.isQuota = isQuota;
    throw err;
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  return { text, finishReason: data.candidates?.[0]?.finishReason || "", provider: "gemini" };
}

// ── HANDLER ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  // Verificar usuario autenticado con rol=dueno
  const authHeader = req.headers["authorization"] || "";
  const userJwt = authHeader.replace("Bearer ", "").trim();
  if (!userJwt) return res.status(401).json({ error: "Unauthorized" });
  try {
    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${userJwt}` }
    });
    if (!authRes.ok) return res.status(401).json({ error: "Invalid session" });
    const authData = await authRes.json();
    if (!authData?.id) return res.status(401).json({ error: "Invalid session" });

    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/perfiles?id=eq.${authData.id}&select=rol&limit=1`,
      { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    let perfiles = [];
    try { perfiles = JSON.parse(await profileRes.text()); } catch(e) {}
    if (!Array.isArray(perfiles) || perfiles[0]?.rol !== "dueno")
      return res.status(403).json({ error: "Forbidden" });
  } catch(e) {
    return res.status(401).json({ error: "Auth check failed: " + e.message });
  }

  try {
    const { image, prompt } = req.body;
    if (!image || !prompt) return res.status(400).json({ error: "Faltan image o prompt." });

    const errors = [];

    // 1. Groq primero
    const groqKey = process.env.GROQ_Planillas_1;
    if (groqKey) {
      try {
        const result = await callGroq(groqKey, image, prompt);
        return res.status(200).json({
          content: [{ type: "text", text: result.text }],
          finishReason: result.finishReason,
          provider: result.provider
        });
      } catch(err) {
        errors.push(`Groq: ${err.message}`);
        // Cuota o error → caer a Gemini
      }
    }

    // 2. Gemini como fallback
    const geminiKeys = getGeminiKeys();
    if (!geminiKeys.length) {
      return res.status(500).json({ error: "No hay API keys configuradas. Errores: " + errors.join(" | ") });
    }

    let lastError;
    for (const key of geminiKeys) {
      try {
        const result = await callGeminiWithKey(key, image, prompt);
        return res.status(200).json({
          content: [{ type: "text", text: result.text }],
          finishReason: result.finishReason,
          provider: result.provider
        });
      } catch(err) {
        lastError = err;
        errors.push(`Gemini: ${err.message}`);
        if (!err.isQuota) break;
      }
    }

    res.status(500).json({ error: lastError?.message || "Error procesando imagen.", detail: errors.join(" | ") });

  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}
