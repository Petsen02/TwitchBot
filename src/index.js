import tmi from 'tmi.js';
import { installCrashHandlers, logPaths } from './logger.js';
import { config, getTwitchConfig, bootstrapChannels, seedPlayers, seedMain } from './config.js';
import { channels, normalizeChannel } from './channels.js';
import { RiotError, getAccount } from './riot.js';
import { startTracker } from './tracker.js';
import { startCutoffSchedule } from './cutoffs.js';
import { store } from './store.js';
import { preloadChampions } from './champions.js';
import {
  commandRank,
  commandRanks,
  commandGains,
  commandLastGame,
  commandGame,
  commandCutoff,
  commandAddPlayer,
  commandRemovePlayer,
  commandPlayerList,
  commandAddMain,
  commandRemoveMain,
  commandRegion,
  truncate,
} from './commands.js';

/**
 * Command table. `level` is who may run it:
 *   everyone | mod (mods and the broadcaster) | broadcaster
 */
const handlers = new Map([
  ['rank', { level: 'everyone', run: commandRank }],
  ['ranks', { level: 'everyone', run: commandRanks }],
  ['gains', { level: 'everyone', run: commandGains }],
  ['lastgame', { level: 'everyone', run: commandLastGame }],
  ['game', { level: 'everyone', run: commandGame }],
  // Two names, one answer: nobody has to remember which is which.
  ['chal', { level: 'everyone', run: commandCutoff }],
  ['cutoff', { level: 'everyone', run: commandCutoff }],
  ['oldplayerlist', { level: 'mod', run: commandPlayerList }],
  ['oldaddplayer', { level: 'mod', run: commandAddPlayer }],
  ['oldremoveplayer', { level: 'mod', run: commandRemovePlayer }],
  ['oldaddmain', { level: 'mod', run: commandAddMain }],
  ['oldremovemain', { level: 'mod', run: commandRemoveMain }],
  ['oldregion', { level: 'broadcaster', run: commandRegion }],
]);

/** Turns an API failure into something a viewer can act on. */
function explain(error) {
  if (!(error instanceof RiotError)) return 'Der gik noget galt';

  switch (error.kind) {
    case 'auth':
      return 'Riot API-nøglen er ugyldig eller udløbet';
    case 'not_found':
      return 'Kunne ikke finde den konto';
    case 'rate_limit':
      return 'For mange forespørgsler lige nu, prøv igen om et øjeblik';
    case 'unavailable':
    case 'network':
      return 'Riot API svarer ikke lige nu';
    default:
      return 'Der gik noget galt i kontakten til Riot';
  }
}

function permitted(level, tags, channel) {
  if (level === 'everyone') return true;

  const isBroadcaster =
    tags.badges?.broadcaster === '1' || tags.username === normalizeChannel(channel);
  if (level === 'broadcaster') return isBroadcaster;

  return isBroadcaster || tags.mod === true;
}

const lastUsed = new Map();

function onCooldown(channel, command) {
  const key = `${channel}:${command}`;
  const now = Date.now();

  if (now - (lastUsed.get(key) ?? 0) < config.commandCooldownMs) return true;

  lastUsed.set(key, now);
  return false;
}

/**
 * Creates the channels named in .env and, the first time only, copies any
 * PLAYERS seed into the first of them. After that the roster lives in chat
 * commands and the seed is ignored.
 */
async function bootstrap() {
  const names = bootstrapChannels();
  for (const name of names) channels.ensure(name);

  const first = names[0];
  if (!first) return names;

  const existing = channels.get(first);
  if (existing.players.length > 0) return names;

  for (const player of seedPlayers()) {
    try {
      const account = await getAccount(existing.platform, player);
      channels.addPlayer(first, account);
    } catch (error) {
      console.error(`[bootstrap] ${player.riotId}: ${error.message}`);
    }
  }

  // A main that is not on the roster is never polled, so !gains would have no
  // LP for it. Seeding has to add it, exactly as !oldaddmain does.
  const main = seedMain();
  if (main) {
    try {
      const account = await getAccount(existing.platform, main);
      channels.addPlayer(first, account);
      channels.setMain(first, `${account.gameName}#${account.tagLine}`);
    } catch (error) {
      console.error(`[bootstrap] main ${main.riotId}: ${error.message}`);
    }
  }

  channels.save();
  return names;
}

async function main() {
  // Persist measured LP before exiting, however the process is going down.
  installCrashHandlers(() => store.save());

  console.log(`[bot] logs: ${logPaths.logs}`);
  console.log(`[bot] crash reports: ${logPaths.crashes}`);

  const twitch = getTwitchConfig();
  await bootstrap();

  const joined = channels.names();
  if (joined.length === 0) throw new Error('Ingen kanaler konfigureret — sæt TWITCH_CHANNELS');

  const client = new tmi.Client({
    options: { debug: false, skipUpdatingEmotesets: true },
    connection: { reconnect: true, secure: true },
    identity: { username: twitch.username, password: twitch.password },
    // tmi.js rewrites this array in place, prefixing every name with "#", so
    // it gets a copy — otherwise our own channel names change under us.
    channels: [...joined],
  });

  client.on('connected', (address, port) => {
    console.log(`[bot] forbundet til ${address}:${port} som ${twitch.username}`);
    console.log(`[bot] kanaler: ${joined.join(', ')}`);
    console.log(`[bot] kommandoer: ${[...handlers.keys()].map((c) => `!${c}`).join(' ')}`);
    console.log(`[bot] rank style: ${config.rankStyle}`);

    for (const name of joined) {
      const channel = channels.get(name);
      console.log(
        `[bot]   #${name} (${channel.platform}) — ${channel.players.length} spiller(e)`
          + `${channel.main ? `, main ${channel.main}` : ''}`,
      );
    }
  });

  client.on('message', async (channel, tags, message, self) => {
    if (self) return;

    const trimmed = message.trim();
    if (!trimmed.startsWith('!')) return;

    const [rawCommand, ...rest] = trimmed.slice(1).split(/\s+/);
    const command = rawCommand.toLowerCase();

    const handler = handlers.get(command);
    if (!handler) return;

    // Silently ignore unauthorised use rather than inviting people to retry.
    if (!permitted(handler.level, tags, channel)) return;

    if (onCooldown(channel, command)) return;

    const viewer = tags['display-name'] ?? tags.username;

    try {
      const reply = await handler.run({
        channel: normalizeChannel(channel),
        argument: rest.join(' ').trim(),
        viewer,
      });

      await client.say(channel, truncate(`@${viewer} ${reply}`));
    } catch (error) {
      console.error(`[bot] !${command} fejlede:`, error.message);
      await client.say(channel, `@${viewer} ${explain(error)}`);
    }
  });

  await client.connect();

  preloadChampions();
  startTracker();
  startCutoffSchedule();
}

main().catch((error) => {
  console.error('[bot] fatal:', error.stack ?? error.message);
  process.exitCode = 1;
});
