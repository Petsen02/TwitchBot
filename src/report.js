import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config, overlayAllows, projectRoot } from './config.js';
import { store } from './store.js';
import { formatDate, formatClock } from './time.js';

/**
 * A plain-text list of Twitch name against Riot ID, in data/spillere.txt.
 *
 * Every player somebody asks about by Riot ID goes on the watch list, and the
 * name of whoever asked goes on with them. This file is that pairing, written
 * so it can be opened in a file manager -- the tracker's own state is SQLite,
 * which cannot be.
 *
 * The pairing is a guess, and an honest one only because people mostly look
 * themselves up. Nothing stops a viewer asking about somebody else's account,
 * and the bot has no way to tell the difference, so the Twitch name here
 * means "who introduced this Riot ID", not "who owns it".
 *
 * It is a view rather than a record: rewritten whole on every poll round, and
 * harmless to delete.
 */

const DATA_DIR = join(projectRoot, 'data');
const FILE = join(DATA_DIR, 'spillere.txt');

const UNKNOWN = '—';

/** The player's own overlay address, as far as the bot can know it. */
function link(entry) {
  if (!config.overlayPort || !entry.overlayKey || !overlayAllows(entry)) return null;
  return `${config.overlayBaseUrl}/${entry.overlayKey}`;
}

function rows() {
  return store
    .watchedAccounts()
    .map((entry) => ({
      twitch: entry.twitch || UNKNOWN,
      riotId: entry.riotId,
      link: link(entry),
    }))
    .sort((a, b) => a.twitch.localeCompare(b.twitch, 'da'));
}

function render(entries, now) {
  const linked = entries.filter((entry) => entry.twitch !== UNKNOWN).length;
  const when = `${formatDate(now, config.timezone)} kl ${formatClock(now, config.timezone)}`;

  const lines = [
    `Linkede konti — ${entries.length} i alt, ${linked} med Twitch-navn`,
    `Opdateret ${when}`,
    '',
  ];

  if (entries.length === 0) {
    lines.push('Ingen endnu. En konto linkes automatisk, første gang nogen');
    lines.push('skriver !session Navn#TAG i chatten.');
    return `${lines.join('\n')}\n`;
  }

  const width = (pick, min) => Math.max(min, ...entries.map((entry) => pick(entry).length));
  const twitchWidth = width((entry) => entry.twitch, 'Twitch'.length);

  // The overlay column only appears when there is an overlay to link to.
  const showLinks = entries.some((entry) => entry.link);
  const riotWidth = showLinks ? width((entry) => entry.riotId, 'Riot'.length) : 'Riot'.length;

  const header = `${'Twitch'.padEnd(twitchWidth)}  ${'Riot'.padEnd(riotWidth)}`
    + (showLinks ? '  Overlay' : '');

  lines.push(header);
  lines.push('-'.repeat(showLinks ? header.length + 18 : twitchWidth + 22));

  for (const entry of entries) {
    const row = `${entry.twitch.padEnd(twitchWidth)}  ${entry.riotId.padEnd(riotWidth)}`;
    lines.push((showLinks ? `${row}  ${entry.link ?? ''}` : row).trimEnd());
  }

  if (showLinks && !config.overlayBaseUrl) {
    lines.push('');
    lines.push('Sæt OVERLAY_BASE_URL i .env til fx http://din-ip:port for hele adressen.');
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Writes the list. Never throws: a file that cannot be written is not a
 * reason to take the tracker down with it.
 */
export function writePlayerReport(now = Date.now()) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });

    const temp = `${FILE}.tmp`;
    writeFileSync(temp, render(rows(), now), 'utf8');
    renameSync(temp, FILE);
  } catch (error) {
    console.error('[report] kunne ikke skrive spillerlisten:', error.message);
  }
}
