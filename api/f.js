// Puente de archivos públicos de Supabase Storage (escudos, fotos .json, reglamento, foto del admin).
// El sitio ya no los pide directo a Supabase sino a /api/f?p=<bucket>/<archivo>: Vercel guarda la
// respuesta en su CDN (Vercel-CDN-Cache-Control), así Supabase entrega cada archivo UNA vez cada
// tantos segundos/horas en vez de una vez por visitante — era el grueso del Egress del plan gratis.
//
// - Fotos .json: el CDN de Vercel las guarda 20s (los resultados en vivo siguen al día), pero al
//   navegador y a los proxies de operadoras se les manda no-store (ver el problema de proxies
//   móviles en cargarSegundaFaseDesdeSnapshot() de index.html). Se mandan comprimidas en gzip:
//   la de Estadísticas pesa ~4.9MB sin comprimir y Vercel corta respuestas de más de 4.5MB.
// - Imágenes/PDF: 6h en el CDN y en el navegador.
const zlib = require("zlib");

const BASE = (process.env.SUPABASE_URL || "https://fnbxddmnotzqoquizfit.supabase.co") + "/storage/v1/object/public/";
const PERMITIDO = /^(escudos|docs|LogoAdmin)\/[A-Za-z0-9._%\-\/]+$/;

module.exports = async (req, res) => {
  const p = String(req.query.p || "");
  if (!PERMITIDO.test(p) || p.includes("..")) return res.status(400).end();

  let upstream;
  try {
    upstream = await fetch(BASE + p);
  } catch (e) {
    return res.status(502).end();
  }

  const esFoto = p.endsWith(".json");
  if (!upstream.ok) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vercel-CDN-Cache-Control", "max-age=10");
    return res.status(upstream.status === 404 ? 404 : 502).end();
  }

  const tipo = upstream.headers.get("content-type");
  const lm = upstream.headers.get("last-modified");
  if (tipo) res.setHeader("Content-Type", tipo);
  if (lm) res.setHeader("Last-Modified", lm);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "Last-Modified");

  if (esFoto) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vercel-CDN-Cache-Control", "max-age=20");
  } else {
    res.setHeader("Cache-Control", "public, max-age=21600");
    res.setHeader("Vercel-CDN-Cache-Control", "max-age=21600, stale-while-revalidate=86400");
  }

  let body = Buffer.from(await upstream.arrayBuffer());
  if (esFoto && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
    body = zlib.gzipSync(body);
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
  }
  res.setHeader("Content-Length", body.length);
  if (req.method === "HEAD") return res.status(200).end();
  return res.status(200).end(body);
};
