import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config, projectRoot } from './config.js';
import { store } from './store.js';
import { formatRank } from './ladder.js';
import { formatDate, formatClock } from './time.js';

/**
 * A plain-text roll of the watch list, written to data/spillere.txt.
 *
 * This is the list that grows on its own: every player somebody has asked
 * about by Riot ID. Channel rosters are deliberately left out -- those are
 * curated by mods and already visible through !oldplayerlist. What cannot be
 * seen from anywhere is how far this one has grown.
 *
 * The tracker's own state lives in SQLite, which is the right shape for the
 * bot and unreadable from a file manager. This file exists purely to be
 * opened and read by a person.
 *
 * It is rewritten in full every time, because it is a view of the state
 * rather than a record of it. Deleting it costs nothing -- the next poll
 * round writes it again.
 */

const DATA_DIR = join(projectRoot, 'data');
const FILE = join(DATA_DIR, 'spillere.txt');

function stamp(at) {
  if (!at) return '—';
  return `${formatDate(at, config.timezone)} kl ${formatClock(at, config.timezone)}`;
}

function rows() {
  return store
    .watchedAccounts()
    .map((entry) => {
      const snapshot = store.getSnapshot(entry.puuid);

      return {
        riotId: entry.riotId,
        platform: entry.platform,
        // Always letters here. In emote style a rank renders as a 7TV image
        // in chat, but this file is read as text, where the spelled-out tier
        // is just a long word.
        rank: snapshot ? formatRank(snapshot, 'letters') : 'ukendt',
        addedAt: entry.addedAt ?? null,
        lastMatch: store.getLastMatchAt(entry.puuid),
      };
    })
    .sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
}

function render(entries, now) {
  const measured = entries.filter((entry) => entry.lastMatch !== null).length;

  const lines = [
    `Spillere tilføjet via !session — ${entries.length} i alt, ${measured} med målinger`,
    `Opdateret ${stamp(now)}`,
    '',
  ];

  if (entries.length === 0) {
    lines.push('Ingen endnu. En spiller tilføjes automatisk, første gang nogen');
    lines.push('skriver !session Navn#TAG om dem.');
    return `${lines.join('\n')}\n`;
  }

  // Columns are sized to the content so the file reads straight whether the
  // names are short or not. Newest first: the end of the list is the part
  // that changed since last time anyone looked.
  const width = (pick, min) => Math.max(min, ...entries.map((entry) => pick(entry).length));
  const nameWidth = width((entry) => entry.riotId, 'Spiller'.length);
  const rankWidth = width((entry) => entry.rank, 'Rang'.length);
  const regionWidth = width((entry) => entry.platform, 'Region'.length);

  const header = `${'Spiller'.padEnd(nameWidth)}  ${'Rang'.padEnd(rankWidth)}  `
    + `${'Region'.padEnd(regionWidth)}  ${'Tilføjet'.padEnd(17)}  Seneste måling`;

  lines.push(header);
  lines.push('-'.repeat(header.length));

  for (const entry of entries) {
    lines.push(
      `${entry.riotId.padEnd(nameWidth)}  ${entry.rank.padEnd(rankWidth)}  `
      + `${entry.platform.padEnd(regionWidth)}  ${stamp(entry.addedAt).padEnd(17)}  `
      + `${stamp(entry.lastMatch)}`,
    );
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Writes the roll. Never throws: a report that cannot be written is not a
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
