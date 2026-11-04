import { config, parseRiotId, PLATFORMS } from './config.js';
import { channels, normalizeChannel } from './channels.js';
import { store } from './store.js';
import { TtlCache } from './cache.js';
import {
  getAccount,
  getLeagueEntries,
  getLadderPosition,
  getActiveGame,
  getMatchIds,
  getMatch,
  pickQueue,
  SOLO_QUEUE,
} from './riot.js';
import { toAbsolute, fromAbsolute, isApex, nextTierEntry, formatRank } from './ladder.js';
import { lookupPros } from './lolpros.js';
import { championName } from './champions.js';
import { startOfDay, localDateKey } from './time.js';
import { getSnapshot } from './cutoffs.js';
import {
  formatPlayerRank,
  formatNextRank,
  formatRanksMessage,
  formatGains,
  formatLastGame,
  formatGame,
  formatCutoffs,
  formatPlayerList,
} from './format.js';

/**
 * Extracted match stats, keyed by match and player.
 *
 * A finished match never changes, so this never expires — but only the dozen
 * fields the chat lines need are kept, not the full payload. That keeps memory
 * flat on a bot that runs for months.
 */
const statsCache = new TtlCache(Infinity, 500);

/** Twitch drops anything past 500 characters, so long lists are trimmed. */
const MAX_MESSAGE = 480;

export function truncate(message) {
  return message.length <= MAX_MESSAGE ? message : `${message.slice(0, MAX_MESSAGE - 1)}…`;
}

/** An argument the user typed wins; otherwise fall back to the channel's main. */
function resolveTarget(channel, argument) {
  if (!argument) return channels.mainAccount(channel);
  return parseRiotId(argument);
}

async function describePlayer(platform, riotId) {
  const account = await getAccount(platform, riotId);
  const entries = await getLeagueEntries(platform, account.puuid);
  const entry = pickQueue(entries, SOLO_QUEUE);

  // Only apex players can be near the top, so nobody else is worth looking up.
  const rawPosition = entry && isApex(entry.tier)
    ? await getLadderPosition(platform, account.puuid).catch(() => null)
    : null;

  const ladderPosition =
    rawPosition !== null && rawPosition <= config.ladderPositionLimit ? rawPosition : null;

  return {
    name: account.gameName,
    riotId: `${account.gameName}#${account.tagLine}`,
    puuid: account.puuid,
    entry,
    ladderPosition,
    absolute: entry ? toAbsolute(entry) : null,
  };
}

export async function commandRank({ channel, argument }) {
  const target = resolveTarget(channel, argument);
  if (!target) return 'Ingen main sat — brug !rank Navn#TAG eller !oldaddmain Navn#TAG';

  const { platform } = channels.get(channel);
  return formatPlayerRank(await describePlayer(platform, target));
}

export async function commandRanks({ channel }) {
  const { platform, players } = channels.get(channel);

  if (players.length === 0) {
    return 'Ingen spillere tilføjet endnu — brug !oldaddplayer Navn#TAG';
  }

  const described = await Promise.all(
    players.map((player) =>
      describePlayer(platform, parseRiotId(player.riotId)).catch(() => null),
    ),
  );

  const found = described.filter(Boolean);
  if (found.length === 0) return 'Kunne ikke slå kanalens spillere op lige nu';

  // Unranked players sort to the bottom rather than disappearing.
  found.sort((a, b) => (b.absolute ?? -1) - (a.absolute ?? -1));

  return formatRanksMessage(found);
}

/** Cached, slim view of one player's performance in one match. */
function getMatchStats(platform, matchId, puuid) {
  return statsCache.wrap(`${matchId}:${puuid}`, async () =>
    extractStats(await getMatch(platform, matchId), puuid),
  );
}

export async function commandGains({ channel, argument }) {
  const target = resolveTarget(channel, argument);
  if (!target) return 'Ingen main sat — brug !gains Navn#TAG';

  const { platform } = channels.get(channel);
  const account = await getAccount(platform, target);

  const since = startOfDay(config.timezone);
  const matchIds = (await getMatchIds(platform, account.puuid, {
    startTime: Math.floor(since / 1000),
    count: 20,
  })).reverse(); // Oldest first, so result squares read in playing order.

  if (matchIds.length === 0) return `${account.gameName} har ikke spillet ranked i dag`;

  const stats = await Promise.all(matchIds.map((id) => getMatchStats(platform, id, account.puuid)));

  const results = [];
  let lpTotal = 0;
  let measuredCount = 0;

  matchIds.forEach((matchId, index) => {
    if (!stats[index]) return;

    results.push(stats[index].win);

    const delta = store.getMatchDelta(account.puuid, matchId);
    if (delta !== null) {
      lpTotal += delta;
      measuredCount += 1;
    }
  });

  // A baseline compares start-of-day to now, which stays correct even when
  // individual games were missed — but only if it was captured before the
  // day's first game. A baseline taken mid-session would silently erase every
  // game that came before it.
  const baseline = store.getBaseline(account.puuid, localDateKey(config.timezone));
  const snapshot = store.getSnapshot(account.puuid);
  const firstGameStart = stats.find(Boolean)?.gameStart ?? null;

  const baselineCoversDay =
    baseline?.at !== null
    && baseline?.at !== undefined
    && (firstGameStart === null || baseline.at <= firstGameStart);

  if (baseline && snapshot && baselineCoversDay) {
    lpTotal = snapshot.absolute - baseline.absolute;
    measuredCount = results.length;
  }

  return formatGains({ name: account.gameName, results, lpTotal, measuredCount });
}

/** Pulls the fields the stat line needs out of a match-v5 payload. */
function extractStats(match, puuid) {
  const participant = match.info.participants.find((p) => p.puuid === puuid);
  if (!participant) return null;

  const teamKills = match.info.participants
    .filter((p) => p.teamId === participant.teamId)
    .reduce((total, p) => total + p.kills, 0);

  // gameDuration switched from milliseconds to seconds in patch 11.20; the
  // presence of gameEndTimestamp is Riot's documented way to tell them apart.
  const durationSeconds = match.info.gameEndTimestamp
    ? match.info.gameDuration
    : Math.round(match.info.gameDuration / 1000);

  return {
    win: participant.win,
    champion: participant.championName,
    position: participant.teamPosition || participant.individualPosition,
    kills: participant.kills,
    deaths: participant.deaths,
    assists: participant.assists,
    killParticipation: teamKills > 0 ? (participant.kills + participant.assists) / teamKills : null,
    damageToChampions: participant.totalDamageDealtToChampions,
    creepScore: participant.totalMinionsKilled + participant.neutralMinionsKilled,
    gold: participant.goldEarned,
    selfMitigated: participant.damageSelfMitigated,
    timeCCingOthers: participant.timeCCingOthers,
    visionScore: participant.visionScore,
    largestMultiKill: participant.largestMultiKill,
    durationSeconds,
    gameStart: match.info.gameStartTimestamp ?? null,
  };
}

export async function commandLastGame({ channel, argument }) {
  const target = resolveTarget(channel, argument);
  if (!target) return 'Ingen main sat — brug !lastgame Navn#TAG';

  const { platform } = channels.get(channel);
  const account = await getAccount(platform, target);
  const [matchId] = await getMatchIds(platform, account.puuid, { count: 1 });

  if (!matchId) return `${account.gameName} har ingen nylige ranked kampe`;

  const stats = await getMatchStats(platform, matchId, account.puuid);
  if (!stats) return 'Kunne ikke læse den kamp';

  return formatLastGame({
    riotId: `${account.gameName}#${account.tagLine}`,
    stats,
    lpDelta: store.getMatchDelta(account.puuid, matchId),
  });
}

export async function commandGame({ channel, argument }) {
  const target = resolveTarget(channel, argument);
  if (!target) return 'Ingen main sat — brug !lobby Navn#TAG';

  const { platform } = channels.get(channel);
  const account = await getAccount(platform, target);
  const game = await getActiveGame(platform, account.puuid);

  if (!game) return `${account.gameName} er ikke i en kamp lige nu`;

  const participants = game.participants.filter((p) => !p.bot);

  const ranks = await Promise.all(
    participants.map(async (p) => {
      try {
        const entries = await getLeagueEntries(platform, p.puuid);
        return toAbsolute(pickQueue(entries, SOLO_QUEUE) ?? {});
      } catch {
        return null;
      }
    }),
  );

  const ranked = ranks.filter((value) => value !== null && value !== undefined);
  const average = ranked.length > 0
    ? ranked.reduce((sum, value) => sum + value, 0) / ranked.length
    : null;

  const prosByRiotId = await lookupPros(
    participants.map((p) => parseRiotId(p.riotId)).filter(Boolean),
  ).catch(() => new Map());

  const pros = [];
  for (const participant of participants) {
    const pro = prosByRiotId.get((participant.riotId ?? '').toLowerCase());
    if (!pro) continue;

    pros.push({ name: pro.name, champion: await championName(participant.championId) });
  }

  return formatGame({
    name: account.gameName,
    averageEntry: average === null ? null : fromAbsolute(average),
    rankedCount: ranked.length,
    pros,
  });
}

/**
 * Current promotion thresholds for the channel's region.
 *
 * !chal and !cutoff are the same command: both answer with Challenger and
 * Grandmaster together, because knowing one without the other rarely helps.
 */
export async function commandCutoff({ channel }) {
  const { platform } = channels.get(channel);
  const snapshot = await getSnapshot(platform);

  if (!snapshot || (snapshot.challengerCutoff === null && snapshot.grandmasterCutoff === null)) {
    return 'Kunne ikke læse ladderen lige nu';
  }

  return formatCutoffs({
    platform: platform.toUpperCase(),
    challengerCutoff: snapshot.challengerCutoff,
    grandmasterCutoff: snapshot.grandmasterCutoff,
    updatedAt: snapshot.updatedAt,
    nextUpdateAt: snapshot.nextUpdateAt,
    timezone: config.timezone,
  });
}

// ---------------------------------------------------------------------------
// Roster management. Every addition is checked against Riot first, so "ikke
// fundet" means the account genuinely does not exist rather than a typo that
// silently joined the list.
// ---------------------------------------------------------------------------

/**
 * Riot accounts are global, so looking one up succeeds from any region. Rank
 * data is not: a EUW player added to a NA channel resolves fine and then shows
 * as Unranked forever, with nothing to suggest the region is the cause. The
 * add still goes through — plenty of players are genuinely unranked — but it
 * says so.
 */
async function verifyAccount(platform, target) {
  const account = await getAccount(platform, target);
  const entries = await getLeagueEntries(platform, account.puuid).catch(() => []);
  return { account, hasRankedData: entries.length > 0 };
}

export async function commandAddPlayer({ channel, argument }) {
  const target = parseRiotId(argument);
  if (!target) return 'Brug: !oldaddplayer Navn#TAG';

  const { platform } = channels.get(channel);

  let verified;
  try {
    verified = await verifyAccount(platform, target);
  } catch (error) {
    if (error.kind === 'not_found') return `Fandt ikke ${target.riotId}`;
    throw error;
  }

  const { account, hasRankedData } = verified;
  const riotId = `${account.gameName}#${account.tagLine}`;

  if (channels.addPlayer(channel, account) === 'duplicate') {
    return `${riotId} står allerede på listen`;
  }

  return hasRankedData
    ? `${riotId} er tilføjet til listen`
    : `${riotId} er tilføjet, men har ingen ranked data på ${platform} — tjek at regionen er rigtig med !oldregion`;
}

export async function commandRemovePlayer({ channel, argument }) {
  const target = parseRiotId(argument);
  if (!target) return 'Brug: !oldremoveplayer Navn#TAG';

  const result = channels.removePlayer(channel, target.riotId);

  return result === 'removed'
    ? `${target.riotId} er fjernet fra listen`
    : `${target.riotId} står ikke på listen`;
}

export async function commandPlayerList({ channel }) {
  const { players, main } = channels.get(channel);
  return formatPlayerList({ players, main });
}

export async function commandAddMain({ channel, argument }) {
  const target = parseRiotId(argument);
  if (!target) return 'Brug: !oldaddmain Navn#TAG';

  const { platform } = channels.get(channel);

  let account;
  try {
    ({ account } = await verifyAccount(platform, target));
  } catch (error) {
    if (error.kind === 'not_found') return `Fandt ikke ${target.riotId}`;
    throw error;
  }

  const riotId = `${account.gameName}#${account.tagLine}`;

  // A main that is not on the roster would never be polled, so !gains would
  // silently have no LP for it. Add it rather than leaving a half-set state.
  const added = channels.addPlayer(channel, account) === 'added';
  channels.setMain(channel, riotId);

  return added
    ? `${riotId} er sat som main og tilføjet til listen`
    : `${riotId} er sat som main`;
}

export async function commandRemoveMain({ channel, argument }) {
  const target = parseRiotId(argument);
  if (!target) return 'Brug: !oldremovemain Navn#TAG';

  const result = channels.clearMain(channel, target.riotId);

  return result === 'removed'
    ? `${target.riotId} er ikke længere main`
    : `${target.riotId} er ikke sat som main`;
}

// Used only when a player has no measured wins of their own yet.
const ASSUMED_LP_PER_WIN = 20;

/**
 * How far to the next full tier, in LP and in wins.
 *
 * Below Master the target is a fixed threshold — the entry of the next tier.
 * At Master and Grandmaster there is no fixed threshold at all: promotion is
 * decided by a moving cutoff, so the current one is used instead.
 */
export async function commandNextRank({ channel, argument }) {
  const target = resolveTarget(channel, argument);
  if (!target) return 'Ingen main sat — brug !nextrank Navn#TAG';

  const { platform } = channels.get(channel);
  const player = await describePlayer(platform, target);

  if (!player.entry) return `${player.name} er unranked — ingen rank at regne fra`;

  let goalAbsolute;
  let targetEntry = null;
  let targetLabel = null;

  const nextTier = nextTierEntry(player.entry.tier);

  if (nextTier) {
    targetEntry = nextTier;
    goalAbsolute = toAbsolute(nextTier);
  } else {
    if (player.entry.tier === 'CHALLENGER') {
      return `${player.name} ${formatRank(player.entry, config.rankStyle)} — der er ikke noget over`;
    }

    const snapshot = await getSnapshot(platform);
    const cutoff = player.entry.tier === 'MASTER'
      ? snapshot?.grandmasterCutoff
      : snapshot?.challengerCutoff;

    if (cutoff === null || cutoff === undefined) {
      return 'Kunne ikke læse ladderen lige nu';
    }

    targetLabel = player.entry.tier === 'MASTER' ? 'GRANDMASTER' : 'CHALLENGER';
    goalAbsolute = toAbsolute({ tier: targetLabel, rank: 'I', leaguePoints: cutoff });
  }

  const lpNeeded = Math.max(0, Math.round(goalAbsolute - player.absolute));
  if (lpNeeded === 0) return `${player.name} er der allerede`;

  const measuredGain = store.getAverageLpGain(player.puuid);

  return formatNextRank({
    name: player.name,
    entry: player.entry,
    targetEntry,
    targetLabel,
    lpNeeded,
    lpPerWin: measuredGain ?? ASSUMED_LP_PER_WIN,
  });
}

/**
 * Removes the bot from a channel.
 *
 * A broadcaster can always remove it from their own channel — needing to ask
 * the operator to be left alone would be the wrong way round. The operator can
 * additionally name any channel, to remove it from somewhere they have no
 * account in.
 *
 * The roster is kept, so coming back costs nothing.
 */
export async function commandLeave({ channel, argument, tags, part }) {
  const isOwner = config.botOwners.has(tags?.username ?? '');
  const isBroadcaster =
    tags?.badges?.broadcaster === '1' || tags?.username === normalizeChannel(channel);

  const target = argument ? normalizeChannel(argument) : channel;

  if (target !== channel) {
    // Naming another channel is an operator action, not a moderation one.
    if (!isOwner) return 'Kun en botejer kan fjerne botten fra en anden kanal';
  } else if (!isBroadcaster && !isOwner) {
    return 'Kun kanalens ejer kan fjerne botten';
  }

  if (channels.deactivate(target) === 'unknown') {
    return `Botten er ikke i #${target}`;
  }

  // Leave immediately rather than at the next restart.
  await part?.(target);

  return target === channel
    ? 'Botten forlader kanalen nu. Spillerlisten gemmes — tilføj botten igen for at få den tilbage'
    : `Botten er fjernet fra #${target}`;
}

/** Points at the documentation rather than listing everything in chat. */
export async function commandCommands() {
  return `Alle kommandoer: ${config.wikiUrl}`;
}

export async function commandRegion({ channel, argument }) {
  const { platform } = channels.get(channel);

  // Without an argument the command is a question, so answer it fully: the
  // current region is useless without knowing what it can be changed to. The
  // current one is left out of the list, which would otherwise name it twice.
  if (!argument) {
    const others = [...PLATFORMS].filter((p) => p !== platform);
    return `Kanalens region er ${platform}. Skift til: ${others.join(' ')}`;
  }

  if (!channels.setPlatform(channel, argument)) {
    return `Ukendt region "${argument}". Gyldige: ${[...PLATFORMS].join(', ')}`;
  }

  return `Regionen er sat til ${argument.trim().toLowerCase()}`;
}
