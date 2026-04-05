// api/sync-live.js - No external dependencies

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
  // Fallback: small numbers with dash
  const all = [...html.matchAll(/(?<!\d)(\b[0-2]?\d)\s*[-–]\s*([0-2]?\d\b)(?!\d)/g)];
  for (const m2 of all) {
    const ctx = html.substring(Math.max(0, m2.index - 20), m2.index);
    if (!/\d{3}|:/.test(ctx)) return { local: parseInt(m2[1]), visitante: parseInt(m2[2]) };
  }
  return null;
}

function parseMinuto(html) {
  // Running clock "76:26" near score
  const m = html.match(/(\d{1,3}):(\d{2})/);
  if (m && parseInt(m[1]) <= 120) return m[1] + "'";
  if (html.includes('HT') || html.includes('Half time') || html.includes('Entretiempo')) return 'ET';
  return null;
}

function isFinished(html) {
  return html.includes('Full time')
    || html.includes('"finished":true')
    || />\s*FT\s*</.test(html)
    || html.includes('Partido finalizado')
    || html.includes('Final del partido')
    || html.includes('"statusCode":"FT"')
    || html.includes('"status":"finished"');
}

function isLive(html) {
  // Must NOT be finished
  if (isFinished(html)) return false;
  return /\d{1,3}:\d{2}/.test(html)       // Running clock
    || html.includes('HT')                  // Half time
    || html.includes('Half time')
    || html.includes('Entretiempo')
    || html.includes('"live":true')
    || html.includes('"started":true')
    || html.includes('"ongoing":true')
    || /["']live["']/.test(html)
    || html.includes('En curso')
    || html.includes('En juego')
    || /\d{1,3}['′]/.test(html);           // Minute with apostrophe like "45'"
}

module.exports = async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY)
    return res.status(500).json({ error: 'Missing env vars' });

  try {
    const fixtures = await sbGet('fotmob_url=not.is.null&fotmob_url=neq.&select=id,goles_local,goles_visitante,fotmob_url,estado,minuto_actual');
    if (!Array.isArray(fixtures)) return res.status(500).json({ error: 'DB error', data: fixtures });
    if (!fixtures.length) return res.status(200).json({ ok: true, message: 'No fixtures' });

    const results = [];

    for (const fx of fixtures) {
      if (fx.estado === 'finalizado') { results.push({ id: fx.id, skip: 'done' }); continue; }

      try {
        const resp = await fetch(fx.fotmob_url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          signal: AbortSignal.timeout(10000)
        });
        if (!resp.ok) { results.push({ id: fx.id, error: `HTTP ${resp.status}` }); continue; }

        const html = await resp.text();
        const score = parseScore(html);
        const finished = isFinished(html);
        const live = !finished && isLive(html);
        const minuto = live ? (parseMinuto(html) || null) : null;

        if (!score) {
          results.push({ id: fx.id, error: 'no score', live, finished, sample: html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').substring(0,300) });
          continue;
        }

        const scoreChanged = score.local !== fx.goles_local || score.visitante !== fx.goles_visitante;
        const estadoChanged = (finished && fx.estado !== 'finalizado') || (live && fx.estado !== 'en_curso');
        const minutoChanged = minuto !== fx.minuto_actual;

        if (scoreChanged || estadoChanged || minutoChanged) {
          const upd = { goles_local: score.local, goles_visitante: score.visitante, minuto_actual: minuto };
          if (finished) { upd.estado = 'finalizado'; upd.minuto_actual = null; }
          else if (live) upd.estado = 'en_curso';
          const ok = await sbPatch(fx.id, upd);
          results.push({ id: fx.id, updated: ok, score: `${score.local}-${score.visitante}`, minuto, estado: upd.estado, live, finished });
        } else {
          results.push({ id: fx.id, unchanged: true, score: `${score.local}-${score.visitante}`, minuto, live, finished });
        }
        await new Promise(r => setTimeout(r, 300));
      } catch(e) { results.push({ id: fx.id, error: e.message }); }
    }

    return res.status(200).json({ ok: true, synced: fixtures.length, results, ts: new Date().toISOString() });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
