// api/sync-live.js - FotMob JSON API

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sbGet(params) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/fixture?${params}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  return r.json();
}

async function sbPatch(id, data) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/fixture?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', 'Prefer': 'return=minimal'
    },
    body: JSON.stringify(data)
  });
  return r.ok;
}

function extractMatchId(fotmobUrl) {
  const m = fotmobUrl.match(/#(\d+)$/);
  return m ? m[1] : null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  if (!SUPABASE_URL || !SUPABASE_KEY)
    return res.status(500).json({ error: 'Missing env vars' });

  try {
    const fixtures = await sbGet('fotmob_url=not.is.null&fotmob_url=neq.&select=id,goles_local,goles_visitante,fotmob_url,estado,minuto_actual');
    if (!Array.isArray(fixtures)) return res.status(500).json({ error: 'DB error' });
    if (!fixtures.length) return res.status(200).json({ ok: true, message: 'No fixtures' });

    const results = [];

    for (const fx of fixtures) {
      if (fx.estado === 'jugado') { results.push({ id: fx.id, skip: 'jugado' }); continue; }

      const matchId = extractMatchId(fx.fotmob_url);
      if (!matchId) { results.push({ id: fx.id, error: 'no matchId' }); continue; }

      try {
        const apiUrl = `https://www.fotmob.com/api/matchDetails?matchId=${matchId}&_=${Date.now()}`;
        const resp = await fetch(apiUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Cache-Control': 'no-cache'
          },
          signal: AbortSignal.timeout(10000)
        });

        if (!resp.ok) { results.push({ id: fx.id, error: `HTTP ${resp.status}` }); continue; }

        const data = await resp.json();
        const status = data?.header?.status;
        const teams = data?.header?.teams;

        const started = status?.started === true;
        const finished = status?.finished === true;
        const live = started && !finished;

        // LOGIC:
        // - live → always update score + minuto + estado=en_curso
        // - finished + we had it en_curso → save final result as jugado
        // - finished + still programado → SKIP (partido cargado de antemano, no empezó aún en nuestro sistema)
        // - not started → SKIP

        if (!live && !(finished && fx.estado === 'en_curso')) {
          results.push({ id: fx.id, skip: `not actionable - started:${started} finished:${finished} estado:${fx.estado}` });
          continue;
        }

        if (!teams || teams.length < 2) { results.push({ id: fx.id, error: 'no teams' }); continue; }

        const scoreLocal = teams[0]?.score ?? null;
        const scoreVisit = teams[1]?.score ?? null;
        if (scoreLocal === null) { results.push({ id: fx.id, error: 'no score' }); continue; }

        const minuto = live ? (status?.liveTime?.short || status?.liveTime?.long || null) : null;

        const upd = { goles_local: scoreLocal, goles_visitante: scoreVisit };
        if (finished) { upd.estado = 'jugado'; upd.minuto_actual = null; }
        else { upd.estado = 'en_curso'; upd.minuto_actual = minuto; }

        const ok = await sbPatch(fx.id, upd);
        results.push({ id: fx.id, updated: ok, score: `${scoreLocal}-${scoreVisit}`, minuto, estado: upd.estado, live, finished });

        await new Promise(r => setTimeout(r, 300));
      } catch(e) { results.push({ id: fx.id, error: e.message }); }
    }

    return res.status(200).json({ ok: true, synced: fixtures.length, results, ts: new Date().toISOString() });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
