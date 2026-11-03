import { config } from './config.js';
import { formatRank, formatLpDelta } from './ladder.js';
import { formatDuration, formatClock } from './time.js';

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
 * "3W 2L (+24 LP) 🟩🟩🟥🟩🟥"
 *
 * Squares run oldest to newest. The LP total is omitted entirely when none of
 * today's games were measured, rather than claiming a misleading 0.
 */
export function formatGains({ name, results, lpTotal, measuredCount }) {
  if (results.length === 0) return `${name} har ikke spillet ranked i dag`;

  const wins = results.filter(Boolean).length;
  const losses = results.length - wins;
  const squares = results.map((win) => (win ? '🟩' : '🟥')).join('');

  const parts = [`${name}:`, `${wins}W ${losses}L`];

  if (measuredCount > 0) {
    // Flag when some games predate tracking, so a small total is not mistaken
    // for a flat day.
    const partial = measuredCount < results.length ? `, ${measuredCount}/${results.length} målt` : '';
    parts.push(`(${formatLpDelta(lpTotal)}${partial})`);
  }

  return `${parts.join(' ')} ${squares}`;
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
 * "EUW1 CHALLENGER 2418LP │ GRANDMASTER 1808LP │ opdateret kl 10:00 │ næste update er kl 11:00"
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

  if (updatedAt) fields.push(`opdateret kl ${formatClock(updatedAt, timezone)}`);
  if (nextUpdateAt) fields.push(`næste update er kl ${formatClock(nextUpdateAt, timezone)}`);

  return `${platform} ${fields.join(SEP)}`;
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
