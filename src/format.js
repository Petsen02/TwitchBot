import { config } from './config.js';
import { formatRank, formatTier, formatLpDelta } from './ladder.js';
import { formatDuration, formatClock, formatDate } from './time.js';

/** The reference bot separates fields with a spaced box-drawing bar. */
export const SEP = ' │ ';

const POSITION_LABELS = {
  TOP: 'Top',
  JUNGLE: 'Jgl',
  MIDDLE: 'Mid',
  BOTTOM: 'Bot',
  UTILITY: 'Sup',
};

const MULTI_KILL_LABELS = {
  2: 'DOUBLE KILL',
  3: 'TRIPLE KILL',
  4: 'QUADRA KILL',
  5: 'PENTA KILL',
};

function oneDecimal(value) {
  return (Math.round(value * 10) / 10).toFixed(1);
}

/** "humzh CHALLENGER 2138LP (Rank#167)" */
export function formatPlayerRank({ name, entry, ladderPosition }) {
  const rank = formatRank(entry, config.rankStyle);
  const suffix = ladderPosition ? ` (Rank#${ladderPosition})` : '';
  return `${name} ${rank}${suffix}`;
}

/** Numbered, highest rank first, joined by the separator bar. */
export function formatRanksMessage(players) {
  return players.map((player, index) => `${index + 1}. ${formatPlayerRank(player)}`).join(SEP);
}

/**
 * "RASMUS: 3W 2L - (+24 LP) 🟩🟩🟥🟩🟥"
 *
 * Squares run oldest to newest. The LP field is the point of the line, so it
 * is never left out: a signed figure is the day's net gain as measured by the
 * tracker, and a bare figure is the player's current LP, shown when no game
 * today was measured. The sign is what tells the two apart, so an unmeasured
 * day never reads as a misleading +0.
 *
 * The current-LP fallback deliberately carries no tier name. In emote style a
 * tier has to stand alone between spaces for 7TV to swap in the image, and
 * "(EMERALD" would never match.
 */
export function formatGains({ name, results, lpTotal, measuredCount, entry }) {
  if (results.length === 0) return `${name} har ikke spillet ranked i dag`;

  const wins = results.filter(Boolean).length;
  const losses = results.length - wins;
  const squares = results.map((win) => (win ? '🟩' : '🟥')).join('');

  // The net total covers only measured games. Games played before tracking
  // began are counted in the W/L and the squares, but not in the LP.
  const lp = measuredCount > 0
    ? formatLpDelta(lpTotal)
    : (entry ? `${entry.leaguePoints ?? 0} LP` : null);

  const head = lp
    ? `${name}: ${wins}W ${losses}L - (${lp})`
    : `${name}: ${wins}W ${losses}L`;

  return `${head} ${squares}`;
}

/**
 * Full stat line for the most recent game, mirroring the reference bot:
 * "Name#TAG game results: 🏆 Win │ Graves Jgl │ 8/0/3 │ +30 LP │ 52% KP │ ..."
 *
 * The stat labels stay as the reference bot has them — they are the units
 * League players read, not prose to translate.
 */
export function formatLastGame({ riotId, stats, lpDelta }) {
  const minutes = stats.durationSeconds / 60;
  const perMinute = (value) => (minutes > 0 ? value / minutes : 0);

  const fields = [
    stats.win ? '🏆 Win' : '❌ Loss',
    [stats.champion, POSITION_LABELS[stats.position]].filter(Boolean).join(' '),
    `${stats.kills}/${stats.deaths}/${stats.assists}`,
  ];

  const lp = formatLpDelta(lpDelta);
  if (lp) fields.push(lp);

  if (stats.killParticipation !== null) {
    fields.push(`${Math.round(stats.killParticipation * 100)}% KP`);
  }

  fields.push(
    `${oneDecimal(stats.damageToChampions / 1000)}k dmg`,
    formatDuration(stats.durationSeconds),
    `${oneDecimal(perMinute(stats.creepScore))} cs/min`,
    `${Math.round(perMinute(stats.gold))} gold/min`,
    `${Math.round(perMinute(stats.damageToChampions))} dmg/min`,
    `${Math.round(perMinute(stats.selfMitigated))} self-mitigated/min`,
    `${oneDecimal(perMinute(stats.timeCCingOthers))}s CC/min`,
    `${oneDecimal(perMinute(stats.visionScore))} vision/min`,
  );

  const multiKill = MULTI_KILL_LABELS[stats.largestMultiKill];
  if (multiKill) fields.push(`⚡ ${multiKill}`);

  return `${riotId} game results: ${fields.join(SEP)}`;
}

/**
 * In emote style a tier name must stand alone between spaces for 7TV to swap
 * in the image, so it never takes a trailing colon.
 */
function tierLabel(tier) {
  return config.rankStyle === 'emotes'
    ? `${tier} `
    : `${tier.charAt(0)}${tier.slice(1).toLowerCase()}: `;
}

/**
 * "EUW1 CHALLENGER 2418LP │ GRANDMASTER 1808LP │ opdateret 3/11/26 kl 00:00 │
 *  næste update 4/11/26 kl 00:00"
 *
 * The timestamps are half the point: a cutoff without an age is a number
 * nobody can judge. The region comes from the channel, so one command answers
 * correctly wherever it is used.
 */
export function formatCutoffs({
  platform,
  challengerCutoff,
  grandmasterCutoff,
  updatedAt,
  nextUpdateAt,
  timezone,
}) {
  const fields = [];

  if (challengerCutoff !== null) fields.push(`${tierLabel('CHALLENGER')}${challengerCutoff}LP`);
  if (grandmasterCutoff !== null) fields.push(`${tierLabel('GRANDMASTER')}${grandmasterCutoff}LP`);

  // The cutoff refreshes daily, so the date carries more than the clock does —
  // but the clock still matters after a cold start, when it is not midnight.
  const stamp = (at) => `${formatDate(at, timezone)} kl ${formatClock(at, timezone)}`;

  if (updatedAt) fields.push(`opdateret ${stamp(updatedAt)}`);
  if (nextUpdateAt) fields.push(`næste update ${stamp(nextUpdateAt)}`);

  return `${platform} ${fields.join(SEP)}`;
}

/**
 * "Petsen SILVER II: 40LP │ mangler 8 wins til GOLD IV"
 *
 * Below Master the answer is a number of wins, because the LP distance to a
 * fixed threshold is not something a player acts on. At Master and above there
 * is no fixed threshold — the target is a moving cutoff — so the LP gap is the
 * meaningful figure and is shown alongside.
 *
 * The win count uses the player's own measured gains where we have them, and
 * falls back to a default until a win has been measured.
 */
export function formatNextRank({ name, entry, targetEntry, targetLabel, lpNeeded, lpPerWin }) {
  const current = `${name} ${formatRank(entry, config.rankStyle)}`;
  const wins = Math.ceil(lpNeeded / lpPerWin);
  const plural = `${wins} ${wins === 1 ? 'win' : 'wins'}`;

  if (targetEntry) {
    // A threshold carries no LP of its own, so the target is named bare.
    return [current, `mangler ${plural} til ${formatTier(targetEntry, config.rankStyle)}`].join(SEP);
  }

  return [current, `mangler ${lpNeeded} LP til ${targetLabel}`, plural].join(SEP);
}

/** "Avg rank: EMERALD II: 35LP │ Pros: Caps (Azir)" */
export function formatGame({ name, averageEntry, rankedCount, pros }) {
  const fields = [`Gns. rank: ${formatRank(averageEntry, config.rankStyle)}`];

  if (rankedCount < 10) fields.push(`${rankedCount}/10 ranked`);

  if (pros.length > 0) {
    fields.push(`Pros: ${pros.map((pro) => `${pro.name} (${pro.champion})`).join(', ')}`);
  }

  return `${name}s kamp${SEP}${fields.join(SEP)}`;
}

/** The channel's roster, as shown by !oldplayerlist. */
export function formatPlayerList({ players, main }) {
  if (players.length === 0) {
    return 'Ingen spillere tilføjet endnu — brug !oldaddplayer Navn#TAG';
  }

  const names = players.map((player) => {
    const isMain = main && player.riotId.toLowerCase() === main.toLowerCase();
    return isMain ? `${player.riotId} (main)` : player.riotId;
  });

  return `${players.length} spiller${players.length === 1 ? '' : 'e'}: ${names.join(', ')}`;
}
