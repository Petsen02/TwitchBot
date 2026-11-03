/**
 * Rank arithmetic.
 *
 * Riot reports rank as three separate fields (tier, division, LP), which cannot
 * be compared or subtracted directly: going from Emerald IV 92 LP to Emerald III
 * 12 LP is a gain of 20, not a loss of 80. Everything here funnels through one
 * absolute ladder score so comparisons and deltas are always correct.
 */

const TIER_ORDER = [
  'IRON',
  'BRONZE',
  'SILVER',
  'GOLD',
  'PLATINUM',
  'EMERALD',
  'DIAMOND',
];

// Master and above share one continuous LP pool with no divisions, so they all
// start from the same base rather than stacking further tiers on top.
const APEX_BASE = TIER_ORDER.length * 400;
const APEX_TIERS = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);

const TIER_ABBREV = {
  IRON: 'I',
  BRONZE: 'B',
  SILVER: 'S',
  GOLD: 'G',
  PLATINUM: 'P',
  EMERALD: 'E',
  DIAMOND: 'D',
  MASTER: 'M',
  GRANDMASTER: 'GM',
  CHALLENGER: 'C',
};

const DIVISION_TO_NUMBER = { I: 1, II: 2, III: 3, IV: 4 };

/**
 * 7TV emote names, which must match the channel's emotes exactly — 7TV is
 * case sensitive, so EMERALD and Emerald are different emotes. These happen to
 * match Riot's own tier values, but they are spelled out rather than derived
 * from them, because the emote set is what defines the correct spelling and a
 * different set may use different casing.
 *
 * The name must also stand alone between spaces to be replaced by its image.
 * Viewers without the 7TV extension see the tier name as text, which reads
 * fine on its own.
 */
const TIER_EMOTE = {
  IRON: 'IRON',
  BRONZE: 'BRONZE',
  SILVER: 'SILVER',
  GOLD: 'GOLD',
  PLATINUM: 'PLATINUM',
  EMERALD: 'EMERALD',
  DIAMOND: 'DIAMOND',
  MASTER: 'MASTER',
  GRANDMASTER: 'GRANDMASTER',
  CHALLENGER: 'CHALLENGER',
};
const NUMBER_TO_DIVISION = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV' };

export function isApex(tier) {
  return APEX_TIERS.has(tier);
}

/** Collapses tier + division + LP into a single comparable number. */
export function toAbsolute({ tier, rank, leaguePoints }) {
  const lp = leaguePoints ?? 0;
  if (isApex(tier)) return APEX_BASE + lp;

  const tierIndex = TIER_ORDER.indexOf(tier);
  if (tierIndex === -1) return null;

  // Division IV is the bottom of a tier, so it contributes nothing.
  const divisionIndex = 4 - (DIVISION_TO_NUMBER[rank] ?? 4);
  return tierIndex * 400 + divisionIndex * 100 + lp;
}

/** Inverse of toAbsolute, used to express an averaged score as a real rank. */
export function fromAbsolute(absolute) {
  if (absolute >= APEX_BASE) {
    return { tier: 'MASTER', rank: 'I', leaguePoints: Math.round(absolute - APEX_BASE) };
  }

  const clamped = Math.max(0, absolute);
  const tierIndex = Math.min(TIER_ORDER.length - 1, Math.floor(clamped / 400));
  const withinTier = clamped - tierIndex * 400;
  const divisionIndex = Math.min(3, Math.floor(withinTier / 100));

  return {
    tier: TIER_ORDER[tierIndex],
    rank: NUMBER_TO_DIVISION[4 - divisionIndex],
    leaguePoints: Math.round(withinTier - divisionIndex * 100),
  };
}

/**
 * Renders a rank in one of two styles.
 *
 * "letters" matches the reference bot: "E4 77LP", and "C2138LP" for apex
 * tiers, which have no division and so no separating space.
 *
 * "emotes" emits the 7TV emote name instead: "EMERALD IV: 77LP". The name
 * must stand alone between spaces for 7TV to swap in the image, which is why
 * the division keeps a Roman numeral and the colon separates it from the LP —
 * "EMERALD 4 77LP" would put two numbers side by side and read badly once the
 * word becomes an icon. Apex tiers have no division: "CHALLENGER: 2138LP".
 */
export function formatRank(entry, style = 'letters') {
  if (!entry) return 'Unranked';

  const lp = entry.leaguePoints ?? 0;

  if (style === 'emotes') {
    const emote = TIER_EMOTE[entry.tier];
    if (!emote) return 'Unranked';

    // The emote name must stay a standalone word for 7TV to swap in the
    // image, so nothing may touch it. Apex tiers have no division and
    // therefore no colon — "CHALLENGER:" would never match the emote.
    if (isApex(entry.tier)) return `${emote} ${lp}LP`;
    return `${emote} ${entry.rank ?? 'IV'}: ${lp}LP`;
  }

  const abbrev = TIER_ABBREV[entry.tier];
  if (!abbrev) return 'Unranked';

  if (isApex(entry.tier)) return `${abbrev}${lp}LP`;

  return `${abbrev}${DIVISION_TO_NUMBER[entry.rank] ?? 4} ${lp}LP`;
}

/**
 * The entry point of the next tier up: Silver anything -> Gold IV.
 *
 * Returns null at Master and above, where promotion is decided by a moving
 * cutoff rather than a fixed LP threshold, and has to be answered differently.
 */
export function nextTierEntry(tier) {
  if (isApex(tier)) return null;

  const index = TIER_ORDER.indexOf(tier);
  if (index === -1) return null;

  // Diamond is the last tier with divisions; above it sits Master.
  if (index === TIER_ORDER.length - 1) {
    return { tier: 'MASTER', rank: 'I', leaguePoints: 0 };
  }

  return { tier: TIER_ORDER[index + 1], rank: 'IV', leaguePoints: 0 };
}

/** Tier and division with no LP: "GOLD IV", "MASTER". For naming a target. */
export function formatTier(entry, style = 'letters') {
  if (!entry) return 'Unranked';

  if (style === 'emotes') {
    const emote = TIER_EMOTE[entry.tier];
    if (!emote) return 'Unranked';
    return isApex(entry.tier) ? emote : `${emote} ${entry.rank ?? 'IV'}`;
  }

  const abbrev = TIER_ABBREV[entry.tier];
  if (!abbrev) return 'Unranked';
  return isApex(entry.tier) ? abbrev : `${abbrev}${DIVISION_TO_NUMBER[entry.rank] ?? 4}`;
}

/** Signed LP delta for display: "+30 LP" / "-17 LP". */
export function formatLpDelta(delta) {
  if (delta === null || delta === undefined) return null;
  return `${delta >= 0 ? '+' : ''}${delta} LP`;
}
