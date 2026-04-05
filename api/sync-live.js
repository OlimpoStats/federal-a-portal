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
  const all = [...html.matchAll(/(?<!\d)(\b[0-2]?\d)\s*[-–]\s*([0-2]?\d\b)(?!\d)/g)];
  for (const m2 of all) {
    const ctx = html.substring(Math.max(0, m2.index - 20), m2.index);
    if (!/\d{3}|:/.test(ctx)) return { local: parseInt(m2[1]), visitante: parseInt(m2[2]) };
  }
  return null;
}

function parseMinuto(html) {
  const m = html.match(/MFStatusLiveTimeText[^>]*>([^<]+)<\/span>/);
  if (m) {
    const t = m[1].trim();
    if (t.includes(':')) return t.split(':')[0] + "'";
    return t;
  }
  if (html.includes('HT') || html.includes('Half time')) return 'ET';
  return null;
}

function getStatusContext(html) {
  const m = html.match(/MFHeaderStatusWrapper[^>]*>([\s\S]{0,500})/);
  return m ? m[1] : html.substring(0, 2000);
}

function isFinished(html) {
  const ctx = getStatusContext(html);
  return />\s*FT\s*</.test(ctx)
    || ctx.includes('"finished":true')
    || ctx.includes('"statusCode":"FT"')
    || ctx.includes('"status":"finished"');
}

function isLive(html) {
  if (isFinished(html)) return false;
  if (/MFStatusLiveTimeText/.test(html)) return true;
  if (html.includes('HT') || html.includes('Half time')) return true;
  return false;
}

module.exports = async (req, res) => {
  // Prevent Vercel from caching this response
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  if (!SUPABASE_URL || !SUPABASE_KEY)
    return res.status(500).json({ error: 'Missing env vars' });

  try {
    const fixtures = await sbGet('fotmob_url=not.is.null&fotmob_url=neq.&select=id,goles_local,goles_visitante,fotmob_url,estado,minuto_actual');
    if (!Array.isArray(fixtures)) return res.status(500).json({ error: 'DB error', data: fixtures });
    if (!fixtures.length) return res.status(200).json({ ok: true, message: 'No fixtures' });

    const results = [];

    for (const fx of fixtures) {
      if (fx.estado === 'jugado') { results.push({ id: fx.id, skip: 'done' }); continue; }

      try {
        // Anti-cache: add timestamp to URL and headers
        const urlWithTs = fx.fotmob_url + (fx.fotmob_url.includes('?') ? '&' : '?') + '_t=' + Date.now();
        const resp = await fetch(urlWithTs, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Cache-Control': 'no-cache, no-store',
            'Pragma': 'no-cache'
          },
          signal: AbortSignal.timeout(10000)
        });
        if (!resp.ok) { results.push({ id: fx.id, error: `HTTP ${resp.status}` }); continue; }

        const html = await resp.text();
        const score = parseScore(html);
        const finished = isFinished(html);
        const live = !finished && isLive(html);
        const minuto = live ? (parseMinuto(html) || null) : null;

        const upd = {};
        if (score) { upd.goles_local = score.local; upd.goles_visitante = score.visitante; }
        if (finished) { upd.estado = 'jugado'; upd.minuto_actual = null; }
        else if (live) { upd.estado = 'en_curso'; upd.minuto_actual = minuto; }

        if (Object.keys(upd).length > 0) {
          const ok = await sbPatch(fx.id, upd);
          results.push({ id: fx.id, updated: ok, score: score?`${score.local}-${score.visitante}`:null, minuto, estado: upd.estado||fx.estado, live, finished });
        } else {
          results.push({ id: fx.id, unchanged: true, score: score?`${score.local}-${score.visitante}`:null, live, finished });
        }
        await new Promise(r => setTimeout(r, 300));
      } catch(e) { results.push({ id: fx.id, error: e.message }); }
    }

    return res.status(200).json({ ok: true, synced: fixtures.length, results, ts: new Date().toISOString() });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
