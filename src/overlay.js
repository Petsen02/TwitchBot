import { createServer } from 'node:http';
import { config } from './config.js';
import { store } from './store.js';
import { startOfDay } from './time.js';

/**
 * A browser source for OBS showing today's win/loss count.
 *
 * It serves the figures the tracker has already measured and never calls
 * Riot, so refreshing it every few seconds costs nothing. That is only
 * possible because the result of each game is stored when the game is first
 * seen -- a finished match never changes its mind about who won.
 *
 * The day boundary is the same one !session uses, so the count returns to
 * 0/0 at local midnight without anything having to reset it.
 *
 * Off unless OVERLAY_PORT is set. The path stands in for a password: there
 * is nothing secret in the numbers, but a URL nobody can guess keeps
 * strangers from watching along.
 */

const PAGE = `<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8">
<title>Win/Loss</title>
<style>
  /* Transparent, so OBS composites it over the scene. Override any of this
     in the browser source's own Custom CSS field. */
  html, body {
    margin: 0;
    background: transparent;
    overflow: hidden;
  }
  #score {
    font: 700 72px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #fff;
    text-shadow: 0 2px 6px rgba(0, 0, 0, .8);
    padding: 8px 16px;
    white-space: nowrap;
  }
  .wins { color: #4ade80; }
  .losses { color: #f87171; }
</style>
</head>
<body>
  <div id="score"><span class="wins">0</span>/<span class="losses">0</span></div>
<script>
  const player = new URLSearchParams(location.search).get('player') || '';
  const node = document.getElementById('score');

  async function refresh() {
    try {
      const response = await fetch('data?player=' + encodeURIComponent(player), {
        cache: 'no-store',
      });
      if (!response.ok) return;

      const { wins, losses } = await response.json();
      node.innerHTML = '<span class="wins">' + wins + '</span>/'
        + '<span class="losses">' + losses + '</span>';
    } catch {
      // A failed poll leaves the last figures on screen. A scoreboard that
      // blanks itself because one request timed out is worse than a stale one.
    }
  }

  refresh();
  setInterval(refresh, 5000);
</script>
</body>
</html>
`;

function record(riotId) {
  if (!riotId) return { wins: 0, losses: 0 };

  const puuid = store.findByRiotId(riotId);
  if (!puuid) return { wins: 0, losses: 0 };

  return store.getRecordSince(puuid, startOfDay(config.timezone));
}

function send(response, status, type, body) {
  response.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    // OBS fetches this from a file:// page, which counts as a foreign origin.
    'access-control-allow-origin': '*',
  });
  response.end(body);
}

export function startOverlay() {
  if (!config.overlayPort) return null;

  const base = `/${config.overlayPath}`;

  const server = createServer((request, response) => {
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      return send(response, 400, 'text/plain; charset=utf-8', 'Bad request');
    }

    const path = url.pathname.replace(/\/+$/, '');

    if (path === `${base}/data`) {
      const { wins, losses } = record(url.searchParams.get('player'));
      return send(response, 200, 'application/json', JSON.stringify({ wins, losses }));
    }

    if (path === base) return send(response, 200, 'text/html; charset=utf-8', PAGE);

    // Anything else, including a wrong path, gets the same blank answer, so
    // the real one cannot be found by guessing.
    return send(response, 404, 'text/plain; charset=utf-8', 'Not found');
  });

  server.on('error', (error) => console.error('[overlay] fejl:', error.message));

  server.listen(config.overlayPort, '0.0.0.0', () => {
    console.log(`[overlay] lytter på port ${config.overlayPort}${base}`);
  });

  server.unref?.();
  return server;
}
