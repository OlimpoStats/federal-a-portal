// api/snapshot-segunda-fase.js - Genera y sube la "foto" de Segunda Fase (Nonagonal A/B,
// Reválida A/B) que usa la home pública en vez de consultarle a Supabase en cada visita.
//
// Por qué existe: el 98% del Egress del sitio es PostgREST (no Storage/escudos) — cada carga
// de página volvía a pedir fixture completo + partidos "select *" + eventos con join anidado.
// Primera Fase (cerrada para siempre) ya se resolvió con una foto fija, generada una sola vez
// a mano. Segunda Fase sigue jugándose, así que esta foto se regenera sola cada vez que cambia
// algo real (sync-live.js) o cuando el admin corrige un resultado a mano.
//
// Mismo bucket y mismo formato que ya usa el cliente (_guardarCache()/_aplicarCache() en
// index.html): {ts, fichas, meta, pl, gol} — así el cliente no necesita lógica nueva para
// aplicar esta foto, reusa _aplicarCache() tal cual.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const GRUPOS2 = ["Nonagonal A", "Nonagonal B", "Reválida A", "Reválida B"];
const ZONAS_FILTRO = `(${GRUPOS2.map(z => `"${z}"`).join(",")})`;
const SNAPSHOT_PATH = "segunda-fase-snapshot.json";

async function sbGet(path, params) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}?${params}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!r.ok) throw new Error(`GET ${path} -> HTTP ${r.status}`);
  return r.json();
}

// PostgREST corta en 1000 filas sin paginar (encontrado acá: la consulta de goleadores/
// asistentes tiene 1100 filas reales — se estaban perdiendo ~100 en silencio, tanto acá como
// en el renderGoleadoresResumen() original del cliente, que tampoco pagina).
async function sbGetTodo(path, params) {
  let out = [], from = 0;
  while (true) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}?${params}`, {
      headers: {
        apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
        Range: `${from}-${from + 999}`,
      },
    });
    if (!r.ok) throw new Error(`GET ${path} -> HTTP ${r.status}`);
    const batch = await r.json();
    out = out.concat(batch);
    if (batch.length < 1000) break;
    from += 1000;
  }
  return out;
}

async function buildAndUploadSnapshot() {
  const [fixtureRows, partidosRows, eventosGoles, eventosResumen] = await Promise.all([
    sbGet(
      "fixture",
      `select=zona,fecha,equipo_local,equipo_visitante,goles_local,goles_visitante,dia,hora,stream_url,estadio,arbitro,estado,fotmob_url,minuto_actual&zona=in.${ZONAS_FILTRO}`
    ),
    sbGet(
      "partidos",
      `select=id,zona,fecha,equipo_local_nombre,equipo_visitante_nombre,fixture_id,dia,hora,stream_url,estadio,arbitro&zona=in.${ZONAS_FILTRO}`
    ),
    sbGet(
      "eventos",
      `select=tipo,minuto,planillas(partido_id,equipos(nombre),jugadores(nombre_display,nombre))&tipo=in.(gol,gol_penal,gol_tiro_libre,gol_contra)`
    ),
    sbGetTodo(
      "eventos",
      `select=tipo,planillas(jugadores(nombre,nombre_display),equipos(nombre))&tipo=in.(gol,gol_penal,gol_tiro_libre,asistencia)`
    ),
  ]);

  const partidoById = {};
  partidosRows.forEach(p => { partidoById[p.id] = p; });
  const partidoIdByKey = {};
  partidosRows.forEach(p => {
    const key = `${p.zona}_${p.fecha}_${p.equipo_local_nombre}_${p.equipo_visitante_nombre}`;
    partidoIdByKey[key] = p.id;
  });

  // Goles por partido (mini-display de goleadores en la fila de resultado)
  const golesPorPartido = {};
  eventosGoles.forEach(ev => {
    const pl = ev.planillas;
    if (!pl?.partido_id || !partidoById[pl.partido_id]) return;
    if (!golesPorPartido[pl.partido_id]) golesPorPartido[pl.partido_id] = [];
    golesPorPartido[pl.partido_id].push({
      tipo: ev.tipo, minuto: ev.minuto,
      nombre: pl.jugadores?.nombre_display || pl.jugadores?.nombre || "?",
      equipo: pl.equipos?.nombre || "",
    });
  });

  const fichas = [];
  const meta = {};
  const pl = {};

  fixtureRows.forEach(f => {
    if (!f.zona || !f.fecha) return;
    const key = `${f.zona}_${f.fecha}_${f.equipo_local}_${f.equipo_visitante}`;
    const partidoId = partidoIdByKey[key];
    const golesRaw = partidoId ? (golesPorPartido[partidoId] || []) : [];
    const goleadores = golesRaw.map(g => ({
      ...g, equipo: g.equipo === f.equipo_local ? "local" : "visitante",
    })).sort((a, b) => (parseInt(a.minuto) || 0) - (parseInt(b.minuto) || 0));

    fichas.push({
      z: f.zona, f: f.fecha, l: f.equipo_local, v: f.equipo_visitante,
      gl: f.goles_local, gv: f.goles_visitante,
      estado: f.estado, minuto_actual: f.minuto_actual || null,
      goleadores: goleadores.length ? goleadores : null,
      fotmob_url: f.fotmob_url || null,
    });

    // dia/hora/estadio/arbitro: fixture primero, "partidos" como respaldo (mismo criterio
    // de compat que cargarPartidosDesdeDB() en index.html).
    const overlay = partidoById[partidoId] || {};
    const dia = f.dia || overlay.dia || "";
    const hora = f.hora || overlay.hora || "";
    const stream = f.stream_url || overlay.stream_url || "";
    const estadio = f.estadio || overlay.estadio || "";
    const arbitro = f.arbitro || overlay.arbitro || "";
    if (dia || hora || stream || estadio || arbitro) {
      meta[key] = { dia, hora, stream, estadio, arbitro };
    }
    if (partidoId) pl[key] = true;
  });

  // Goleadores/asistentes resumen (histórico completo, ambas fases — mismo criterio que
  // renderGoleadoresResumen() en index.html, que nunca filtró por zona).
  const gol = eventosResumen;

  const snapshot = { ts: Date.now(), fichas, meta, pl, gol };
  const body = JSON.stringify(snapshot);

  const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/escudos/${SNAPSHOT_PATH}`, {
    method: "PUT",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Cache-Control": "max-age=90",
      "x-upsert": "true",
    },
    body,
  });
  if (!uploadResp.ok) {
    const errText = await uploadResp.text().catch(() => "");
    throw new Error(`Upload snapshot -> HTTP ${uploadResp.status} ${errText}`);
  }

  return { fichas: fichas.length, bytes: body.length };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: "Missing Supabase env vars" });

  // Mismo chequeo de auth que api/procesar.js / api/comet-planilla.js: solo el admin logueado
  // con rol "dueno" puede disparar esto manualmente desde el panel.
  const authHeader = req.headers["authorization"] || "";
  const userJwt = authHeader.replace("Bearer ", "").trim();
  if (!userJwt) return res.status(401).json({ error: "Unauthorized" });
  try {
    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${userJwt}` },
    });
    if (!authRes.ok) return res.status(401).json({ error: "Invalid session" });
    const authData = await authRes.json();
    if (!authData?.id) return res.status(401).json({ error: "Invalid session" });

    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/perfiles?id=eq.${authData.id}&select=rol&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    let perfiles = [];
    try { perfiles = JSON.parse(await profileRes.text()); } catch (e) {}
    if (!Array.isArray(perfiles) || perfiles[0]?.rol !== "dueno") return res.status(403).json({ error: "Forbidden" });
  } catch (e) {
    return res.status(401).json({ error: "Auth check failed: " + e.message });
  }

  try {
    const result = await buildAndUploadSnapshot();
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

module.exports.buildAndUploadSnapshot = buildAndUploadSnapshot;
