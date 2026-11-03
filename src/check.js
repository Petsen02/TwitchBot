/**
 * Riot-side smoke test.
 *
 * Runs every command against the first configured channel without touching
 * Twitch, so the API key, regions and rosters can be verified before any
 * credentials exist. LP figures stay absent until the tracker has observed at
 * least one game.
 */
import { config, bootstrapChannels, seedPlayers, seedMain } from './config.js';
import { channels } from './channels.js';
import { getAccount } from './riot.js';
import {
  commandRank,
  commandRanks,
  commandGains,
  commandLastGame,
  commandGame,
  commandCutoff,
  commandPlayerList,
} from './commands.js';
import { preloadChampions } from './champions.js';

const [name = 'check'] = bootstrapChannels();
channels.ensure(name);

const channel = channels.get(name);

// Seed the roster the same way the bot does on first start.
if (channel.players.length === 0) {
  for (const player of seedPlayers()) {
    try {
      channels.addPlayer(name, await getAccount(channel.platform, player));
    } catch (error) {
      console.log(`seed ${player.riotId}: ${error.message}`);
    }
  }

  const main = seedMain();
  if (main) channels.setMain(name, main.riotId);
}

console.log(`kanal    : #${name} (${channel.platform})`);
console.log(`main     : ${channel.main ?? '(ingen)'}`);
console.log(`rank style: ${config.rankStyle}`);
console.log();

await preloadChampions();

const ctx = { channel: name, argument: '', viewer: 'check' };

const checks = [
  ['!rank', commandRank],
  ['!ranks', commandRanks],
  ['!gains', commandGains],
  ['!lastgame', commandLastGame],
  ['!game', commandGame],
  ['!chal / !cutoff', commandCutoff],
  ['!oldplayerlist', commandPlayerList],
];

let failed = 0;
for (const [label, run] of checks) {
  try {
    console.log(`${label.padEnd(16)} ${await run(ctx)}`);
  } catch (error) {
    failed += 1;
    console.log(`${label.padEnd(16)} FEJLEDE: ${error.message}`);
  }
}

console.log();
console.log(failed === 0 ? 'Alle tjek bestået.' : `${failed} tjek fejlede.`);
process.exitCode = failed === 0 ? 0 : 1;
