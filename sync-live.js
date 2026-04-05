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
  // FotMob score in MFHeaderStatusScore span
  const m = html.match(/MFHeaderStatusScore[^>]*>([^<]+)<\/span>/);
  if (m) {
    const s = m[1].match(/(\d+)\s*[-–]\s*(\d+)/);
    if (s) return { local: parseInt(s[1]), visitante: parseInt(s[2]) };
  }
  // Fallback: small numbers with dash, not preceded by 3+ digits
  const all = [...html.matchAll(/(?<!\d{2})(\b[0-2]?\d)\s*[-–]\s*([0-2]?\d\b)(?!\d)/g)];
  for (const m2 of all) {
    const ctx = html.substring(Math.max(0, m2.index - 15), m2.index);
    if (!/\d{3}|:/.test(ctx)) return { local: parseInt(m2[1]), visitante: parseInt(m2[2]) };
  }
  return null;
}

function parseMinuto(html) {
  // FotMob live minute: "76:26" format or just "76'"
  const m = html.match(/MFHeaderStatusScore[^>]*>[^<]*<\/span>\s*<[^>]*>\s*(\d{1,3})[':]/);
  if (m) return m[1] + "'";
  // Try generic pattern near score area
  const m2 = html.match(/(\d{1,3}):(\d{2})\s*<\/[a-z]/);
  if (m2) return m2[1] + "'";
  return null;
}

function isFinished(html) {
  return html.includes('Full time') || html.includes('"finished":true') || />\s*FT\s*</.test(html);
}

function isLive(html) {
  return /\d{1,3}:\d{2}/.test(html) || html.includes('"live":true');
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
        if (!score) {
          results.push({ id: fx.id, error: 'no score', sample: html.replace(/<[^>]+>/g,' ').substring(0,200) });
          continue;
        }

        const finished = isFinished(html);
        const live = !finished && isLive(html);
        const minuto = live ? (parseMinuto(html) || null) : null;

        const changed = score.local !== fx.goles_local || score.visitante !== fx.goles_visitante
          || (finished && fx.estado !== 'finalizado')
          || (live && fx.estado !== 'en_curso')
          || minuto !== fx.minuto_actual;

        if (changed) {
          const upd = { goles_local: score.local, goles_visitante: score.visitante, minuto_actual: minuto };
          if (finished) { upd.estado = 'finalizado'; upd.minuto_actual = null; }
          else if (live) upd.estado = 'en_curso';
          const ok = await sbPatch(fx.id, upd);
          results.push({ id: fx.id, updated: ok, score: `${score.local}-${score.visitante}`, minuto, estado: upd.estado });
        } else {
          results.push({ id: fx.id, unchanged: true, score: `${score.local}-${score.visitante}`, minuto });
        }
        await new Promise(r => setTimeout(r, 300));
      } catch(e) { results.push({ id: fx.id, error: e.message }); }
    }

    return res.status(200).json({ ok: true, synced: fixtures.length, results, ts: new Date().toISOString() });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
