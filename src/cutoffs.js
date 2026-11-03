import { config } from './config.js';
import { store } from './store.js';
import { channels } from './channels.js';
import { getCutoffs } from './riot.js';
import { startOfDay } from './time.js';

/**
 * Scheduled cutoff snapshots, one per region.
 *
 * Cutoffs drift continuously as the ladder shifts, so a rolling cache would
 * mean every viewer sees a slightly different number at a slightly different
 * age. Instead the value is refreshed on fixed clock boundaries and stamped
 * with its time, which gives chat one shared, quotable figure and an honest
 * answer to "how old is this".
 *
 * Snapshots are persisted, so a restart neither resets the schedule nor loses
 * the last known value.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Epoch ms of the next fixed boundary at or after `from`.
 *
 * Intervals shorter than a day align to the UTC clock, which lands on the hour
 * and half hour everywhere that matters. A daily interval instead aligns to
 * local midnight: aligning it to UTC would fire at 01:00 or 02:00 Danish time
 * depending on daylight saving, which is not what "updates at 00:00" means.
 */
export function nextBoundary(from = Date.now(), intervalMs = config.cutoffRefreshMs) {
  if (intervalMs < DAY_MS) return Math.ceil((from + 1) / intervalMs) * intervalMs;

  // Adding a full day always lands on the next calendar date — daylight saving
  // shifts an hour at most — so its local midnight is the next one.
  return startOfDay(config.timezone, new Date(from + DAY_MS));
}

async function refresh(platform) {
  const { challengerCutoff, grandmasterCutoff, challengerSlots } = await getCutoffs(platform);
  const now = Date.now();

  const snapshot = {
    challengerCutoff,
    grandmasterCutoff,
    challengerSlots,
    updatedAt: now,
    nextUpdateAt: nextBoundary(now),
  };

  store.setCutoffSnapshot(platform, snapshot);
  store.save();

  console.log(`[cutoffs] ${platform}: challenger ${challengerCutoff}LP, grandmaster ${grandmasterCutoff}LP`);

  return snapshot;
}

/**
 * The latest snapshot for a region, refreshing on demand only when none exists
 * or the scheduled time has passed.
 */
export async function getSnapshot(platform) {
  const stored = store.getCutoffSnapshot(platform);

  if (stored && Date.now() < stored.nextUpdateAt) return stored;

  try {
    return await refresh(platform);
  } catch (error) {
    console.error(`[cutoffs] ${platform} fejlede:`, error.message);
    // A stale figure with an honest timestamp beats no answer at all.
    return stored ?? null;
  }
}

/** Every region any channel is configured for. */
function activePlatforms() {
  const platforms = new Set();
  for (const name of channels.names()) platforms.add(channels.get(name).platform);
  if (platforms.size === 0) platforms.add(config.defaultPlatform);
  return [...platforms];
}

export function startCutoffSchedule() {
  console.log(`[cutoffs] opdaterer hver ${config.cutoffRefreshMs / 60_000} min, på klokkeslæt`);

  const tick = async () => {
    // Regions are re-read each tick, so a channel switching region starts
    // being refreshed without a restart.
    for (const platform of activePlatforms()) {
      await getSnapshot(platform).catch((error) =>
        console.error(`[cutoffs] ${platform}:`, error.message),
      );
    }

    // Re-arm against the wall clock each time rather than repeating a fixed
    // interval, so the schedule cannot drift.
    const timer = setTimeout(tick, Math.max(1000, nextBoundary() - Date.now()));
    timer.unref?.();
  };

  tick().catch((error) => console.error('[cutoffs] start fejlede:', error.message));
}
