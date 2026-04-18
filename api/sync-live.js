// api/sync-live.js - Live sync via FotMob HTML scraping (__NEXT_DATA__)

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

function parseScore(html) {
  const m = html.match(/MFHeaderStatusScore[^>]*>([^<]+)<\/span>/);
  if (m) {
    const s = m[1].match(/(\d+)\s*[-–]\s*(\d+)/);
    if (s) return { local: parseInt(s[1]), visitante: parseInt(s[2]) };
  }
  return null;
}

function parseMinuto(html) {
  const m = html.match(/MFStatusLiveTimeText[^>]*>([^<]+)<\/span>/);
  if (m) {
    const t = m[1].trim();
    return t.includes(':') ? t.split(':')[0] + "'" : t;
  }
  if (/HT|Half time/.test(html)) return 'ET';
  return null;
}

function isFinished(html) {
  const scoreIdx = html.indexOf('MFHeaderStatusScore');
  const ctx = scoreIdx > 0
    ? html.substring(Math.max(0, scoreIdx - 1000), scoreIdx + 1000)
    : html.substring(0, 3000);
  return />\s*FT\s*</.test(ctx) || ctx.includes('"finished":true');
}

function isLive(html) {
  if (isFinished(html)) return false;
  const scoreIdx = html.indexOf('MFHeaderStatusScore');
  const ctx = scoreIdx > 0
    ? html.substring(Math.max(0, scoreIdx - 1000), scoreIdx + 1000)
    : html.substring(0, 3000);
  return /MFStatusLiveTimeText/.test(html) || /HT|Half time/.test(ctx);
}

function parseFotmobEventos(html) {
  const result = { golesLocal: [], golesVisit: [], rojasLocal: 0, rojasVisit: 0 };

  const ndMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!ndMatch) return result;

  let nd;
  try { nd = JSON.parse(ndMatch[1]); } catch(e) { return result; }

  const events = nd?.props?.pageProps?.content?.matchFacts?.events?.events;
  if (!Array.isArray(events)) return result;

  for (const ev of events) {
    if (ev.type === 'Goal' && ev.player?.name) {
      const overload = ev.overloadTime ? `+${ev.overloadTime}` : '';
      const min = `${ev.time}${overload}'`;
      const nombre = ev.player.name;
      const entry = { nombre, min };
      if (ev.assistStr) entry.asistencia = ev.assistStr;
      if (ev.ownGoal) entry.enPropia = true;
      if (ev.isHome) result.golesLocal.push(entry);
      else result.golesVisit.push(entry);
    }
    if (ev.type === 'Card' && ev.card === 'Red' && ev.player?.name) {
      if (ev.isHome) result.rojasLocal++;
      else result.rojasVisit++;
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
    const fixtures = await sbGet('fotmob_url=not.is.null&fotmob_url=neq.&select=id,goles_local,goles_visitante,fotmob_url,estado,minuto_actual');
    if (!Array.isArray(fixtures)) return res.status(500).json({ error: 'DB error' });
    if (!fixtures.length) return res.status(200).json({ ok: true, message: 'No fixtures' });

    const results = [];

    for (const fx of fixtures) {
      if (fx.estado === 'jugado') { results.push({ id: fx.id, skip: 'jugado' }); continue; }

      try {
        const baseUrl = fx.fotmob_url.split('#')[0];
        const url = baseUrl + '?_=' + Date.now();

        const resp = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'es-AR,es;q=0.9',
            'Cache-Control': 'no-cache'
          },
          signal: AbortSignal.timeout(12000)
        });

        if (!resp.ok) { results.push({ id: fx.id, error: `HTTP ${resp.status}` }); continue; }

        const html = await resp.text();
        const finished = isFinished(html);
        const live = !finished && isLive(html);
        const implicitFinished = !live && !finished && fx.estado === 'en_curso';

        if (!live && !implicitFinished) {
          results.push({ id: fx.id, skip: 'not live' });
          continue;
        }

        if (implicitFinished) {
          const ok = await sbPatch(fx.id, { estado: 'jugado', minuto_actual: null });
          results.push({ id: fx.id, implicitFinished: true, updated: ok });
          continue;
        }

        const score = parseScore(html);
        if (!score) { results.push({ id: fx.id, error: 'no score', live, finished }); continue; }

        const minuto = parseMinuto(html);
        const eventos = parseFotmobEventos(html);
        const { rojasLocal, rojasVisit } = eventos;

        // Encode as "19'|1|0" = minuto|rojas_local|rojas_visitante
        const minutoEncoded = minuto ? `${minuto}|${rojasLocal}|${rojasVisit}` : null;

        const upd = { goles_local: score.local, goles_visitante: score.visitante };
        if (finished) { upd.estado = 'jugado'; upd.minuto_actual = null; }
        else { upd.estado = 'en_curso'; upd.minuto_actual = minutoEncoded; }

        const ok = await sbPatch(fx.id, upd);
        results.push({
          id: fx.id, updated: ok,
          score: `${score.local}-${score.visitante}`,
          minuto, rojasLocal, rojasVisit,
          golesLocal: eventos.golesLocal.length,
          golesVisit: eventos.golesVisit.length,
          estado: upd.estado
        });

        await new Promise(r => setTimeout(r, 500));
      } catch(e) { results.push({ id: fx.id, error: e.message }); }
    }

    return res.status(200).json({ ok: true, synced: fixtures.length, results, ts: new Date().toISOString() });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
