// api/snapshot-estadisticas.js - Genera y sube la "foto" de la pestaña Estadísticas (jugadores,
// árbitros, penales, goles en contra, tiro libre, vallas, DTs, etc.) para que el cliente no
// tenga que volver a pedirle a Supabase ~10 consultas (algunas con paginación completa de miles
// de filas, como "eventos") en cada visita.
//
// A diferencia de Segunda Fase (que guarda el resultado YA PROCESADO), acá guardamos las
// mismas filas CRUDAS que hoy trae cargarEstadisticas() en index.html, con el mismo "select" y
// los mismos filtros — esa función tiene ~1000 líneas de procesamiento/renderizado fusionadas
// en un solo bloque, así que la forma más segura de no romper nada es reemplazar solo el ORIGEN
// de los datos (las consultas), dejando el resto exactamente como está.
//
// Trigger: se regenera desde el admin cada vez que se confirma una carga de planilla
// (confirmarCarga() en admin/index.html) o se borra una (borrarPlanilla()) — es la única acción
// que modifica estadísticas de jugadores/árbitros/goles, según lo definido por el dueño del sitio.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const SNAPSHOT_PATH = "estadisticas-snapshot.json";

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
  const evSelect = "tipo,minuto,planilla_id,planillas(partido_id,equipo_id,numero_camiseta,jugadores(id,nombre,nombre_display),equipos(nombre))";
  const jugSelect = "id,nombre,nombre_display,equipo_id,equipos(nombre)";
  const arqSelect = "id,partido_id,equipo_id,numero_camiseta,titular,jugadores(id,nombre,nombre_display),equipos(nombre)";

  const [
    eventos, jugsDB, partidosDB, planillasDB, penalesDB, dtDB, sancionesDB, transfersDB,
    arquerosPlanilla, fixtureArbitros,
  ] = await Promise.all([
    sbGetTodo("eventos", `select=${evSelect}`),
    sbGetTodo("jugadores", `select=${jugSelect}`),
    sbGetTodo("partidos", `select=id,zona,fecha,equipo_local_nombre,equipo_visitante_nombre,goles_local,goles_visitante&goles_local=not.is.null`),
    sbGetTodo("planillas", `select=id,partido_id,equipo_id`),
    sbGetTodo("penales", `select=resultado,ejecutante_id,arquero_id,equipo_favor,equipo_contra,minuto,partido_id,fixture_id`),
    sbGetTodo("partidos", `select=zona,fecha,equipo_local_nombre,equipo_visitante_nombre,dt_local,dt_visitante&order=fecha`),
    sbGetTodo("sanciones", `select=*&or=(estado.eq.pendiente,and(tipo.eq.amarillas,estado.neq.eliminada))&order=created_at.desc`),
    sbGetTodo("transferencias", `select=jugador_origen_id,jugador_destino_id,equipo_origen_id,equipo_destino_id`),
    sbGetTodo("planillas", `select=${arqSelect}&numero_camiseta=in.(1,12)`),
    sbGetTodo("fixture", `select=id,zona,fecha,equipo_local,equipo_visitante,arbitro,juez1,juez2,cuarto_arbitro&arbitro=not.is.null&arbitro=neq.`),
  ]);

  const snapshot = {
    ts: Date.now(),
    eventos, jugsDB, partidosDB, planillasDB, penalesDB, dtDB, sancionesDB, transfersDB,
    arquerosPlanilla, fixtureArbitros,
  };
  const body = JSON.stringify(snapshot);

  const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/escudos/${SNAPSHOT_PATH}`, {
    method: "PUT",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Cache-Control": "max-age=300",
      "x-upsert": "true",
    },
    body,
  });
  if (!uploadResp.ok) {
    const errText = await uploadResp.text().catch(() => "");
    throw new Error(`Upload snapshot -> HTTP ${uploadResp.status} ${errText}`);
  }

  return { eventos: eventos.length, jugadores: jugsDB.length, bytes: body.length };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: "Missing Supabase env vars" });

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
