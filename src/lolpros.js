import { TtlCache } from './cache.js';

/**
 * Pro-player lookup via lolpros.gg.
 *
 * lolpros publishes no documented API; this is the same internal endpoint their
 * own site uses, and it can change without notice. Every failure here is
 * swallowed so that !lobby still answers with average rank when lolpros is
 * unreachable — the pro names are a bonus, never a dependency.
 *
 * Results are cached for a day (misses included), so a channel hammering !lobby
 * costs lolpros almost nothing.
 */

const SEARCH_URL = 'https://api.lolpros.gg/es/search';
const lookupCache = new TtlCache(24 * 60 * 60 * 1000);

async function search(gameName) {
  const response = await fetch(`${SEARCH_URL}?query=${encodeURIComponent(gameName)}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) throw new Error(`lolpros responded ${response.status}`);
  return response.json();
}

function matches(account, gameName, tagLine) {
  const sameName = account.gamename?.toLowerCase() === gameName.toLowerCase();
  const sameTag = account.tagline?.toLowerCase() === tagLine.toLowerCase();
  if (sameName && sameTag) return true;

  // Riot IDs change; lolpros keeps the history, so fall back to past names.
  const full = `${gameName}#${tagLine}`.toLowerCase();
  return (account.summoner_names ?? []).some((entry) => entry.name?.toLowerCase() === full);
}

/** Returns { name, slug } when the Riot ID belongs to a known pro, else null. */
export function lookupPro({ gameName, tagLine }) {
  const key = `${gameName}#${tagLine}`.toLowerCase();

  return lookupCache.wrap(key, async () => {
    try {
      const results = await search(gameName);

      for (const player of results ?? []) {
        const accounts = player.league_player?.accounts ?? [];
        if (accounts.some((account) => matches(account, gameName, tagLine))) {
          return { name: player.name, slug: player.slug };
        }
      }
    } catch {
      // Treated as "not a pro" for this cache window rather than failing !lobby.
    }

    return null;
  });
}

/** Looks up many Riot IDs with a small concurrency cap, to stay polite. */
export async function lookupPros(riotIds, concurrency = 3) {
  const found = new Map();
  const queue = [...riotIds];

  async function worker() {
    while (queue.length > 0) {
      const riotId = queue.shift();
      const pro = await lookupPro(riotId);
      if (pro) found.set(`${riotId.gameName}#${riotId.tagLine}`.toLowerCase(), pro);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, riotIds.length) }, worker));
  return found;
}
