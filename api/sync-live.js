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
  // FotMob score: small numbers (0-20) separated by dash/endash
  // Must NOT match dates like "2026-04" or "22:18"
  // Look for pattern like "1 - 3" or "0 - 0" with spaces around dash
  // Or inside specific score contexts
  
  // Try to find score in the h1/title area first (most reliable)
  // FotMob puts score like "Boca Unidos 1 - 3 Defensores"
  const scorePatterns = [
    /\b([0-9]|1[0-9]|20)\s*[-–]\s*([0-9]|1[0-9]|20)\b/g,
  ];
  
  for (const pattern of scorePatterns) {
    let m;
    const candidates = [];
    while ((m = pattern.exec(html)) !== null) {
      const a = parseInt(m[1]);
      const b = parseInt(m[2]);
      // Filter out dates (year numbers) and times
      if (a <= 20 && b <= 20) {
        candidates.push({ local: a, visitante: b, pos: m.index });
      }
    }
    if (candidates.length > 0) {
      // Take the first match that's not in a date context
      for (const c of candidates) {
        const context = html.substring(Math.max(0, c.pos - 20), c.pos + 20);
        // Skip if preceded by 4-digit year or time colon
        if (/\d{4}/.test(context.substring(0, 20))) continue;
        if (/\d:\d/.test(context)) continue;
        return { local: c.local, visitante: c.visitante };
      }
    }
  }
  return null;
}

function isFinished(html) {
  return html.includes('Full time') || html.includes('"finished":true') || 
         html.includes('FT\n') || html.includes('>FT<');
}

function isLive(html) {
  // FotMob shows minute like "67'" for live matches
  return /\b\d{1,3}'\s/.test(html) || html.includes('"live":true');
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
          headers: { 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'es-AR,es;q=0.9'
          },
          signal: AbortSignal.timeout(10000)
        });

        if (!resp.ok) { results.push({ id: fx.id, error: `HTTP ${resp.status}` }); continue; }

        const html = await resp.text();
        const score = parseScore(html);

        if (!score) { 
          results.push({ id: fx.id, error: 'score not found', sample: html.substring(0, 200) }); 
          continue; 
        }

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
