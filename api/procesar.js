export default async function handler(req, res) {
  // Configuración de seguridad (CORS) - No se toca
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();
 
  try {
    const { image, prompt } = req.body;
 
    // Hacemos la petición directa a la API de OpenAI
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Aquí toma automáticamente tu clave de Vercel
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini", // Modelo económico y eficiente
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${image}`
                }
              }
            ]
          }
        ],
        response_format: { type: "json_object" }, // Obliga a devolver un JSON limpio
        temperature: 0.1
      })
    });
 
    const data = await response.json();
 
    // Si OpenAI devuelve un error (por ejemplo, sin saldo o clave incorrecta)
    if (!response.ok) {
      return res.status(500).json({ error: data.error?.message || "Error de OpenAI" });
    }
 
    // Extraemos la respuesta
    const text = data.choices?.[0]?.message?.content || "{}";
    const finishReason = data.choices?.[0]?.finish_reason || "";
 
    // Devolvemos el formato exacto que espera tu index.html
    res.status(200).json({
      content: [{ type: "text", text: text }],
      finishReason
    });
 
  } catch (err) {
    console.error("Error al procesar la petición:", err);
    res.status(500).json({ error: err.message });
  }
}
