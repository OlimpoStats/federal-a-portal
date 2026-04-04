// api/sync-live.js
// Vercel serverless function - scrapes FotMob for live scores
// Called by Vercel Cron every 60 seconds

const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // Use service key (not anon) for server-side writes
);

function parseScore(html) {
  // FotMob score pattern: "1 - 3" or "0 - 0"
  const scoreMatch = html.match(/(\d+)\s*-\s*(\d+)/);
  if (!scoreMatch) return null;
  return {
    local: parseInt(scoreMatch[1]),
    visitante: parseInt(scoreMatch[2])
  };
}

function parseMinuto(html) {
  // FotMob minute pattern like "67:07" or "45+2" 
  const minMatch = html.match(/(\d+)(?:\+\d+)?:\d{2}/);
  if (minMatch) return parseInt(minMatch[1]);
  // Check for FT (full time)
  if (html.includes('FT') || html.includes('Fin')) return 90;
  return null;
}

function isLive(html) {
  // Check if match is currently live
  return html.includes(':') && !html.includes('FT') && !html.includes('Fin');
}

module.exports = async (req, res) => {
  // Allow manual trigger via GET, or cron trigger
  try {
    // Get all fixtures with fotmob_url that haven't finished
    const { data: fixtures, error } = await sb
      .from('fixture')
      .select('id, equipo_local, equipo_visitante, zona, fecha, goles_local, goles_visitante, fotmob_url, estado')
      .not('fotmob_url', 'is', null)
      .neq('fotmob_url', '')
      .neq('estado', 'finalizado');

    if (error) {
      console.error('Supabase error:', error);
      return res.status(500).json({ error: error.message });
    }

    if (!fixtures?.length) {
      return res.status(200).json({ message: 'No live fixtures to sync', updated: 0 });
    }

    const results = [];

    for (const fixture of fixtures) {
      try {
        // Fetch FotMob page
        const response = await fetch(fixture.fotmob_url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; AscensoFederal/1.0)',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'es-AR,es;q=0.9',
          },
          signal: AbortSignal.timeout(8000)
        });

        if (!response.ok) {
          results.push({ id: fixture.id, error: `HTTP ${response.status}` });
          continue;
        }

        const html = await response.text();
        const score = parseScore(html);
        
        if (!score) {
          results.push({ id: fixture.id, error: 'Score not found' });
          continue;
        }

        const minuto = parseMinuto(html);
        const live = isLive(html);
        const finished = html.includes('FT') || html.includes('Fin') || 
                        html.includes('Final') || (!live && minuto === 90);

        // Only update if score changed
        if (score.local !== fixture.goles_local || score.visitante !== fixture.goles_visitante) {
          const updateData = {
            goles_local: score.local,
            goles_visitante: score.visitante,
          };
          if (finished) {
            updateData.estado = 'finalizado';
          } else if (live) {
            updateData.estado = 'en_curso';
          }

          const { error: updateError } = await sb
            .from('fixture')
            .update(updateData)
            .eq('id', fixture.id);

          if (updateError) {
            results.push({ id: fixture.id, error: updateError.message });
          } else {
            results.push({ 
              id: fixture.id, 
              updated: true, 
              score: `${score.local}-${score.visitante}`,
              minuto,
              finished
            });
          }
        } else {
          results.push({ id: fixture.id, unchanged: true, score: `${score.local}-${score.visitante}` });
        }

        // Small delay between requests to be polite
        await new Promise(r => setTimeout(r, 500));

      } catch (err) {
        results.push({ id: fixture.id, error: err.message });
      }
    }

    return res.status(200).json({ 
      synced: fixtures.length, 
      results,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('Sync error:', err);
    return res.status(500).json({ error: err.message });
  }
};
