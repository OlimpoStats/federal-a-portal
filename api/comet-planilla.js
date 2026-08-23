// api/comet-planilla.js - Carga de planilla directo desde la API de COMET/MyComet (analyticom.de),
// en vez de subir una captura de pantalla para que la IA de visión la interprete.
//
// Investigado a mano en sesión: el login por usuario/contraseña funciona directo contra Keycloak
// (grant_type=password), sin necesitar navegador — mismo espíritu que sync-live.js con FotMob.
// El personId que devuelve la formación coincide EXACTO con jugadores.id_federal ya guardado en
// Supabase (confirmado con 6 jugadores reales), así que esto pega siempre en el fast-path por
// id_federal de guardarPlanilla() en vez de pasar por el matcheo difuso por nombre.
//
// Esta función solo devuelve los datos crudos, en el MISMO formato que ya devuelve la IA de
// visión (api/procesar.js) — el cliente los pasa tal cual por normalizarPlanilla() sin cambios.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const COMET_USERNAME = process.env.COMET_USERNAME;
const COMET_PASSWORD = process.env.COMET_PASSWORD;

// Constantes de cuenta — no son secretas (identifican la cuenta/organización, no autentican
// nada por sí solas), por eso van hardcodeadas y no como env var. Encontradas inspeccionando
// los headers que manda la app oficial ya logueada: X-ORG-ID = la competición/organizador
// (AFA), X-ParentAccount-ID = el club a través del cual se otorga la cuenta, X-UserProfile-ID
// = el perfil personal del usuario. Confirmado que son fijos, no cambian de sesión a sesión.
const COMET_ORG_ID = "75752";
const COMET_PARENT_ACCOUNT_ID = "94830008";
const COMET_USER_PROFILE_ID = "94830009";

const COMET_BASE = "https://latam.analyticom.de";
const COMET_TOKEN_URL = `${COMET_BASE}/latam-auth/realms/LATAM-PROD/protocol/openid-connect/token`;

function cometHeaders(token) {
  return {
    "Accept": "application/json, text/plain, */*",
    "bearer-issuer": "kc",
    "app-version": "v12",
    "localization-tenant": "AFA",
    "internalUse": "true",
    "X-ORG-ID": COMET_ORG_ID,
    "X-ParentAccount-ID": COMET_PARENT_ACCOUNT_ID,
    "X-UserProfile-ID": COMET_USER_PROFILE_ID,
    "Authorization": `Bearer ${token}`,
  };
}

async function cometLogin() {
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: "MYCOMET-LATAM",
    username: COMET_USERNAME,
    password: COMET_PASSWORD,
  });
  const r = await fetch(COMET_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Login COMET falló (HTTP ${r.status})`);
  }
  return data.access_token;
}

async function cometGetJson(url, token) {
  const r = await fetch(url, { headers: cometHeaders(token) });
  if (!r.ok) throw new Error(`COMET HTTP ${r.status} en ${url}`);
  return r.json();
}

// nota: mismo formato "CP"/"AR" que ya interpreta el resto del admin vía .includes("CP")/.includes("AR").
function buildNota(lp) {
  const marcas = [];
  if (lp?.captain) marcas.push("CP");
  if (lp?.goalkeeper) marcas.push("AR");
  return marcas.join(" ");
}

// Los cambios NO se sacan del endpoint /events: ahí el jugador que entra (relatedMatchRole)
// no trae personId, solo nombre — habría que matchear por nombre, con el agravante de que ese
// nombre viene en otro orden ("NOMBRE,APELLIDO" en vez de "APELLIDO, NOMBRE"). En cambio, cada
// jugador titular ya trae en su PROPIA formación (gracias a showSubstitutionsOutAsEvent=true en
// la URL del lineup) un array `matchEvents` con sus cambios: fcdName "substitutionOut" cuando
// SE VA, y el que lo reemplaza en `relatedMatchRole` — con personId y dorsal de los dos lados,
// sin necesidad de cruzar nada por nombre.
function buildJugadoresBase(lineup) {
  const jugadores = {};
  for (const p of (lineup?.players || [])) {
    jugadores[p.personId] = {
      numero: p.lineupProperties?.shirtNumber ?? "",
      id: p.personId,
      id_federal: p.personId,
      nota: buildNota(p.lineupProperties),
      nombre: p.name || "",
      titular: !!p.lineupProperties?.startingLineup,
      eventos: [],
    };
  }
  for (const p of (lineup?.players || [])) {
    for (const ev of (p.matchEvents || [])) {
      if (ev.type?.fcdName !== "substitutionOut") continue;
      const entra = ev.relatedMatchRole;
      const minuto = ev.minuteTotal ?? ev.minute ?? null;
      if (jugadores[p.personId]) {
        jugadores[p.personId].eventos.push({
          tipo: "cambio_sale", minuto,
          extra: entra?.lineupProperties?.shirtNumber != null ? String(entra.lineupProperties.shirtNumber) : "",
        });
      }
      if (entra?.personId && jugadores[entra.personId]) {
        jugadores[entra.personId].eventos.push({
          tipo: "cambio_entra", minuto,
          extra: p.lineupProperties?.shirtNumber != null ? String(p.lineupProperties.shirtNumber) : "",
        });
      }
    }
  }
  return { jugadores };
}

// Tipos de evento sin ambigüedad, confirmados contra 6 partidos reales en la investigación.
// PENALTY/OWN_GOAL van sobre el jugador de matchRole, en SU PROPIO plantel (igual que hace la
// IA con "gol_contra" — no hay que invertir nada, contarGoles() ya excluye gol_contra del
// cómputo del equipo). Los cambios (SUBSTITUTION) se resuelven aparte, ver buildJugadoresBase.
const TIPO_POR_FCDNAME = {
  GOAL: "gol",
  PENALTY: "gol_penal",
  OWN_GOAL: "gol_contra",
  YELLOW: "amarilla",
  SECOND_YELLOW: "doble_amarilla",
  RED: "roja",
};

function aplicarEventos(events, ladoHome, jugadoresLocal, jugadoresVisit) {
  for (const ev of (events || [])) {
    const tipo = TIPO_POR_FCDNAME[ev.type?.fcdName];
    if (!tipo) continue; // SUBSTITUTION (ver buildJugadoresBase), START/END/FULL_TIME u otro — ignorar acá
    const jugadores = ev.home === ladoHome ? jugadoresLocal : jugadoresVisit;
    const jugadorId = ev.matchRole?.personId;
    if (jugadorId == null || !jugadores[jugadorId]) continue;
    jugadores[jugadorId].eventos.push({
      tipo, minuto: ev.minuteTotal ?? ev.minute ?? null, extra: "",
    });
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(500).json({ error: "Missing Supabase env vars" });
  if (!COMET_USERNAME || !COMET_PASSWORD) return res.status(500).json({ error: "Missing COMET_USERNAME/COMET_PASSWORD env vars" });

  // Mismo chequeo de auth que api/procesar.js: solo el admin logueado con rol "dueno".
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
    const { matchId } = req.body || {};
    if (!matchId || !/^\d+$/.test(String(matchId))) return res.status(400).json({ error: "Falta matchId o no es numérico." });

    const token = await cometLogin();

    const lineupUrl = (side) => `${COMET_BASE}/api//v2/match/${matchId}/matchClub/${side}/player/lineup?showSubstitutionsOutAsEvent=true&showAssistsOutAsEvent=false&isLive=true`;
    const eventsUrl = `${COMET_BASE}/api//v2/match/${matchId}/events`;

    const [lineupHome, lineupAway, events] = await Promise.all([
      cometGetJson(lineupUrl("home"), token),
      cometGetJson(lineupUrl("away"), token),
      cometGetJson(eventsUrl, token),
    ]);

    if (!lineupHome?.players?.length && !lineupAway?.players?.length) {
      return res.status(404).json({ error: "COMET no devolvió formación para ese partido — puede que todavía no esté cargada." });
    }

    const { jugadores: jugadoresLocal } = buildJugadoresBase(lineupHome);
    const { jugadores: jugadoresVisit } = buildJugadoresBase(lineupAway);

    aplicarEventos(events, true, jugadoresLocal, jugadoresVisit);

    // COMET no devuelve la formación ordenada por dorsal (viene en orden de plantel/registro),
    // a diferencia de una planilla real (leída de arriba a abajo, siempre 1→11 y suplentes).
    const porNumero = (a, b) => (parseInt(a.numero, 10) || 999) - (parseInt(b.numero, 10) || 999);

    return res.status(200).json({
      local: { jugadores: Object.values(jugadoresLocal).sort(porNumero) },
      visit: { jugadores: Object.values(jugadoresVisit).sort(porNumero) },
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
