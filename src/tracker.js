import { config } from './config.js';
import { store } from './store.js';
import { channels } from './channels.js';
import { getLeagueEntries, getMatch, getMatchIds, pickQueue, SOLO_QUEUE } from './riot.js';
import { toAbsolute } from './ladder.js';
import { localDateKey } from './time.js';
import { writePlayerReport } from './report.js';

/**
 * Background LP measurement.
 *
 * The Riot API has no concept of "this game was worth +30 LP", so the only way
 * to report it is to watch each tracked player's ladder position and attribute
 * every change to the ranked match that caused it.
 *
 * Polling is adaptive. Most tracked accounts are idle most of the day, and
 * polling all of them every minute is what would put a multi-channel bot over
 * a personal key's 100-requests-per-two-minutes ceiling. Idle accounts are
 * therefore checked rarely and only move to the fast interval once they are
 * actually playing. This is safe because the measurement only needs at most
 * one ranked game to fall between two readings, and a League game lasts far
 * longer than the idle interval.
 */

// How far back to look for matches when we have no previous snapshot to anchor
// against — long enough to cover a restart, short enough to stay cheap.
const COLD_START_LOOKBACK_MS = 6 * 60 * 60 * 1000;

/**
 * How old a snapshot may be and still be subtracted from.
 *
 * A snapshot is rewritten on every poll, so a healthy one is never older than
 * the idle interval. Anything much older means we stopped watching this
 * account for a while — it fell off the watch list, or the bot was down — and
 * the difference then spans days rather than one game. Attributing that to the
 * newest match would invent a figure, so the gap is recorded without one.
 */
function snapshotMaxAgeMs() {
  return 3 * config.idlePollMs;
}

const lastPolledAt = new Map();

function isActive(puuid, now) {
  const snapshot = store.getSnapshot(puuid);
  const lastMatch = store.getLastMatchAt(puuid);

  // Freshly added accounts count as active so their first reading is prompt.
  if (!snapshot) return true;

  return lastMatch !== null && now - lastMatch < config.activeWindowMs;
}

function isDue(account, now) {
  const key = `${account.platform}:${account.puuid}`;
  const last = lastPolledAt.get(key) ?? 0;
  const interval = isActive(account.puuid, now) ? config.activePollMs : config.idlePollMs;
  return now - last >= interval;
}

async function pollAccount(account) {
  const { platform, puuid, riotId } = account;

  const entries = await getLeagueEntries(platform, puuid, { fresh: true });
  const solo = pickQueue(entries, SOLO_QUEUE);

  // Unranked players have nothing to measure; revisit on the next poll.
  if (!solo) return;

  const absolute = toAbsolute(solo);
  if (absolute === null) return;

  const now = Date.now();
  const previous = store.getSnapshot(puuid);

  // Anchor the day's net figure the first time we see this player today.
  const dayKey = localDateKey(config.timezone, new Date(now), config.dayStartHour);
  store.setBaselineIfMissing(puuid, riotId, dayKey, absolute, now);

  const since = previous?.at ?? now - COLD_START_LOOKBACK_MS;
  const matchIds = await getMatchIds(platform, puuid, {
    startTime: Math.floor(since / 1000),
    count: 10,
  });

  // getMatchIds returns newest first; walk oldest first so recording order
  // matches the order the games were actually played.
  const fresh = matchIds.filter((id) => !store.hasMatch(puuid, id)).reverse();

  const measurable = previous !== null && now - previous.at <= snapshotMaxAgeMs();
  const moved = measurable ? absolute - previous.absolute : null;

  if (fresh.length > 0) {
    // A ranked game always moves the ladder, so a difference of zero means
    // Riot had not updated it yet when we looked -- not that the game was
    // worth nothing. Recording the zero would leave "+0 LP" standing for
    // good, so the match is left unmeasured and picked up below once the
    // movement appears.
    const delta = moved === 0 ? null : moved;

    for (const [index, matchId] of fresh.entries()) {
      const isNewest = index === fresh.length - 1;

      // One request per new match buys the result. It is worth it: a finished
      // game never changes, so this is asked once and answered from our own
      // store for ever after -- an overlay refreshing every few seconds
      // cannot go to Riot for it.
      let win = null;
      try {
        const match = await getMatch(platform, matchId);
        win = match.info.participants.find((p) => p.puuid === puuid)?.win ?? null;
      } catch (error) {
        console.error(`[tracker] ${riotId} ${matchId}: ${error.message}`);
      }

      // With one new match the whole change belongs to it. With several we
      // cannot split the change honestly, so only the newest carries a figure
      // and the rest are recorded without one rather than with a guess.
      store.recordMatch(puuid, riotId, matchId, {
        lpDelta: isNewest ? delta : null,
        at: now,
        win,
      });
    }
  } else if (moved) {
    // The ladder moved with no new game to explain it. That is the lag
    // catching up: the change belongs to the last game we saw too early.
    store.attributePending(puuid, moved, { now, maxAgeMs: snapshotMaxAgeMs() });
  }

  store.setSnapshot(puuid, riotId, {
    tier: solo.tier,
    rank: solo.rank,
    leaguePoints: solo.leaguePoints,
    absolute,
    at: now,
  });
}

/**
 * Everything the tracker should poll: the channels' curated rosters plus the
 * bot's own watch list, deduplicated.
 *
 * Roster entries win on a collision. They carry the channel list and never
 * expire, so a player a streamer added is not downgraded to a temporary watch
 * entry just because somebody also asked about them in chat.
 */
function pollTargets() {
  const seen = new Map();

  for (const account of channels.trackedAccounts()) {
    seen.set(`${account.platform}:${account.puuid}`, account);
  }

  for (const entry of store.watchedAccounts()) {
    const key = `${entry.platform}:${entry.puuid}`;
    if (!seen.has(key)) seen.set(key, entry);
  }

  return [...seen.values()];
}

async function pollDue() {
  const now = Date.now();
  const accounts = pollTargets();
  const due = accounts.filter((account) => isDue(account, now));

  for (const account of due) {
    lastPolledAt.set(`${account.platform}:${account.puuid}`, Date.now());

    try {
      await pollAccount(account);
    } catch (error) {
      console.error(`[tracker] ${account.riotId}: ${error.message}`);
    }
  }

  if (due.length > 0) {
    store.prune();
    store.save();
    writePlayerReport();
  }

  return { polled: due.length, total: accounts.length };
}

export function startTracker() {
  console.log(
    `[tracker] aktive konti hver ${config.activePollMs / 1000}s, inaktive hver ${config.idlePollMs / 1000}s`,
  );

  const tick = () => {
    pollDue().catch((error) => console.error('[tracker] poll fejlede:', error.message));
  };

  // Write the roll once up front, so the file is there to read even on a bot
  // that has just started and has nothing due yet.
  writePlayerReport();

  tick();

  // The scheduler wakes often; which accounts are actually due is decided per
  // account, not per tick.
  const timer = setInterval(tick, Math.min(config.activePollMs, 30_000));
  timer.unref?.();
  return timer;
}

export { pollDue };
