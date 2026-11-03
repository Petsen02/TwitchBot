import { TtlCache } from './cache.js';

/**
 * Champion id -> name, from Data Dragon.
 *
 * spectator-v5 identifies champions by numeric id only, so a live game cannot
 * be described without this map. Data Dragon is a static CDN: no API key, no
 * rate limit. Refetched twice a day so new champions appear without a restart.
 */

const cache = new TtlCache(12 * 60 * 60 * 1000);

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Data Dragon responded ${response.status}`);
  return response.json();
}

function loadMap() {
  return cache.wrap('champions', async () => {
    const versions = await fetchJson('https://ddragon.leagueoflegends.com/api/versions.json');
    const latest = versions[0];
    const payload = await fetchJson(
      `https://ddragon.leagueoflegends.com/cdn/${latest}/data/en_US/champion.json`,
    );

    const byId = new Map();
    for (const champion of Object.values(payload.data ?? {})) {
      byId.set(Number(champion.key), champion.name);
    }
    return byId;
  });
}

export async function championName(championId) {
  try {
    const map = await loadMap();
    return map.get(Number(championId)) ?? `Champion ${championId}`;
  } catch {
    return `Champion ${championId}`;
  }
}

export async function preloadChampions() {
  try {
    await loadMap();
  } catch (error) {
    console.error('[champions] preload failed:', error.message);
  }
}
