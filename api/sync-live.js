// api/sync-live.js - HTML scraping with cache busting

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
    // Return just the minute part e.g. "19'" from "19:24"
    return t.includes(':') ? t.split(':')[0] + "'" : t;
  }
  if (/HT|Half time/.test(html)) return 'ET';
  return null;
}

async function fetchSofascoreIncidents(sofascoreUrl) {
  if (!sofascoreUrl) return null;
  // Extract ID from URL: #id:15673170
  const m = sofascoreUrl.match(/[#&]id[=:](\d+)/);
  if (!m) return null;
  const id = m[1];
  try {
    const r = await fetch(`https://api.sofascore.com/api/v1/event/${id}/incidents`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.sofascore.com/'
      },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return { error: `SofaScore HTTP ${r.status}` };
    const data = await r.json();
    const incidents = data?.incidents || [];
    const result = { golesLocal:[], golesVisit:[], rojasLocal:0, rojasVisit:0 };
    for (const inc of incidents) {
      const isHome = inc.isHome;
      const nombre = inc.player?.shortName || inc.player?.name || '';
      const min = inc.time ? `${inc.time}'` : '';
      if (['goal','penaltyScored'].includes(inc.incidentType)) {
        if (isHome) result.golesLocal.push({nombre, min});
        else result.golesVisit.push({nombre, min});
      }
      if (inc.incidentType === 'card' && ['red','yellowRed'].includes(inc.incidentClass)) {
        if (isHome) result.rojasLocal++;
        else result.rojasVisit++;
      }
    }
    return result;
  } catch(e) { return { error: e.message }; }
}

function debugRedCards(html) {
  // Find MFStatusLiveTimeText or any status text
  const liveTime = html.match(/MFStatusLiveTimeText[^>]*>([^<]+)</);
  if (liveTime) return 'liveTime:' + liveTime[1];
  // Look for status near score
  const scoreIdx = html.indexOf('MFHeaderStatusScore');
  if (scoreIdx === -1) return 'no score element';
  const area = html.substring(Math.max(0, scoreIdx-500), scoreIdx+500);
  return area.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().substring(0,300);
}

function parseEventos(html) {
  // Parse goals and red cards from FotMob event list in header
  // Structure: team events appear as text with minute numbers
  // Local events are on left, visitante on right
  const eventos = { golesLocal:[], golesVisit:[], rojasLocal:0, rojasVisit:0 };
  
  // Find the header score area - events are listed there
  // Local events: left side, visitante: right side
  // Pattern: "PlayerName 25'" for goals, same for red cards with different icon
  
  // Split by score wrapper to get local side and visitante side
  const scoreIdx = html.indexOf('MFHeaderStatusScore');
  if (scoreIdx === -1) return eventos;
  
  const localSide = html.substring(0, scoreIdx);
  const visitSide = html.substring(scoreIdx);
  
  // Extract player+minute from each side
  // FotMob pattern: name followed by minute like "25'" or "25',33'"
  const minutePattern = /([A-Za-záéíóúÁÉÍÓÚñÑüÜ][A-Za-záéíóúÁÉÍÓÚñÑüÜ\s\.\-]+?)\s+(\d{1,3}(?:[',]\d{1,3})*')/g;
  
  let m;
  while ((m = minutePattern.exec(localSide)) !== null) {
    eventos.golesLocal.push({ nombre: m[1].trim(), minuto: m[2] });
  }
  minutePattern.lastIndex = 0;
  while ((m = minutePattern.exec(visitSide)) !== null) {
    eventos.golesVisit.push({ nombre: m[1].trim(), minuto: m[2] });
  }
  
  return eventos;
}

function getStatusContext(html) {
  // Look for status text around the score
  const scoreIdx = html.indexOf('MFHeaderStatusScore');
  if (scoreIdx > 0) return html.substring(Math.max(0, scoreIdx-1000), scoreIdx+1000);
  const m = html.match(/MFHeaderStatusWrapper[^>]*>([\s\S]{0,1000})/);
  return m ? m[1] : html.substring(0, 3000);
}

function isFinished(html) {
  const ctx = getStatusContext(html);
  return />\s*FT\s*</.test(ctx) || ctx.includes('"finished":true');
}

function isLive(html) {
  if (isFinished(html)) return false;
  return /MFStatusLiveTimeText/.test(html) || /HT|Half time/.test(getStatusContext(html));
}

async function fetchIncidentesSofascore(sofascoreId) {
  if (!sofascoreId) return { golesLocal:[], golesVisit:[], rojasLocal:0, rojasVisit:0 };
  try {
    const r = await fetch(`https://api.sofascore.com/api/v1/event/${sofascoreId}/incidents`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.sofascore.com/'
      },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const data = await r.json();
    const incidents = data?.incidents || [];
    const result = { golesLocal:[], golesVisit:[], rojasLocal:0, rojasVisit:0 };
    for (const inc of incidents) {
      const isHome = inc.isHome;
      const nombre = inc.player?.name || inc.playerName || '';
      const min = inc.time ? `${inc.time}'` : '';
      if (inc.incidentType === 'goal' || inc.incidentType === 'Goal') {
        if (isHome) result.golesLocal.push({nombre, min});
        else result.golesVisit.push({nombre, min});
      }
      if (inc.incidentType === 'card' && (inc.incidentClass === 'red' || inc.incidentClass === 'yellowRed')) {
        if (isHome) result.rojasLocal++;
        else result.rojasVisit++;
      }
    }
    return result;
  } catch(e) { return { error: e.message }; }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  if (!SUPABASE_URL || !SUPABASE_KEY)
    return res.status(500).json({ error: 'Missing env vars' });

  try {
    const fixtures = await sbGet('fotmob_url=not.is.null&fotmob_url=neq.&select=id,goles_local,goles_visitante,fotmob_url,sofascore_url,estado,minuto_actual');
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

        // Implicit finish: was en_curso but no longer live → finished
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

        const minuto = live ? parseMinuto(html) : null;
        // Fetch incidents from Sofascore if URL available
        let rojasLocal = 0, rojasVisit = 0;
        let sofaResult = null;
        if (live && fx.sofascore_url) {
          sofaResult = await fetchSofascoreIncidents(fx.sofascore_url);
          if (sofaResult && !sofaResult.error) {
            rojasLocal = sofaResult.rojasLocal || 0;
            rojasVisit = sofaResult.rojasVisit || 0;
          }
        }

        // Encode as "19'|1|0" = minuto|rojas_local|rojas_visitante
        const minutoEncoded = minuto ? `${minuto}|${rojasLocal}|${rojasVisit}` : null;

        const upd = { goles_local: score.local, goles_visitante: score.visitante };
        if (finished) { upd.estado = 'jugado'; upd.minuto_actual = null; }
        else { upd.estado = 'en_curso'; upd.minuto_actual = minutoEncoded; }

        const ok = await sbPatch(fx.id, upd);
        const _dbg = debugRedCards(html);
        results.push({ id: fx.id, updated: ok, score: `${score.local}-${score.visitante}`, minuto, rojasLocal, rojasVisit, estado: upd.estado, live, finished, dbgRoja: _dbg });

        await new Promise(r => setTimeout(r, 500));
      } catch(e) { results.push({ id: fx.id, error: e.message }); }
    }

    return res.status(200).json({ ok: true, synced: fixtures.length, results, ts: new Date().toISOString() });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};

// force redeploy Sun Apr  5 20:15:04 UTC 2026
