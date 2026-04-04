// api/sync-live.js
// No external dependencies - uses native fetch only

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sbGet(params) {
  const url = `${SUPABASE_URL}/rest/v1/fixture?${params}`;
  const r = await fetch(url, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    }
  });
  return r.json();
}

async function sbPatch(id, data) {
  const url = `${SUPABASE_URL}/rest/v1/fixture?id=eq.${id}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(data)
  });
  return r.ok;
}

function parseScore(html) {
  const m = html.match(/(\d+)\s*[-–]\s*(\d+)/);
  return m ? { local: parseInt(m[1]), visitante: parseInt(m[2]) } : null;
}

function isFinished(html) {
  return html.includes('FT') || html.includes('"finished":true') || html.includes('Full time');
}

function isLive(html) {
  return /\d{1,3}'\s/.test(html) || html.includes('"live":true') || html.includes('"started":true');
}

module.exports = async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars' });
  }

  try {
    const fixtures = await sbGet(
      'fotmob_url=not.is.null&fotmob_url=neq.&select=id,goles_local,goles_visitante,fotmob_url,estado'
    );

    if (!Array.isArray(fixtures)) {
      return res.status(500).json({ error: 'Supabase error', data: fixtures });
    }

    if (!fixtures.length) {
      return res.status(200).json({ ok: true, message: 'No fixtures with FotMob URL' });
    }

    const results = [];

    for (const fx of fixtures) {
      if (fx.estado === 'finalizado') { results.push({ id: fx.id, skip: 'finalizado' }); continue; }

      try {
        const resp = await fetch(fx.fotmob_url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AscensoFederal/1.0)' },
          signal: AbortSignal.timeout(8000)
        });

        if (!resp.ok) { results.push({ id: fx.id, error: `HTTP ${resp.status}` }); continue; }

        const html = await resp.text();
        const score = parseScore(html);

        if (!score) { results.push({ id: fx.id, error: 'score not found' }); continue; }

        const finished = isFinished(html);
        const live = !finished && isLive(html);
        const changed = score.local !== fx.goles_local || score.visitante !== fx.goles_visitante;

        if (changed || finished || live) {
          const upd = { goles_local: score.local, goles_visitante: score.visitante };
          if (finished) upd.estado = 'finalizado';
          else if (live) upd.estado = 'en_curso';
          const ok = await sbPatch(fx.id, upd);
          results.push({ id: fx.id, updated: ok, score: `${score.local}-${score.visitante}`, estado: upd.estado });
        } else {
          results.push({ id: fx.id, unchanged: true, score: `${score.local}-${score.visitante}` });
        }

        await new Promise(r => setTimeout(r, 300));
      } catch(e) {
        results.push({ id: fx.id, error: e.message });
      }
    }

    return res.status(200).json({ ok: true, synced: fixtures.length, results, ts: new Date().toISOString() });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
