import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './config.js';

/**
 * Durable state for LP tracking.
 *
 * Riot exposes no LP history, so every LP figure this bot reports is measured
 * by us: we snapshot each tracked player's ladder position, and when a new
 * ranked match appears we attribute the change to that match. Losing this file
 * means losing LP history, so writes are atomic (write temp, then rename).
 *
 * The data stays tiny — one snapshot per player plus a couple of dozen matches
 * per day — so a JSON file beats a database here, and avoids a native
 * dependency that would have to compile on the server.
 */

const DATA_DIR = join(projectRoot, 'data');
const DATA_FILE = join(DATA_DIR, 'tracker.json');
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

function emptyState() {
  return { version: 1, accounts: {} };
}

export class Store {
  #state;

  constructor() {
    this.#state = this.#load();
  }

  #load() {
    try {
      const parsed = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.accounts) return parsed;
      return emptyState();
    } catch {
      return emptyState();
    }
  }

  save() {
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
    return account;
  }

  getSnapshot(puuid) {
    return this.#state.accounts[puuid]?.snapshot ?? null;
  }

  setSnapshot(puuid, riotId, snapshot) {
    this.#account(puuid, riotId).snapshot = snapshot;
  }

  /** LP delta recorded for a specific match, or null if we never measured it. */
  getMatchDelta(puuid, matchId) {
    return this.#state.accounts[puuid]?.matches?.[matchId]?.lpDelta ?? null;
  }

  hasMatch(puuid, matchId) {
    return Boolean(this.#state.accounts[puuid]?.matches?.[matchId]);
  }

  recordMatch(puuid, riotId, matchId, { lpDelta, at }) {
    this.#account(puuid, riotId).matches[matchId] = { lpDelta, at: at ?? Date.now() };
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

  /** Drops old matches and baselines so the file cannot grow without bound. */
  prune(now = Date.now()) {
    const cutoff = now - RETENTION_MS;

    for (const account of Object.values(this.#state.accounts)) {
      for (const [matchId, record] of Object.entries(account.matches ?? {})) {
        if ((record.at ?? 0) < cutoff) delete account.matches[matchId];
      }

      const keepFrom = new Date(cutoff).toISOString().slice(0, 10);
      for (const dateKey of Object.keys(account.baselines ?? {})) {
        if (dateKey < keepFrom) delete account.baselines[dateKey];
      }
    }
  }
}

export const store = new Store();
