// api/notificar-sugerencia.js - Manda un mail cuando alguien deja un comentario/sugerencia
// desde el modal de Contacto. Se llama desde enviarSugerencia() en index.html, después de
// insertar en la tabla "sugerencias" de Supabase (ese insert sigue siendo la fuente de verdad;
// esto es solo el aviso). Usa Resend porque no requiere SMTP y el plan gratis alcanza de sobra
// para el volumen de un sitio de estadísticas de liga amateur.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;
const RESEND_FROM = process.env.RESEND_FROM || "Ascenso Federal <onboarding@resend.dev>";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!RESEND_API_KEY || !NOTIFY_EMAIL) {
    // No corta el flujo del usuario que manda la sugerencia (esa ya se guardó en Supabase) —
    // solo avisa en los logs de Vercel que falta configurar el mail.
    console.warn("notificar-sugerencia: faltan RESEND_API_KEY / NOTIFY_EMAIL");
    return res.status(200).json({ ok: false, reason: "not_configured" });
  }

  const { texto, medio, remitente } = req.body || {};
  if (!texto || typeof texto !== "string" || !texto.trim()) {
    return res.status(400).json({ error: "texto requerido" });
  }
  const textoSeguro = texto.trim().slice(0, 1000);
  const medioSeguro = (medio || "").toString().trim().slice(0, 120);
  const remitenteSeguro = (remitente || "").toString().trim().slice(0, 120);

  const html = `
    <p><strong>Nuevo comentario/sugerencia en Ascenso Federal</strong></p>
    <p style="white-space:pre-wrap;">${escapeHtml(textoSeguro)}</p>
    ${remitenteSeguro ? `<p><strong>De:</strong> ${escapeHtml(remitenteSeguro)}</p>` : ""}
    ${medioSeguro ? `<p><strong>Medio de contacto:</strong> ${escapeHtml(medioSeguro)}</p>` : ""}
  `;

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [NOTIFY_EMAIL],
        subject: "Nueva sugerencia — Ascenso Federal",
        html,
      }),
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      console.error("notificar-sugerencia: Resend error", resp.status, errBody);
      return res.status(200).json({ ok: false, reason: "resend_error" });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("notificar-sugerencia: excepción", e.message);
    return res.status(200).json({ ok: false, reason: "exception" });
  }
};

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
