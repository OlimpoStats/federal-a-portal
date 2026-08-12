// api/sync-live.js - Live sync via FotMob's matchDetails JSON API
//
// Previously this scraped the public match HTML page. That page is served through
// FotMob's CDN with Cache-Control: max-age=600 (10 min, plus stale-while-revalidate)
// — a goal could take up to ~10 minutes to reach our site even when the cronjob ran
// on schedule. The matchDetails JSON API (what FotMob's own live match center polls)
// is cached only 10s, so we read from that instead.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sbGet(params) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/fixture?${params}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache'
    }
  });
  return r.json();
}

async function sbPatch(id, data) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/fixture?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', 'Prefer': 'return=representation'
    },
    body: JSON.stringify(data)
  });
  if (!r.ok) return { ok: false, status: r.status };
  const rows = await r.json().catch(() => []);
  return { ok: Array.isArray(rows) && rows.length > 0, rows: rows.length };
}

async function sbCloseStale(today) {
  // Bulk-close all en_curso fixtures from before today (or with no date set)
  const r = await fetch(`${SUPABASE_URL}/rest/v1/fixture?estado=eq.en_curso&or=(dia.lt.${today},dia.is.null)`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', 'Prefer': 'return=representation'
    },
    body: JSON.stringify({ estado: 'jugado' })
  });
  if (!r.ok) return { ok: false, status: r.status };
  const rows = await r.json().catch(() => []);
  return { ok: true, closed: Array.isArray(rows) ? rows.length : 0 };
}

// Extrae el matchId numérico de la URL (formato copiado de la barra de FotMob:
// .../matches/equipo-a-vs-equipo-b/codigo#5978547 — el matchId es el fragmento).
function getMatchId(fotmobUrl) {
  const m = fotmobUrl.match(/#(\d+)/);
  return m ? m[1] : null;
}

function parseScore(data) {
  const teams = data?.header?.teams;
  if (Array.isArray(teams) && teams.length === 2 &&
      typeof teams[0]?.score === 'number' && typeof teams[1]?.score === 'number') {
    return { local: teams[0].score, visitante: teams[1].score };
  }
  return null;
}

function parseMinuto(data) {
  const short = data?.header?.status?.liveTime?.short;
  if (!short) return null;
  // FotMob envuelve el minuto con marcas de dirección de texto invisibles
  // (U+200E/U+200F) alrededor de un apóstrofe tipográfico (U+2019), no uno común.
  const clean = short.replace(/[‎‏’'′]/g, '').trim();
  if (/^\d/.test(clean)) return clean + "'";
  if (/^HT$/i.test(clean)) return 'ET';
  return null;
}

function isFinished(data) {
  return data?.header?.status?.finished === true || data?.general?.finished === true;
}

function isLive(data) {
  const status = data?.header?.status;
  if (!status || status.cancelled || status.finished) return false;
  return status.started === true;
}

function parseFotmobEventos(data) {
  const result = { golesLocal: [], golesVisit: [], rojasLocal: 0, rojasVisit: 0, rojasLocalNames: [], rojasVisitNames: [] };

  const status = data?.header?.status;
  result.rojasLocal = status?.numberOfHomeRedCards || 0;
  result.rojasVisit = status?.numberOfAwayRedCards || 0;

  const events = data?.content?.matchFacts?.events?.events;
  if (!Array.isArray(events)) return result;

  for (const ev of events) {
    if (ev.type === 'Goal' && ev.player?.name) {
      const overload = ev.overloadTime ? `+${ev.overloadTime}` : '';
      const min = `${ev.time}${overload}'`;
      const entry = { nombre: ev.player.name, min };
      if (ev.assistStr) entry.asistencia = ev.assistStr;
      if (ev.ownGoal) entry.enPropia = true;
      if (ev.isHome) result.golesLocal.push(entry);
      else result.golesVisit.push(entry);
    }
    if (ev.type === 'Card' && ev.card === 'Red' && ev.player?.name) {
      const overload = ev.overloadTime ? `+${ev.overloadTime}` : '';
      const min = `${ev.time}${overload}'`;
      const entry = { n: ev.player.name, t: min };
      if (ev.isHome) result.rojasLocalNames.push(entry);
      else result.rojasVisitNames.push(entry);
    }
  }

  return result;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  if (!SUPABASE_URL || !SUPABASE_KEY)
    return res.status(500).json({ error: 'Missing env vars' });

  try {
    // Fecha de Argentina (UTC-3), no UTC: usar la fecha del servidor rompía todo
    // pasadas las 21hs ART (ya es medianoche UTC del día siguiente) y cerraba/reseteaba
    // partidos que en Argentina todavía estaban en curso.
    const today = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Close any en_curso fixtures from previous days in one bulk UPDATE
    const staleResult = await sbCloseStale(today);

    const fixtures = await sbGet(`fotmob_url=not.is.null&fotmob_url=neq.&select=id,goles_local,goles_visitante,fotmob_url,estado,minuto_actual,dia,hora&or=(dia.eq.${today},estado.eq.en_curso)`);
    if (!Array.isArray(fixtures)) return res.status(500).json({ error: 'DB error' });
    if (!fixtures.length) return res.status(200).json({ ok: true, message: 'No fixtures today', today, stale: staleResult });

    // Early exit: only hit FotMob if at least one match is en_curso or has kicked off (±15 min)
    const nowArgMin = (() => {
      const d = new Date(Date.now() - 3 * 60 * 60 * 1000); // UTC-3
      return d.getUTCHours() * 60 + d.getUTCMinutes();
    })();
    const needsProcessing = fixtures.some(fx => {
      if (fx.estado === 'en_curso') return true;
      if (fx.estado === 'jugado') return false;
      if (!fx.hora || fx.dia !== today) return true; // no time set or stale — handle in loop
      const [h, m] = fx.hora.split(':').map(Number);
      return nowArgMin >= (h * 60 + (m || 0)) - 15;
    });
    if (!needsProcessing) return res.status(200).json({ ok: true, message: 'No matches active yet', today, stale: staleResult });

    const results = [];
    const toCheck = [];

    // Pase rápido, sin red: cerrar lo que ya está resuelto sin necesidad de tocar FotMob.
    for (const fx of fixtures) {
      if (fx.estado === 'jugado') { results.push({ id: fx.id, skip: 'jugado' }); continue; }

      // Hard close: if match date is before today, force jugado
      // Set m:null in minuto_actual so the DB trigger recognises it as finished
      if (fx.dia && fx.dia < today) {
        let closedMinutoActual = fx.minuto_actual;
        try {
          const parsed = JSON.parse(fx.minuto_actual || '{}');
          parsed.m = null;
          closedMinutoActual = JSON.stringify(parsed);
        } catch(e) { closedMinutoActual = '{"m":null}'; }
        const r = await sbPatch(fx.id, { estado: 'jugado', minuto_actual: closedMinutoActual });
        results.push({ id: fx.id, forceClosed: true, dia: fx.dia, updated: r.ok, rows: r.rows });
        continue;
      }

      toCheck.push(fx);
    }

    // Chequeo real contra FotMob para lo que sigue en pie. Un partido por vez con una
    // pausa de 500ms entre cada uno tardaba demasiado apenas había varios partidos
    // simultáneos (ej. los 4 grupos de la Segunda Fase jugando el mismo horario): con
    // 15 partidos por delante, en el peor caso (8s de timeout c/u) esto superaba
    // ampliamente el maxDuration de la función y la cortaba a mitad de la lista, dejando
    // partidos en vivo sin actualizar hasta la próxima corrida. Se procesan en tandas
    // de CONCURRENCY en paralelo — la pausa de 500ms queda entre tandas, no entre cada
    // partido, para seguir sin bombardear FotMob de golpe.
    const CONCURRENCY = 5;

    async function checkFixture(fx) {
      try {
        const matchId = getMatchId(fx.fotmob_url);
        if (!matchId) return { id: fx.id, error: 'no matchId in fotmob_url' };

        const url = `https://www.fotmob.com/api/data/matchDetails?matchId=${matchId}`;

        const resp = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'Accept-Language': 'es-AR,es;q=0.9'
          },
          signal: AbortSignal.timeout(8000)
        });

        if (!resp.ok) return { id: fx.id, error: `HTTP ${resp.status}` };

        const data = await resp.json();
        const finished = isFinished(data);
        const live = !finished && isLive(data);
        const ambiguous = !live && !finished && fx.estado === 'en_curso';

        // When closing a match, preserve existing goal/card data if FotMob returns
        // fewer events than we already have (FT is sometimes reported before events load)
        let existingMa = {};
        try { existingMa = JSON.parse(fx.minuto_actual || '{}'); } catch(e) {}

        // A single failed live-detection can just be a flaky/blocked scrape (FotMob
        // layout hiccup, rate limit, etc.), not necessarily the match actually ending.
        // Require MAX_MISSES consecutive ambiguous reads in a row before treating it
        // as implicitly finished, so a transient failure doesn't wrongly close a live
        // match and get it permanently skipped (estado:'jugado' rows are never re-checked).
        const MAX_MISSES = 3;
        if (ambiguous) {
          const misses = (existingMa.mc || 0) + 1;
          if (misses < MAX_MISSES) {
            const r = await sbPatch(fx.id, { minuto_actual: JSON.stringify({ ...existingMa, mc: misses }) });
            return { id: fx.id, ambiguous: true, misses, updated: r.ok };
          }
        }
        const implicitFinished = ambiguous && (existingMa.mc || 0) + 1 >= MAX_MISSES;

        if (!live && !implicitFinished && !finished) {
          return { id: fx.id, skip: 'not live' };
        }

        const score = parseScore(data);
        if (!score && !implicitFinished) return { id: fx.id, error: 'no score', live, finished };

        const eventos = parseFotmobEventos(data);
        const { rojasLocal, rojasVisit } = eventos;
        const minuto = live ? parseMinuto(data) : null;

        const isClosing = finished || implicitFinished;
        const newGl = eventos.golesLocal.map(g => ({n: g.nombre, t: g.min}));
        const newGv = eventos.golesVisit.map(g => ({n: g.nombre, t: g.min}));
        const finalGl = isClosing && (existingMa.gl||[]).length > newGl.length ? existingMa.gl : newGl;
        const finalGv = isClosing && (existingMa.gv||[]).length > newGv.length ? existingMa.gv : newGv;
        const finalRln = isClosing && (existingMa.rln||[]).length > eventos.rojasLocalNames.length ? existingMa.rln : eventos.rojasLocalNames;
        const finalRvn = isClosing && (existingMa.rvn||[]).length > eventos.rojasVisitNames.length ? existingMa.rvn : eventos.rojasVisitNames;

        const eventData = JSON.stringify({
          m: implicitFinished ? null : minuto,
          rl: rojasLocal, rv: rojasVisit,
          gl: finalGl,
          gv: finalGv,
          rln: finalRln,
          rvn: finalRvn
        });

        if (implicitFinished) {
          const patch = { estado: 'jugado', minuto_actual: eventData };
          if (score) { patch.goles_local = score.local; patch.goles_visitante = score.visitante; }
          const r = await sbPatch(fx.id, patch);
          return { id: fx.id, implicitFinished: true, score: score ? `${score.local}-${score.visitante}` : 'no-score', updated: r.ok, rows: r.rows };
        }

        const upd = { goles_local: score.local, goles_visitante: score.visitante };
        if (finished) { upd.estado = 'jugado'; upd.minuto_actual = eventData; }
        else { upd.estado = 'en_curso'; upd.minuto_actual = eventData; }

        const r = await sbPatch(fx.id, upd);
        return {
          id: fx.id, updated: r.ok, rows: r.rows,
          score: `${score.local}-${score.visitante}`,
          minuto, rojasLocal, rojasVisit,
          golesLocal: eventos.golesLocal.length,
          golesVisit: eventos.golesVisit.length,
          estado: upd.estado
        };
      } catch(e) { return { id: fx.id, error: e.message }; }
    }

    for (let i = 0; i < toCheck.length; i += CONCURRENCY) {
      const batch = toCheck.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map(checkFixture));
      results.push(...batchResults);
      if (i + CONCURRENCY < toCheck.length) await new Promise(r => setTimeout(r, 500));
    }

    return res.status(200).json({ ok: true, synced: fixtures.length, results, ts: new Date().toISOString() });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
