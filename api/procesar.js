const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function detectMime(base64) {
  if (base64.startsWith("/9j/"))   return "image/jpeg";
  if (base64.startsWith("iVBOR")) return "image/png";
  if (base64.startsWith("UklGR")) return "image/webp";
  return "image/jpeg";
}

function getGeminiKeys() {
  return [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY,
  ].filter(Boolean);
}

async function callGemini(key, model, image, prompt) {
  const mime = detectMime(image);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);

  let response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        signal: controller.signal,
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
            maxOutputTokens: 16384,
            responseMimeType: "application/json"
          }
        })
      }
    );
  } finally {
    clearTimeout(timer);
  }

  let data;
  try { data = await response.json(); }
  catch(e) { throw new Error(`${model}: respuesta no válida`); }

  if (!response.ok) {
    const msg = data.error?.message || `${model} HTTP ${response.status}`;
    const isRetryable = response.status === 429 || response.status === 503
      || msg.toLowerCase().includes("quota")
      || msg.toLowerCase().includes("overload")
      || msg.toLowerCase().includes("unavailable");
    const err = new Error(msg);
    err.isRetryable = isRetryable;
    throw err;
  }

  // Si el candidato fue bloqueado, no hay texto útil
  const blockReason = data.promptFeedback?.blockReason;
  if (blockReason) {
    const err = new Error(`Respuesta bloqueada por Gemini: ${blockReason}`);
    err.isRetryable = false;
    throw err;
  }

  const finishReason = data.candidates?.[0]?.finishReason || "";
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

  // Si el texto no empieza con '{', Gemini devolvió un mensaje de error en lugar de JSON
  if (!text || !text.trimStart().startsWith("{")) {
    const isRetryable = finishReason === "OTHER" || finishReason === "" || !text;
    const err = new Error(
      text
        ? `${model} devolvió texto no-JSON (sobrecarga o filtro): ${text.slice(0, 120)}`
        : `${model} devolvió respuesta vacía (motivo: ${finishReason || "desconocido"})`
    );
    err.isRetryable = isRetryable;
    throw err;
  }

  return { text, finishReason, provider: model };
}

// ── HANDLER ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

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

    const keys = getGeminiKeys();
    if (!keys.length) return res.status(500).json({ error: "No hay API keys de Gemini configuradas." });

    // Intentar: gemini-2.5-flash con cada key, luego gemini-1.5-flash como fallback
    const attempts = [
      ...keys.map(k => ({ key: k, model: "gemini-2.5-flash" })),
      ...keys.map(k => ({ key: k, model: "gemini-1.5-flash" })),
    ];

    let lastError;
    for (const { key, model } of attempts) {
      try {
        const result = await callGemini(key, model, image, prompt);
        return res.status(200).json({
          content: [{ type: "text", text: result.text }],
          finishReason: result.finishReason,
          provider: result.provider
        });
      } catch(err) {
        lastError = err;
        if (!err.isRetryable) break; // error definitivo (bloqueo, auth, etc) → no rotar
        // retryable (cuota, sobrecarga) → probar siguiente
      }
    }

    res.status(500).json({ error: lastError?.message || "Error procesando imagen." });

  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}
