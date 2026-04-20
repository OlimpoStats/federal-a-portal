const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  // Verify the caller is an authenticated user with rol=dueno
  const authHeader = req.headers["authorization"] || "";
  const userJwt = authHeader.replace("Bearer ", "").trim();
  if (!userJwt) return res.status(401).json({ error: "Unauthorized" });
  try {
    const userRes = await fetch(`${SUPABASE_URL}/rest/v1/perfiles?select=rol&limit=1`, {
      headers: {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${userJwt}`,
      }
    });
    const perfiles = await userRes.json().catch(()=>[]);
    if (!Array.isArray(perfiles) || perfiles[0]?.rol !== "dueno")
      return res.status(403).json({ error: "Forbidden" });
  } catch(e) {
    return res.status(401).json({ error: "Auth check failed" });
  }
 
  try {
    const { image, prompt } = req.body;
 
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
      return res.status(500).json({ error: data.error?.message || "Error de Gemini" });
    }
 
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const finishReason = data.candidates?.[0]?.finishReason || "";
 
    // Si se cortó por tokens, devolver igual con advertencia
    res.status(200).json({
      content: [{ type: "text", text: text }],
      finishReason
    });
 
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
 
