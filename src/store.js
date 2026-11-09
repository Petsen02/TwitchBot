import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './config.js';
import { randomBytes } from 'node:crypto';
import { openDatabase } from './sqlite.js';

/**
 * Durable state for LP tracking.
 *
 * Riot exposes no LP history, so every LP figure this bot reports is measured
 * by us: we snapshot each tracked player's ladder position, and when a new
 * ranked match appears we attribute the change to that match. Losing this file
 * means losing LP history, so writes are atomic (write temp, then rename).
 *
 * There are two backings. SQLite is used when the Node running the bot has
 * `node:sqlite`, and every change is written to it as it happens, one row at
 * a time. Otherwise the whole state is held in memory and written to a JSON
 * file, as it always was.
 *
 * The JSON file is rewritten in full on every save, so its cost grows with
 * the history kept -- which is why history was capped at a fortnight. SQLite
 * removes that ceiling. The switch happens on its own: upgrade Node, restart,
 * and the first run imports the JSON file and carries on from there. The old
 * file is left untouched, so going back is just downgrading again.
 *
 * Either way the state lives in memory and reads are synchronous, so nothing
 * else in the bot has to know which backing is in use.
 */

const DATA_DIR = join(projectRoot, 'data');
const DATA_FILE = join(DATA_DIR, 'tracker.json');
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

// A refresh is only persisted once an hour. Without this every !session would
// rewrite the file just to move a timestamp a few seconds.
const WATCH_REFRESH_MS = 60 * 60 * 1000;

/**
 * Whether a Twitch name is the same name as the Riot ID's game name.
 *
 * Spaces come out because a Twitch name cannot contain one, so "Lil Rasmus"
 * and "lilrasmus" are the same person writing the same name under two sets of
 * rules. Case goes the same way: Twitch is not case sensitive and Riot is.
 */
function namesMatch(twitch, riotId) {
  if (!twitch || !riotId) return false;

  const hash = riotId.lastIndexOf('#');
  const gameName = hash > 0 ? riotId.slice(0, hash) : riotId;
  const flatten = (value) => value.toLowerCase().replace(/\s+/g, '');

  return flatten(twitch) === flatten(gameName);
}

/**
 * A player's own overlay address.
 *
 * One shared URL with the player as a parameter would let anyone holding it
 * read anyone else's figures by editing it. A key per player means a link
 * can be handed out on its own, and gives away nothing but that one player.
 */
function newOverlayKey() {
  return randomBytes(9).toString('hex');
}

function emptyState() {
  return { version: 1, accounts: {} };
}

export class Store {
  #state;
  #db;

  constructor({ quiet = false } = {}) {
    this.#db = openDatabase();

    if (!this.#db) {
      this.#state = this.#readJson();
      if (!quiet) console.log('[store] node:sqlite findes ikke — bruger JSON');
      return;
    }

    // A database with nothing in it on a bot that has been running is the
    // first start after the upgrade, so the JSON file is carried across. The
    // file is only read, never removed: it is the way back if SQLite is not
    // wanted after all.
    if (this.#db.isEmpty()) {
      const existing = this.#readJson();
      const carried = Object.keys(existing.accounts ?? {}).length;

      if (carried > 0) {
        this.#db.importState(existing);
        if (!quiet) console.log(`[store] flyttede ${carried} konti fra JSON til SQLite`);
      }
    }

    this.#state = this.#db.readState();
    if (!quiet) console.log(`[store] bruger SQLite (${this.#db.path})`);
  }

  #readJson() {
    try {
      const parsed = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.accounts) return parsed;
      return emptyState();
    } catch {
      return emptyState();
    }
  }

  /**
   * On SQLite this is a no-op: every change was already written when it was
   * made. The callers still call it, because they have to on JSON.
   */
  save() {
    if (this.#db) return;

    mkdirSync(DATA_DIR, { recursive: true });

    // Write to a sibling file first so a crash mid-write cannot leave the real
    // file truncated; rename is atomic on the same filesystem.
    const temp = `${DATA_FILE}.tmp`;
    writeFileSync(temp, JSON.stringify(this.#state), 'utf8');
    renameSync(temp, DATA_FILE);
  }

  #account(puuid, riotId) {
    let account = this.#state.accounts[puuid];
    if (!account) {
      account = { riotId, snapshot: null, matches: {}, baselines: {} };
      this.#state.accounts[puuid] = account;
    }
    if (riotId) account.riotId = riotId;
    account.matches ??= {};
    account.baselines ??= {};
    this.#db?.putAccount(puuid, account.riotId);
    return account;
  }

  getSnapshot(puuid) {
    return this.#state.accounts[puuid]?.snapshot ?? null;
  }

  setSnapshot(puuid, riotId, snapshot) {
    this.#account(puuid, riotId).snapshot = snapshot;
    this.#db?.putSnapshot(puuid, snapshot);
  }

  /** LP delta recorded for a specific match, or null if we never measured it. */
  getMatchDelta(puuid, matchId) {
    return this.#state.accounts[puuid]?.matches?.[matchId]?.lpDelta ?? null;
  }

  hasMatch(puuid, matchId) {
    return Boolean(this.#state.accounts[puuid]?.matches?.[matchId]);
  }

  recordMatch(puuid, riotId, matchId, { lpDelta, at, win = null }) {
    const record = { lpDelta, win, at: at ?? Date.now() };
    this.#account(puuid, riotId).matches[matchId] = record;
    this.#db?.putMatch(puuid, matchId, record);
  }

  /**
   * The ladder score a player started the given local day on, with the time it
   * was captured. The timestamp matters: a baseline taken after the player had
   * already played is not a valid anchor for the whole day, and using one
   * anyway would report a day of wins as a flat zero.
   */
  getBaseline(puuid, dateKey) {
    const stored = this.#state.accounts[puuid]?.baselines?.[dateKey];
    if (stored === undefined || stored === null) return null;

    // Baselines were once stored as a bare number, before the timestamp
    // existed. Those cannot be validated, so they are treated as untrusted.
    if (typeof stored === 'number') return { absolute: stored, at: null };

    return stored;
  }

  setBaselineIfMissing(puuid, riotId, dateKey, absolute, at = Date.now()) {
    const account = this.#account(puuid, riotId);
    if (account.baselines[dateKey] === undefined) {
      account.baselines[dateKey] = { absolute, at };
      this.#db?.putBaseline(puuid, dateKey, { absolute, at });
      return true;
    }
    return false;
  }

  /** The last scheduled cutoff reading for a region, kept across restarts. */
  getCutoffSnapshot(platform) {
    return this.#state.cutoffs?.[platform] ?? null;
  }

  setCutoffSnapshot(platform, snapshot) {
    this.#state.cutoffs ??= {};

    // Cutoffs were stored flat before regions existed. Those leftover keys are
    // harmless but never go away on their own, so drop them when passing by.
    for (const [key, value] of Object.entries(this.#state.cutoffs)) {
      if (typeof value !== 'object' || value === null) delete this.#state.cutoffs[key];
    }

    this.#state.cutoffs[platform] = snapshot;
    this.#db?.putCutoff(platform, snapshot);
  }

  /**
   * The player's own average LP per win, from measured games.
   *
   * Far better than assuming a flat figure: LP gains vary a lot with MMR, and
   * a player on a winning streak earns very different amounts from one who is
   * stuck. Returns null until at least one win has been measured.
   */
  getAverageLpGain(puuid) {
    const matches = this.#state.accounts[puuid]?.matches;
    if (!matches) return null;

    const gains = Object.values(matches)
      .map((record) => record.lpDelta)
      .filter((delta) => typeof delta === 'number' && delta > 0);

    if (gains.length === 0) return null;

    return gains.reduce((sum, value) => sum + value, 0) / gains.length;
  }

  /**
   * The bot's own watch list, independent of any channel's roster.
   *
   * A channel roster says who a streamer cares about; this says who we are
   * measuring. They are deliberately separate: asking about a player in chat
   * should start measuring them, but it should not quietly appear in the
   * streamer's !players list, which mods curate themselves.
   *
   * Entries are permanent and there is no way off the list. Once a player has
   * been asked about, they keep being measured, so their LP is right every
   * following day rather than only after somebody remembered to ask first.
   * The cost is Riot requests, and this list is what has to stay within the
   * key's budget — see README.
   *
   * `twitch` is whoever typed the command, recorded from the first person to
   * ask. The bot cannot tell whether somebody is asking about their own
   * account, so that first name is a guess, and a later asker is normally no
   * more likely to be the owner.
   *
   * Unless their Twitch name is the Riot name. That is the closest thing to
   * a claim of ownership the bot can see, so it takes the link from a guess.
   * It cannot take it from another name that matches just as well, and a
   * name that does not match cannot take it at all -- so the link can still
   * only move towards the likely owner, never away.
   *
   * @returns 'added' | 'refreshed' | 'current'
   */
  watch(platform, puuid, riotId, at = Date.now(), twitch = null) {
    this.#state.watch ??= {};

    const key = `${platform}:${puuid}`;
    const existing = this.#state.watch[key];

    if (!existing) {
      const entry = { platform, puuid, riotId, addedAt: at, lastAskedAt: at, twitch };
      this.#state.watch[key] = entry;
      this.#db?.putWatch(entry);
      return 'added';
    }

    existing.riotId = riotId;

    // A blank entry -- one from before the link existed -- takes the next
    // asker it sees rather than staying blank for good.
    const claimed = Boolean(twitch)
      && (!existing.twitch
        || (namesMatch(twitch, riotId) && !namesMatch(existing.twitch, riotId)));

    if (claimed) existing.twitch = twitch;

    if (!claimed && at - (existing.lastAskedAt ?? 0) < WATCH_REFRESH_MS) return 'current';

    existing.lastAskedAt = at;
    this.#db?.putWatch(existing);
    return 'refreshed';
  }

  /** Every watch-list account, shaped like a roster entry. */
  watchedAccounts() {
    return Object.values(this.#state.watch ?? {});
  }

  /**
   * Gives a key to each entry `allow` accepts and has none yet.
   *
   * Keys are handed out rather than minted with the entry, because most of
   * the watch list is viewers somebody looked up once. A link for each of
   * them is a link nobody asked for.
   *
   * @returns how many were given one.
   */
  ensureOverlayKeys(allow, chosenKey = () => null) {
    let changed = 0;

    for (const entry of Object.values(this.#state.watch ?? {})) {
      if (!allow(entry)) continue;

      // A key named in the settings wins, every start. That is what lets the
      // address be decided up front and changed later by editing one line.
      const wanted = chosenKey(entry) ?? entry.overlayKey ?? newOverlayKey();
      if (wanted === entry.overlayKey) continue;

      entry.overlayKey = wanted;
      this.#db?.putWatch(entry);
      changed += 1;
    }

    if (changed > 0) this.save();
    return changed;
  }

  /** The account a given overlay key belongs to, or null. */
  findByOverlayKey(key) {
    if (!key) return null;

    for (const entry of Object.values(this.#state.watch ?? {})) {
      if (entry.overlayKey === key) return entry;
    }

    return null;
  }

  /**
   * Gives a ladder change to the most recent match that went unmeasured.
   *
   * Riot's ladder lags a little behind the game ending, so a poll that
   * catches a match the moment it finishes often reads a position that has
   * not moved yet. The match is recorded without a figure, and the movement
   * turns up on a later poll with no new game to explain it -- this is where
   * the two are put back together.
   *
   * Only a recent match is eligible. An older one is past the point where a
   * ladder change can safely be assumed to belong to it rather than to
   * something else, such as a decay.
   *
   * @returns true if a match was given the figure.
   */
  attributePending(puuid, delta, { now = Date.now(), maxAgeMs }) {
    const matches = this.#state.accounts[puuid]?.matches;
    if (!matches || delta === 0) return false;

    let newestId = null;
    let newestAt = 0;

    for (const [matchId, record] of Object.entries(matches)) {
      if (record.lpDelta !== null && record.lpDelta !== undefined) continue;
      if (now - (record.at ?? 0) > maxAgeMs) continue;
      if ((record.at ?? 0) <= newestAt) continue;

      newestId = matchId;
      newestAt = record.at ?? 0;
    }

    if (!newestId) return false;

    matches[newestId].lpDelta = delta;
    this.#db?.putMatch(puuid, newestId, matches[newestId]);
    return true;
  }

  /**
   * Wins and losses recorded for this account since a point in time.
   *
   * Matches whose result we never learned are left out of both counts rather
   * than guessed at, so the figures only ever understate.
   */
  getRecordSince(puuid, since) {
    const matches = this.#state.accounts[puuid]?.matches ?? {};
    let wins = 0;
    let losses = 0;

    for (const record of Object.values(matches)) {
      if ((record.at ?? 0) < since || record.win === null || record.win === undefined) continue;
      if (record.win) wins += 1;
      else losses += 1;
    }

    return { wins, losses };
  }

  /** The account whose Riot ID this is, or null. Case does not matter. */
  findByRiotId(riotId) {
    const wanted = riotId.toLowerCase();

    for (const [puuid, account] of Object.entries(this.#state.accounts)) {
      if (account.riotId?.toLowerCase() === wanted) return puuid;
    }

    for (const entry of Object.values(this.#state.watch ?? {})) {
      if (entry.riotId?.toLowerCase() === wanted) return entry.puuid;
    }

    return null;
  }

  /** When this account last had a match recorded, used to pace polling. */
  getLastMatchAt(puuid) {
    const matches = this.#state.accounts[puuid]?.matches;
    if (!matches) return null;

    let latest = null;
    for (const record of Object.values(matches)) {
      if (record.at && (latest === null || record.at > latest)) latest = record.at;
    }
    return latest;
  }

  /** Drops old matches, baselines and watch entries so the file stays small. */
  prune(now = Date.now()) {
    const cutoff = now - RETENTION_MS;

    for (const [puuid, account] of Object.entries(this.#state.accounts)) {
      for (const [matchId, record] of Object.entries(account.matches ?? {})) {
        if ((record.at ?? 0) < cutoff) delete account.matches[matchId];
      }

      const keepFrom = new Date(cutoff).toISOString().slice(0, 10);
      for (const dateKey of Object.keys(account.baselines ?? {})) {
        if (dateKey < keepFrom) delete account.baselines[dateKey];
      }

      // Catches an account that is on no list at all any more — dropped from a
      // roster, never asked about in chat — and is left holding one stale
      // snapshot once its games age out. A watched account is polled every few
      // minutes, so its snapshot never gets this old.
      const empty =
        Object.keys(account.matches ?? {}).length === 0
        && Object.keys(account.baselines ?? {}).length === 0
        && (account.snapshot?.at ?? 0) < cutoff;

      if (empty) {
        delete this.#state.accounts[puuid];
        this.#db?.dropAccount(puuid);
      }
    }

    this.#db?.dropExpired(cutoff, new Date(cutoff).toISOString().slice(0, 10));
  }
}

export const store = new Store();
