import { config, regionFor } from './config.js';
import { TtlCache } from './cache.js';
import { RateLimiter } from './limiter.js';

/** An API failure we can turn into a sensible chat message. */
export class RiotError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.name = 'RiotError';
    this.kind = kind;
    this.status = status;
  }
}

// Riot counts its limits per region, so each gets its own budget rather than
// sharing one. A busy EUW channel then cannot starve a NA one.
const limiters = new Map();

function limiterFor(platform) {
  const region = regionFor(platform);
  if (!limiters.has(region)) limiters.set(region, new RateLimiter(config.riot.limits));
  return limiters.get(region);
}

// Caches are keyed by platform as well as subject: the same Riot ID can exist
// on two servers, and a cached NA rank must never answer a EUW question.
const puuidCache = new TtlCache(Infinity, 1000);
const rankCache = new TtlCache(config.rankCacheMs, 500);
const matchCache = new TtlCache(Infinity, 20);
const activeGameCache = new TtlCache(30_000, 200);
const apexCache = new TtlCache(10 * 60_000, 20);

function describe(status) {
  switch (status) {
    case 401:
    case 403:
      return new RiotError('auth', 'Riot API key rejected — expired or invalid', status);
    case 404:
      return new RiotError('not_found', 'Not found', status);
    case 429:
      return new RiotError('rate_limit', 'Rate limited by Riot', status);
    case 500:
    case 502:
    case 503:
    case 504:
      return new RiotError('unavailable', 'Riot API is having problems', status);
    default:
      return new RiotError('unknown', `Unexpected Riot API status ${status}`, status);
  }
}

async function request(platform, url, { retries = 2 } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Every call waits its turn, so bursts queue instead of earning 429s.
    await limiterFor(platform).acquire();

    let response;
    try {
      response = await fetch(url, {
        headers: { 'X-Riot-Token': config.riot.apiKey },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      lastError = new RiotError('network', 'Could not reach the Riot API', null);
      continue;
    }

    if (response.ok) return response.json();

    // 404 is a legitimate answer ("no active game", "no such account"), never a
    // transient fault, so it must not burn retries.
    if (response.status === 404) throw describe(404);

    lastError = describe(response.status);

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === retries) throw lastError;

    const retryAfter = Number(response.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 500 * 2 ** attempt;

    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  throw lastError;
}

const platformHost = (platform) => `https://${platform}.api.riotgames.com`;
const regionHost = (platform) => `https://${regionFor(platform)}.api.riotgames.com`;

export const SOLO_QUEUE = 'RANKED_SOLO_5x5';
export const FLEX_QUEUE = 'RANKED_FLEX_SR';
export const SOLO_QUEUE_ID = 420;

/** Resolves "Name#TAG" to a Riot account, including its PUUID. */
export function getAccount(platform, { gameName, tagLine }) {
  // account-v1 is regional, so one cache entry serves every platform in it.
  const key = `${regionFor(platform)}:${gameName}#${tagLine}`.toLowerCase();

  return puuidCache.wrap(key, () =>
    request(
      platform,
      `${regionHost(platform)}/riot/account/v1/accounts/by-riot-id/`
        + `${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
    ),
  );
}

/** All ranked queue entries for a player. */
export function getLeagueEntries(platform, puuid, { fresh = false } = {}) {
  const url = `${platformHost(platform)}/lol/league/v4/entries/by-puuid/${puuid}`;
  if (fresh) return request(platform, url);

  return rankCache.wrap(`${platform}:${puuid}`, () => request(platform, url));
}

export function pickQueue(entries, queueType = SOLO_QUEUE) {
  return entries?.find((entry) => entry.queueType === queueType) ?? null;
}

/**
 * The Challenger and Grandmaster ladders, sorted highest LP first.
 *
 * Riot exposes no "what number am I" endpoint, so a player's position is their
 * index in the combined ladder. Master is not fetched here: its best players
 * sit far below the positions worth reporting, so it cannot affect them.
 */
function getApexLadder(platform) {
  return apexCache.wrap(platform, async () => {
    const [challenger, grandmaster] = await Promise.all([
      request(platform, `${platformHost(platform)}/lol/league/v4/challengerleagues/by-queue/${SOLO_QUEUE}`),
      request(platform, `${platformHost(platform)}/lol/league/v4/grandmasterleagues/by-queue/${SOLO_QUEUE}`),
    ]);

    const byLp = (a, b) => b.leaguePoints - a.leaguePoints;

    const challengerEntries = [...(challenger.entries ?? [])].sort(byLp);
    const grandmasterEntries = [...(grandmaster.entries ?? [])].sort(byLp);

    return {
      combined: [...challengerEntries, ...grandmasterEntries],
      challengerSlots: challengerEntries.length,
      grandmasterSlots: grandmasterEntries.length,
    };
  });
}

/** Overall ladder position, or null if the player is not in Challenger or GM. */
export async function getLadderPosition(platform, puuid) {
  const { combined } = await getApexLadder(platform);
  const index = combined.findIndex((entry) => entry.puuid === puuid);
  return index === -1 ? null : index + 1;
}

/**
 * LP needed to be inside Challenger and Grandmaster right now.
 *
 * The naive answer — the lowest LP inside each league — is wrong. Riot only
 * recalculates apex tier membership periodically, so at any moment plenty of
 * Grandmasters out-rank the weakest Challengers, and plenty of Masters
 * out-rank the weakest Grandmasters. The real threshold is positional: with
 * 300 Challenger slots, the cutoff is whatever the 300th player on the
 * combined ladder has.
 *
 * Master is needed for the Grandmaster figure and is large (10k players, ~2MB
 * on EUW), so only its LP values are kept and the payload is discarded
 * immediately. This runs on the cutoff schedule, not per command.
 */
export async function getCutoffs(platform) {
  const [{ combined, challengerSlots, grandmasterSlots }, masterPoints] = await Promise.all([
    getApexLadder(platform),
    request(platform, `${platformHost(platform)}/lol/league/v4/masterleagues/by-queue/${SOLO_QUEUE}`)
      .then((league) => (league.entries ?? []).map((entry) => entry.leaguePoints))
      .catch(() => []),
  ]);

  const allPoints = [...combined.map((entry) => entry.leaguePoints), ...masterPoints]
    .sort((a, b) => b - a);

  const at = (position) =>
    position > 0 && position <= allPoints.length ? allPoints[position - 1] : null;

  return {
    challengerCutoff: at(challengerSlots),
    grandmasterCutoff: at(challengerSlots + grandmasterSlots),
    challengerSlots,
    grandmasterSlots,
  };
}

/** The game a player is in right now, or null when they are not in one. */
export async function getActiveGame(platform, puuid) {
  try {
    return await activeGameCache.wrap(`${platform}:${puuid}`, () =>
      request(platform, `${platformHost(platform)}/lol/spectator/v5/active-games/by-summoner/${puuid}`),
    );
  } catch (error) {
    if (error.kind === 'not_found') return null;
    throw error;
  }
}

/** Ranked solo match IDs, newest first. startTime is in seconds. */
export function getMatchIds(platform, puuid, { startTime, count = 20, queue = SOLO_QUEUE_ID } = {}) {
  const params = new URLSearchParams({ count: String(count) });
  if (queue) params.set('queue', String(queue));
  if (startTime) params.set('startTime', String(Math.floor(startTime)));

  return request(platform, `${regionHost(platform)}/lol/match/v5/matches/by-puuid/${puuid}/ids?${params}`);
}

export function getMatch(platform, matchId) {
  return matchCache.wrap(matchId, () =>
    request(platform, `${regionHost(platform)}/lol/match/v5/matches/${matchId}`),
  );
}
