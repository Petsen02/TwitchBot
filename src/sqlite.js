import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './config.js';

/**
 * SQLite backing for the tracker store.
 *
 * The JSON file this replaces was rewritten in full on every poll round, so
 * its cost grew with the amount of history kept -- which is exactly the thing
 * standing in the way of keeping history at all. SQLite writes only the rows
 * that changed, so the file can hold years without the write cost moving.
 *
 * `node:sqlite` is built into Node and needs no package, so this adds no
 * dependency and nothing to compile on the server. It arrived in Node 22.5
 * though, and the bot may well be running on something older, so everything
 * here is optional: `openDatabase` returns null when the module is missing and
 * the store stays on JSON. Upgrading Node is then the only step needed to
 * switch over, and it happens by itself on the next restart.
 */

const DATA_DIR = join(projectRoot, 'data');
const DB_FILE = join(DATA_DIR, 'tracker.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  puuid   TEXT PRIMARY KEY,
  riot_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  puuid         TEXT PRIMARY KEY,
  tier          TEXT,
  division      TEXT,
  league_points INTEGER,
  absolute      INTEGER,
  taken_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  puuid       TEXT NOT NULL,
  match_id    TEXT NOT NULL,
  lp_delta    INTEGER,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (puuid, match_id)
);

-- Every history query is "this player, this span of time", so the index that
-- matters pairs the two. Without it a season leaderboard scans the table.
CREATE INDEX IF NOT EXISTS matches_by_time ON matches (puuid, recorded_at);

CREATE TABLE IF NOT EXISTS baselines (
  puuid    TEXT NOT NULL,
  date_key TEXT NOT NULL,
  absolute INTEGER NOT NULL,
  taken_at INTEGER,
  PRIMARY KEY (puuid, date_key)
);

CREATE TABLE IF NOT EXISTS watch (
  platform      TEXT NOT NULL,
  puuid         TEXT NOT NULL,
  riot_id       TEXT NOT NULL,
  added_at      INTEGER NOT NULL,
  last_asked_at INTEGER NOT NULL,
  twitch        TEXT,
  PRIMARY KEY (platform, puuid)
);

CREATE TABLE IF NOT EXISTS cutoffs (
  platform TEXT PRIMARY KEY,
  payload  TEXT NOT NULL
);
`;

/** @returns a backend, or null when this Node cannot provide SQLite. */
export function openDatabase() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = process.getBuiltinModule?.('node:sqlite') ?? {});
  } catch {
    return null;
  }
  if (!DatabaseSync) return null;

  mkdirSync(DATA_DIR, { recursive: true });

  const db = new DatabaseSync(DB_FILE);

  // WAL keeps readers out of the writer's way, which matters the day
  // something other than the bot reads this file. The synchronous setting is
  // the usual pairing: a power cut can cost the last moments of LP, and the
  // next poll re-reads the ladder anyway.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);

  // `twitch` arrived after the first databases were created, and CREATE TABLE
  // IF NOT EXISTS leaves those alone. Adding it here costs nothing on a fresh
  // database and brings an existing one up to date without a migration step
  // anybody has to remember to run.
  const watchColumns = db.prepare('PRAGMA table_info(watch)').all();
  if (!watchColumns.some((column) => column.name === 'twitch')) {
    db.exec('ALTER TABLE watch ADD COLUMN twitch TEXT');
  }

  const statements = {
    account: db.prepare('INSERT INTO accounts (puuid, riot_id) VALUES (?, ?) '
      + 'ON CONFLICT(puuid) DO UPDATE SET riot_id = excluded.riot_id'),
    snapshot: db.prepare('INSERT INTO snapshots '
      + '(puuid, tier, division, league_points, absolute, taken_at) VALUES (?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(puuid) DO UPDATE SET tier = excluded.tier, division = excluded.division, '
      + 'league_points = excluded.league_points, absolute = excluded.absolute, '
      + 'taken_at = excluded.taken_at'),
    match: db.prepare('INSERT INTO matches (puuid, match_id, lp_delta, recorded_at) '
      + 'VALUES (?, ?, ?, ?) ON CONFLICT(puuid, match_id) DO UPDATE SET '
      + 'lp_delta = excluded.lp_delta, recorded_at = excluded.recorded_at'),
    baseline: db.prepare('INSERT INTO baselines (puuid, date_key, absolute, taken_at) '
      + 'VALUES (?, ?, ?, ?) ON CONFLICT(puuid, date_key) DO NOTHING'),
    watch: db.prepare('INSERT INTO watch '
      + '(platform, puuid, riot_id, added_at, last_asked_at, twitch) VALUES (?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(platform, puuid) DO UPDATE SET riot_id = excluded.riot_id, '
      + 'last_asked_at = excluded.last_asked_at, twitch = excluded.twitch'),
    cutoff: db.prepare('INSERT INTO cutoffs (platform, payload) VALUES (?, ?) '
      + 'ON CONFLICT(platform) DO UPDATE SET payload = excluded.payload'),
    dropAccount: db.prepare('DELETE FROM accounts WHERE puuid = ?'),
    dropSnapshot: db.prepare('DELETE FROM snapshots WHERE puuid = ?'),
    dropOldMatches: db.prepare('DELETE FROM matches WHERE recorded_at < ?'),
    dropOldBaselines: db.prepare('DELETE FROM baselines WHERE date_key < ?'),
    countRows: db.prepare('SELECT (SELECT COUNT(*) FROM accounts) + '
      + '(SELECT COUNT(*) FROM watch) AS total'),
  };

  // SQLite has no boolean and no null-vs-undefined: everything stored has to
  // be a number, a string or null, so values are normalised on the way in.
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const text = (value) => (typeof value === 'string' ? value : null);

  return {
    path: DB_FILE,

    isEmpty() {
      return (statements.countRows.get()?.total ?? 0) === 0;
    },

    /** Rebuilds the in-memory shape the store has always used. */
    readState() {
      const state = { version: 1, accounts: {}, watch: {}, cutoffs: {} };

      const account = (puuid, riotId) => {
        state.accounts[puuid] ??= { riotId, snapshot: null, matches: {}, baselines: {} };
        if (riotId) state.accounts[puuid].riotId = riotId;
        return state.accounts[puuid];
      };

      for (const row of db.prepare('SELECT * FROM accounts').all()) {
        account(row.puuid, row.riot_id);
      }

      for (const row of db.prepare('SELECT * FROM snapshots').all()) {
        account(row.puuid).snapshot = {
          tier: row.tier,
          rank: row.division,
          leaguePoints: row.league_points,
          absolute: row.absolute,
          at: row.taken_at,
        };
      }

      for (const row of db.prepare('SELECT * FROM matches').all()) {
        account(row.puuid).matches[row.match_id] = {
          lpDelta: row.lp_delta,
          at: row.recorded_at,
        };
      }

      for (const row of db.prepare('SELECT * FROM baselines').all()) {
        account(row.puuid).baselines[row.date_key] = {
          absolute: row.absolute,
          at: row.taken_at,
        };
      }

      for (const row of db.prepare('SELECT * FROM watch').all()) {
        state.watch[`${row.platform}:${row.puuid}`] = {
          platform: row.platform,
          puuid: row.puuid,
          riotId: row.riot_id,
          addedAt: row.added_at,
          lastAskedAt: row.last_asked_at,
          twitch: row.twitch ?? null,
        };
      }

      for (const row of db.prepare('SELECT * FROM cutoffs').all()) {
        try {
          state.cutoffs[row.platform] = JSON.parse(row.payload);
        } catch {
          // A row we cannot parse is worth less than the next reading, which
          // overwrites it within the day.
        }
      }

      return state;
    },

    putAccount(puuid, riotId) {
      statements.account.run(puuid, riotId ?? '');
    },

    putSnapshot(puuid, snapshot) {
      statements.snapshot.run(
        puuid,
        text(snapshot.tier),
        text(snapshot.rank),
        num(snapshot.leaguePoints),
        num(snapshot.absolute),
        num(snapshot.at) ?? Date.now(),
      );
    },

    putMatch(puuid, matchId, record) {
      statements.match.run(puuid, matchId, num(record.lpDelta), num(record.at) ?? Date.now());
    },

    putBaseline(puuid, dateKey, entry) {
      statements.baseline.run(puuid, dateKey, num(entry.absolute) ?? 0, num(entry.at));
    },

    putWatch(entry) {
      statements.watch.run(
        entry.platform,
        entry.puuid,
        entry.riotId,
        num(entry.addedAt) ?? Date.now(),
        num(entry.lastAskedAt) ?? Date.now(),
        text(entry.twitch),
      );
    },

    putCutoff(platform, snapshot) {
      statements.cutoff.run(platform, JSON.stringify(snapshot));
    },

    dropAccount(puuid) {
      statements.dropAccount.run(puuid);
      statements.dropSnapshot.run(puuid);
    },

    dropExpired(cutoffMs, keepFromDateKey) {
      statements.dropOldMatches.run(cutoffMs);
      statements.dropOldBaselines.run(keepFromDateKey);
    },

    /** One transaction, so a crash mid-import cannot leave half a history. */
    importState(state) {
      db.exec('BEGIN');
      try {
        for (const [puuid, account] of Object.entries(state.accounts ?? {})) {
          this.putAccount(puuid, account.riotId);
          if (account.snapshot) this.putSnapshot(puuid, account.snapshot);

          for (const [matchId, record] of Object.entries(account.matches ?? {})) {
            this.putMatch(puuid, matchId, record);
          }

          for (const [dateKey, stored] of Object.entries(account.baselines ?? {})) {
            // Baselines were once a bare number, before the timestamp existed.
            const entry = typeof stored === 'number' ? { absolute: stored, at: null } : stored;
            if (entry) this.putBaseline(puuid, dateKey, entry);
          }
        }

        for (const entry of Object.values(state.watch ?? {})) this.putWatch(entry);

        for (const [platform, snapshot] of Object.entries(state.cutoffs ?? {})) {
          if (snapshot && typeof snapshot === 'object') this.putCutoff(platform, snapshot);
        }

        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
