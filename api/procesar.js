export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();
 
  try {
    const { image, prompt } = req.body;
 
    // Hacemos la petición a la API de Groq (que imita el formato de OpenAI)
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}` // Usa tu nueva variable
      },
      body: JSON.stringify({
        model: "llama-3.2-90b-vision-preview", // Modelo gratuito de visión en Groq
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
        response_format: { type: "json_object" }, 
        temperature: 0.1
      })
    });
 
    const data = await response.json();
 
    if (!response.ok) {
      return res.status(500).json({ error: data.error?.message || "Error de la API" });
    }
 
    const text = data.choices?.[0]?.message?.content || "{}";
    const finishReason = data.choices?.[0]?.finish_reason || "";
 
    res.status(200).json({
      content: [{ type: "text", text: text }],
      finishReason
    });
 
  } catch (err) {
    console.error("Error al procesar la petición:", err);
    res.status(500).json({ error: err.message });
  }
}
