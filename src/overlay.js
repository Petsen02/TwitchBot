import { createServer } from 'node:http';
import { config, overlayAllows } from './config.js';
import { store } from './store.js';
import { startOfDay } from './time.js';

/**
 * A browser source for OBS showing today's win/loss count.
 *
 * Every watched player has their own key, and that key is the whole address.
 * One shared page with the player as a parameter would have let anyone who
 * was given a link read everybody else's figures by editing it; a link now
 * gives away nothing but the one player it was made for.
 *
 * It serves figures the tracker has already measured and never calls Riot,
 * so refreshing every few seconds costs nothing. That works only because the
 * result of each game is stored when the game is first seen -- a finished
 * match never changes its mind about who won.
 *
 * The day boundary is the one !session uses, so the count returns to 0/0 at
 * local midnight without anything having to reset it.
 *
 * Off unless OVERLAY_PORT is set: a chat bot has no business listening for
 * connections nobody asked for.
 */

function page(key) {
  return `<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8">
<title>Win/Loss</title>
<style>
  /* Transparent, so OBS composites it over the scene. Override any of this
     in the browser source's own Custom CSS field. */
  html, body { margin: 0; background: transparent; overflow: hidden; }
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
  const DATA_URL = ${JSON.stringify(`/${key}/data`)};
  const node = document.getElementById('score');

  async function refresh() {
    try {
      const response = await fetch(DATA_URL, { cache: 'no-store' });
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
}

function send(response, status, type, body) {
  response.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    // OBS fetches this from a page it owns, which counts as a foreign origin.
    'access-control-allow-origin': '*',
  });
  response.end(body);
}

export function startOverlay() {
  if (!config.overlayPort) return null;

  const server = createServer((request, response) => {
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      return send(response, 400, 'text/plain; charset=utf-8', 'Bad request');
    }

    // "/key" or "/key/data", and nothing else.
    const parts = url.pathname.split('/').filter(Boolean);
    const entry = parts.length === 1 || (parts.length === 2 && parts[1] === 'data')
      ? store.findByOverlayKey(parts[0])
      : null;

    // The list is checked on every request, not only when the key was made,
    // so taking somebody off it closes their link at once.
    // An unknown key is answered exactly like a malformed path, so a wrong
    // guess cannot be told apart from a wrong shape.
    if (!entry || !overlayAllows(entry)) {
      return send(response, 404, 'text/plain; charset=utf-8', 'Not found');
    }

    if (parts.length === 2) {
      const record = store.getRecordSince(entry.puuid, startOfDay(config.timezone));
      return send(response, 200, 'application/json', JSON.stringify(record));
    }

    return send(response, 200, 'text/html; charset=utf-8', page(entry.overlayKey));
  });

  server.on('error', (error) => console.error('[overlay] fejl:', error.message));

  server.listen(config.overlayPort, '0.0.0.0', () => {
    const named = [...config.overlayPlayers].join(', ') || 'ingen — sæt OVERLAY_PLAYERS';
    store.ensureOverlayKeys(overlayAllows);

    console.log(`[overlay] lytter på port ${config.overlayPort}`);
    console.log(`[overlay] overlay til: ${named}`);
    console.log('[overlay] links står i data/spillere.txt');
  });

  server.unref?.();
  return server;
}
