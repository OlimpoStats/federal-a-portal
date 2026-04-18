// api/fotmob-debug.js - Inspects raw FotMob HTML to build the parser
// Usage: /api/fotmob-debug?url=https://www.fotmob.com/es/matches/...
// Add &full=1 to get full HTML (warning: large)

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const { url, full } = req.query;
  if (!url) return res.status(400).json({ error: 'url param required' });

  try {
    const fetchUrl = url.split('#')[0] + '?_=' + Date.now();
    const resp = await fetch(fetchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!resp.ok) return res.status(502).json({ error: `FotMob HTTP ${resp.status}` });

    const html = await resp.text();

    if (full === '1') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(html);
    }

    // Check for __NEXT_DATA__
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    const hasNextData = !!nextDataMatch;
    let nextDataKeys = null;
    let eventsData = null;
    let eventsKeys = null;
    if (nextDataMatch) {
      try {
        const nd = JSON.parse(nextDataMatch[1]);
        nextDataKeys = JSON.stringify(Object.keys(nd?.props?.pageProps || {})).substring(0, 500);
        // Navigate to events
        const events = nd?.props?.pageProps?.content?.matchFacts?.events;
        if (events) {
          eventsKeys = Object.keys(events);
          eventsData = JSON.stringify(events, null, 2).substring(0, 5000);
        } else {
          // Try to find events anywhere in the tree
          const str = nextDataMatch[1];
          const evIdx = str.indexOf('"homeTeamGoals"');
          if (evIdx !== -1) eventsData = str.substring(Math.max(0, evIdx - 20), evIdx + 3000);
        }
      } catch(e) { nextDataKeys = 'parse error: ' + e.message; }
    }

    // Find area around score
    const scoreIdx = html.indexOf('MFHeaderStatusScore');
    const headerArea = scoreIdx !== -1
      ? html.substring(Math.max(0, scoreIdx - 4000), Math.min(html.length, scoreIdx + 4000))
      : null;

    // Find any script tags with match data
    const scriptMatches = [];
    const scriptRe = /<script[^>]*>([\s\S]{20,500}?(?:goal|Goal|card|Card|incident|event|gol)[^<]{0,200})<\/script>/gi;
    let sm;
    while ((sm = scriptRe.exec(html)) !== null && scriptMatches.length < 5) {
      scriptMatches.push(sm[1].substring(0, 300));
    }

    // Look for player links pattern (FotMob uses /es/players/ID/name)
    const playerLinks = [];
    const plRe = /href="\/es\/players\/(\d+)\/([^"]+)"[^>]*>([^<]*)<\/a>/g;
    let pl;
    while ((pl = plRe.exec(html)) !== null && playerLinks.length < 20) {
      playerLinks.push({ id: pl[1], slug: pl[2], text: pl[3] });
    }

    // Find minute patterns (e.g. "34'" or "34'")
    const minuteContext = [];
    const minRe = /(.{0,80})(\d{1,3}&#8204;&#8206;'|[\d]{1,3}')(.{0,80})/g;
    let mc;
    while ((mc = minRe.exec(html)) !== null && minuteContext.length < 15) {
      minuteContext.push({ before: mc[1].replace(/<[^>]+>/g,'').trim(), min: mc[2], after: mc[3].replace(/<[^>]+>/g,'').trim() });
    }

    return res.status(200).json({
      htmlLength: html.length,
      hasNextData,
      nextDataKeys,
      eventsKeys,
      eventsData,
      scoreFound: scoreIdx !== -1,
      headerArea: headerArea ? headerArea.substring(0, 3000) : null,
      playerLinks,
      minuteContext,
      scriptMatches
    });

  } catch(e) {
    return res.status(500).json({ error: e.message, stack: e.stack?.substring(0, 500) });
  }
};
