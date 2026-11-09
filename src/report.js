import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config, projectRoot } from './config.js';
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

function rows() {
  return store
    .watchedAccounts()
    .map((entry) => ({ twitch: entry.twitch || UNKNOWN, riotId: entry.riotId }))
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

  const width = Math.max('Twitch'.length, ...entries.map((entry) => entry.twitch.length));
  const header = `${'Twitch'.padEnd(width)}  Riot`;

  lines.push(header);
  lines.push('-'.repeat(width + 22));

  for (const entry of entries) {
    lines.push(`${entry.twitch.padEnd(width)}  ${entry.riotId}`);
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
