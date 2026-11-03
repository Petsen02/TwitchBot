import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader. Avoids a dotenv dependency and works on any Node >= 18,
// unlike process.loadEnvFile() which needs 20.12+.
function loadEnvFile() {
  let raw;
  try {
    raw = readFileSync(join(projectRoot, '.env'), 'utf8');
  } catch {
    return; // No .env is fine when the host injects real environment variables.
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }

    // Real environment variables win, so the host's config can override the file.
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

// Riot splits its API across two kinds of host. league-v4, spectator-v5 and the
// apex ladders live on the platform host (euw1); account-v1 and match-v5 live
// on the wider regional host (europe). Mixing them up is the classic source of
// mystery 404s.
//
// ph2 and th2 are deliberately absent: Riot folded the Philippines and
// Thailand into Singapore, and those hostnames no longer resolve. Accepting
// them would let a channel pick a region that can never answer, failing as a
// network error rather than as an unknown region.
export const PLATFORM_TO_REGION = {
  br1: 'americas',
  na1: 'americas',
  la1: 'americas',
  la2: 'americas',
  eun1: 'europe',
  euw1: 'europe',
  me1: 'europe',
  tr1: 'europe',
  ru: 'europe',
  kr: 'asia',
  jp1: 'asia',
  tw2: 'sea',
  sg2: 'sea',
  vn2: 'sea',
  oc1: 'sea',
};

export const PLATFORMS = new Set(Object.keys(PLATFORM_TO_REGION));

export function regionFor(platform) {
  const region = PLATFORM_TO_REGION[platform];
  if (!region) throw new Error(`Ukendt region "${platform}"`);
  return region;
}

function required(key) {
  const value = process.env[key];
  if (!value) throw new Error(`Manglende indstilling ${key} — se .env.example`);
  return value;
}

/** Splits "Name#TAG" into its parts. Returns null for anything malformed. */
export function parseRiotId(input) {
  if (!input) return null;

  const hash = input.lastIndexOf('#');
  if (hash <= 0 || hash === input.length - 1) return null;

  const gameName = input.slice(0, hash).trim();
  const tagLine = input.slice(hash + 1).trim();
  if (!gameName || !tagLine) return null;

  return { gameName, tagLine, riotId: `${gameName}#${tagLine}` };
}

export const defaultPlatform = (process.env.RIOT_PLATFORM || 'euw1').toLowerCase();
if (!PLATFORMS.has(defaultPlatform)) {
  throw new Error(
    `RIOT_PLATFORM "${defaultPlatform}" er ukendt. Gyldige: ${[...PLATFORMS].join(', ')}`,
  );
}

/**
 * Defaults to "emotes", the style this bot is actually run with; "letters" is
 * the fallback for channels without the 7TV emote set.
 *
 * A misspelled value used to fall back silently, which looked exactly like the
 * setting having no effect. It is now refused outright rather than guessed at.
 */
function parseRankStyle(raw) {
  if (!raw) return 'emotes';

  const value = raw.trim().toLowerCase();
  if (value === 'letters' || value === 'emotes') return value;

  throw new Error(`RANK_STYLE skal være "letters" eller "emotes", fik "${raw}"`);
}

function seconds(key, fallback) {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} skal være et positivt tal`);
  return value * 1000;
}

function count(key, fallback) {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} skal være et positivt tal`);
  return value;
}

export const config = {
  riot: {
    apiKey: required('RIOT_API_KEY'),
    // Personal key allowance. The two-minute window is the binding one.
    limits: [
      { limit: count('RIOT_LIMIT_PER_SECOND', 20), windowMs: 1000 },
      { limit: count('RIOT_LIMIT_PER_TWO_MINUTES', 100), windowMs: 120_000 },
    ],
  },
  defaultPlatform,
  rankStyle: parseRankStyle(process.env.RANK_STYLE),
  timezone: process.env.TIMEZONE || 'Europe/Copenhagen',
  // Ladder position is only interesting near the top; beyond this it is noise.
  ladderPositionLimit: count('LADDER_POSITION_LIMIT', 250),
  // Cutoffs refresh on fixed clock boundaries, so chat shares one figure.
  // 1440 means once a day at local midnight.
  cutoffRefreshMs: seconds('CUTOFF_REFRESH_MINUTES', 1440) * 60,
  rankCacheMs: seconds('RANK_CACHE_SECONDS', 60),
  commandCooldownMs: seconds('COMMAND_COOLDOWN_SECONDS', 5),
  // Accounts that are actually playing are polled often enough that two games
  // never fall into one window; idle ones back off hard, which is what makes
  // many channels affordable on a personal key.
  activePollMs: seconds('ACTIVE_POLL_SECONDS', 60),
  idlePollMs: seconds('IDLE_POLL_SECONDS', 600),
  // How long after a game a player still counts as active.
  activeWindowMs: seconds('ACTIVE_WINDOW_MINUTES', 45) * 60,
};

/**
 * Channels listed in .env are joined and created on startup; everything after
 * that is managed from chat.
 */
export function bootstrapChannels() {
  return (process.env.TWITCH_CHANNELS || '')
    .split(',')
    .map((c) => c.trim().toLowerCase().replace(/^#/, ''))
    .filter(Boolean);
}

/** Optional seed roster for the first channel, used only when it is empty. */
export function seedPlayers() {
  return (process.env.PLAYERS || '')
    .split(',')
    .map((entry) => parseRiotId(entry.trim()))
    .filter(Boolean);
}

export function seedMain() {
  return parseRiotId(process.env.DEFAULT_RIOT_ID || '');
}

/**
 * Twitch settings are validated on demand rather than at import time, so the
 * Riot-only smoke test can run before any Twitch credentials exist.
 */
export function getTwitchConfig() {
  const token = required('TWITCH_OAUTH_TOKEN');

  return {
    username: required('TWITCH_BOT_USERNAME').toLowerCase(),
    // tmi.js wants the "oauth:" prefix; accept the token with or without it.
    password: token.startsWith('oauth:') ? token : `oauth:${token}`,
  };
}
