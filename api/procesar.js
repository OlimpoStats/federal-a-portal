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
    // Step 1: validate JWT and get user ID via Supabase Auth
    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${userJwt}` }
    });
    if (!authRes.ok) return res.status(401).json({ error: "Invalid session" });
    const authData = await authRes.json();
    const userId = authData?.id;
    if (!userId) return res.status(401).json({ error: "Invalid session" });

    // Step 2: check rol=dueno using service key (bypasses RLS)
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/perfiles?id=eq.${userId}&select=rol&limit=1`,
      { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    const perfilesRaw = await profileRes.text();
    let perfiles = [];
    try { perfiles = JSON.parse(perfilesRaw); } catch(e){}
    if (!Array.isArray(perfiles) || perfiles[0]?.rol !== "dueno")
      return res.status(403).json({
        error: "Forbidden",
        _d: { uid: userId?.slice(0,8), http: profileRes.status, isArr: Array.isArray(perfiles), len: Array.isArray(perfiles)?perfiles.length:0, rol: Array.isArray(perfiles)?perfiles[0]?.rol:perfilesRaw.slice(0,120) }
      });
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
 
