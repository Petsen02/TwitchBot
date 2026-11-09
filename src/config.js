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

/**
 * What players call each region, as opposed to what Riot's routing calls it.
 *
 * The trailing digit in "euw1" is a routing detail nobody says out loud. It
 * cannot simply be stripped either: la1 and la2 are two different regions
 * that would both come out as "LA", and eun1 is EUNE to everyone who plays
 * there.
 */
const REGION_LABELS = {
  br1: 'BR',
  na1: 'NA',
  la1: 'LAN',
  la2: 'LAS',
  eun1: 'EUNE',
  euw1: 'EUW',
  me1: 'ME',
  tr1: 'TR',
  ru: 'RU',
  kr: 'KR',
  jp1: 'JP',
  tw2: 'TW',
  sg2: 'SG',
  vn2: 'VN',
  oc1: 'OCE',
};

/**
 * The names this entry is listed under, if any.
 *
 * A channel's own name counts, so naming a streamer gives their channel's
 * main an overlay without anyone having to look up which Riot account that
 * is. Roster entries carry their channels; watch entries carry the Twitch
 * name of whoever asked.
 */
function overlayNames(entry) {
  if (!entry) return [];

  const candidates = [
    (entry.twitch ?? '').toLowerCase(),
    (entry.riotId ?? '').toLowerCase(),
    ...(entry.channels ?? []).map((name) => name.toLowerCase()),
  ];

  return candidates.filter((name) => name && config.overlayPlayers.has(name));
}

/** Whether this watch-list entry is one of the named overlay players. */
export function overlayAllows(entry) {
  return overlayNames(entry).length > 0;
}

/**
 * The channel name this roster account is listed under, if any.
 *
 * Used to carry the match across when a roster account is pulled onto the
 * watch list: the watch entry has no channels of its own, so without this
 * the account would stop matching the moment it was copied.
 */
export function overlayChannelMatch(account) {
  for (const name of account?.channels ?? []) {
    if (config.overlayPlayers.has(name.toLowerCase())) return name.toLowerCase();
  }

  return null;
}

/** The key chosen for this entry in OVERLAY_PLAYERS, or null for a random one. */
export function overlayChosenKey(entry) {
  for (const name of overlayNames(entry)) {
    const key = config.overlayPlayers.get(name);
    if (key) return key;
  }

  return null;
}

export function regionLabel(platform) {
  return REGION_LABELS[platform] ?? platform.toUpperCase();
}

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

/** Comma-separated Twitch logins, lowercased for comparison with chat tags. */
function parseOwners(raw) {
  return new Set(
    (raw || '')
      .split(',')
      .map((name) => name.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean),
  );
}

function seconds(key, fallback) {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} skal være et positivt tal`);
  return value * 1000;
}

/**
 * "wendelbolol, someone:their-own-key" into a map of name to chosen key.
 *
 * A key the operator picked is a path on a public server, so it is held to
 * what reads safely in a URL. Anything else is refused outright rather than
 * quietly cleaned up into an address nobody expected.
 */
function parseOverlayPlayers(raw) {
  const players = new Map();

  for (const part of (raw || '').split(',')) {
    const entry = part.trim();
    if (!entry) continue;

    const colon = entry.lastIndexOf(':');
    const name = (colon === -1 ? entry : entry.slice(0, colon)).trim().toLowerCase();
    const key = colon === -1 ? null : entry.slice(colon + 1).trim();

    if (!name) continue;

    if (key !== null && !/^[A-Za-z0-9_-]{4,64}$/.test(key)) {
      throw new Error(
        `OVERLAY_PLAYERS: "${key}" duer ikke som nøgle — brug 4-64 tegn, `
        + 'kun bogstaver, tal, bindestreg og underscore',
      );
    }

    players.set(name, key);
  }

  return players;
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
  // Twitch logins that operate the bot. They can run every command in every
  // channel, whether or not they are a moderator there — including removing
  // the bot from a channel they have no account in.
  botOwners: parseOwners(process.env.BOT_OWNERS ?? process.env.BOT_OWNER),
  rankStyle: parseRankStyle(process.env.RANK_STYLE),
  timezone: process.env.TIMEZONE || 'Europe/Copenhagen',
  // Where !oldcommands points. Change this to the Pages URL once it is live,
  // without touching the code.
  wikiUrl: process.env.WIKI_URL || 'https://github.com/Petsen02/TwitchBot',
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
  // The OBS overlay. Off unless a port is set, because a chat bot has no
  // business listening for connections nobody asked for. The path is a
  // password in all but name: anyone who has the URL can read the figures,
  // so it should not be guessable.
  overlayPort: process.env.OVERLAY_PORT ? count('OVERLAY_PORT', 0) : null,
  // Only used to print whole links in data/spillere.txt. The bot cannot know
  // its own public address, so without this the file lists just the path.
  overlayBaseUrl: (process.env.OVERLAY_BASE_URL || '').replace(/\/+$/, ''),
  // Who gets an overlay. Named one by one rather than given to everyone on
  // the watch list: that list fills with anybody a viewer happened to look
  // up, and a link for each of them is a link nobody asked for.
  //
  // An entry matches either a Twitch name or a Riot ID, so a streamer can be
  // named before the bot has worked out which account is theirs.
  //
  // "name:key" sets the address yourself, so the link is known before the bot
  // has ever run and can be handed over without reading it back off the
  // server. Plain "name" gets a random one instead.
  overlayPlayers: parseOverlayPlayers(process.env.OVERLAY_PLAYERS),
};

/** Comma-separated channel names, normalised the way Twitch reports them. */
function channelList(raw) {
  return (raw || '')
    .split(',')
    .map((c) => c.trim().toLowerCase().replace(/^#/, ''))
    .filter(Boolean);
}

/**
 * The channels the bot belongs in — the whole list, not additions to it.
 *
 * Anything missing from here is left on the next start, so a channel is
 * removed by deleting its name from this line rather than by announcing it in
 * the channel. Rosters survive, so a name removed by mistake costs a restart,
 * not a rebuild.
 */
export function bootstrapChannels() {
  return channelList(process.env.TWITCH_CHANNELS);
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
