import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './config.js';
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

  recordMatch(puuid, riotId, matchId, { lpDelta, at }) {
    const record = { lpDelta, at: at ?? Date.now() };
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
   * @returns 'added' | 'refreshed' | 'current'
   */
  watch(platform, puuid, riotId, at = Date.now()) {
    this.#state.watch ??= {};

    const key = `${platform}:${puuid}`;
    const existing = this.#state.watch[key];

    if (!existing) {
      const entry = { platform, puuid, riotId, addedAt: at, lastAskedAt: at };
      this.#state.watch[key] = entry;
      this.#db?.putWatch(entry);
      return 'added';
    }

    existing.riotId = riotId;

    if (at - (existing.lastAskedAt ?? 0) < WATCH_REFRESH_MS) return 'current';

    existing.lastAskedAt = at;
    this.#db?.putWatch(existing);
    return 'refreshed';
  }

  /** Every watch-list account, shaped like a roster entry. */
  watchedAccounts() {
    return Object.values(this.#state.watch ?? {});
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
