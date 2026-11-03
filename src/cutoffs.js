import { config } from './config.js';
import { store } from './store.js';
import { channels } from './channels.js';
import { getCutoffs } from './riot.js';

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

/** Epoch ms of the next fixed boundary at or after `from`. */
export function nextBoundary(from = Date.now(), intervalMs = config.cutoffRefreshMs) {
  return Math.ceil((from + 1) / intervalMs) * intervalMs;
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
