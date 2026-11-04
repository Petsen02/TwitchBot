import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot, parseRiotId, PLATFORMS, defaultPlatform } from './config.js';

/**
 * Per-channel configuration.
 *
 * Every channel owns its roster, its main account and its region, so one bot
 * can serve several streamers without them seeing each other's players. Mods
 * edit this through chat commands, so it has to be durable and safe to write
 * at any moment — hence the same atomic write used for tracker state.
 */

const DATA_DIR = join(projectRoot, 'data');
const FILE = join(DATA_DIR, 'channels.json');

function emptyState() {
  return { version: 1, channels: {} };
}

/** Normalises a channel name the way Twitch reports it. */
export function normalizeChannel(name) {
  return name.trim().toLowerCase().replace(/^#/, '');
}

class ChannelStore {
  #state;

  constructor() {
    try {
      const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
      this.#state = parsed?.channels ? parsed : emptyState();
    } catch {
      this.#state = emptyState();
    }
  }

  save() {
    mkdirSync(DATA_DIR, { recursive: true });
    const temp = `${FILE}.tmp`;
    writeFileSync(temp, JSON.stringify(this.#state, null, 2), 'utf8');
    renameSync(temp, FILE);
  }

  /** Returns the channel's config, creating an empty one if it is new. */
  get(name) {
    const key = normalizeChannel(name);

    this.#state.channels[key] ??= {
      platform: defaultPlatform,
      players: [],
      main: null,
      active: true,
    };

    const channel = this.#state.channels[key];
    channel.players ??= [];
    channel.platform ??= defaultPlatform;
    channel.active ??= true;

    return channel;
  }

  /** Channels the bot should be in. Removed ones are kept but not listed. */
  names() {
    return Object.entries(this.#state.channels)
      .filter(([, channel]) => channel.active !== false)
      .map(([name]) => name);
  }

  /** Ensures a channel exists and is active, so the bot joins it. */
  ensure(name) {
    const channel = this.get(name);

    // Listing a removed channel in TWITCH_CHANNELS again brings it back, with
    // its roster intact.
    if (channel.active === false) {
      channel.active = true;
      this.save();
    }

    return this;
  }

  /**
   * Removes the bot from a channel.
   *
   * The entry is kept and only marked inactive: a streamer who comes back
   * should not have to rebuild their roster, and the LP history of their
   * players stays attached to the accounts regardless.
   *
   * @returns 'removed' | 'unknown'
   */
  deactivate(name) {
    const key = normalizeChannel(name);
    const channel = this.#state.channels[key];

    if (!channel || channel.active === false) return 'unknown';

    channel.active = false;
    this.save();
    return 'removed';
  }

  setPlatform(name, platform) {
    const value = platform.trim().toLowerCase();
    if (!PLATFORMS.has(value)) return false;

    this.get(name).platform = value;
    this.save();
    return true;
  }

  /** @returns 'added' | 'duplicate' */
  addPlayer(name, account) {
    const channel = this.get(name);
    const riotId = `${account.gameName}#${account.tagLine}`;

    if (channel.players.some((p) => p.puuid === account.puuid)) return 'duplicate';

    channel.players.push({ riotId, puuid: account.puuid });
    this.save();
    return 'added';
  }

  /** @returns 'removed' | 'missing' */
  removePlayer(name, riotId) {
    const channel = this.get(name);
    const wanted = riotId.toLowerCase();

    const index = channel.players.findIndex((p) => p.riotId.toLowerCase() === wanted);
    if (index === -1) return 'missing';

    const [removed] = channel.players.splice(index, 1);

    // A main that is no longer on the roster would silently break !rank.
    if (channel.main && channel.main.toLowerCase() === removed.riotId.toLowerCase()) {
      channel.main = null;
    }

    this.save();
    return 'removed';
  }

  setMain(name, riotId) {
    this.get(name).main = riotId;
    this.save();
  }

  /** @returns 'removed' | 'missing' */
  clearMain(name, riotId) {
    const channel = this.get(name);
    if (!channel.main || channel.main.toLowerCase() !== riotId.toLowerCase()) return 'missing';

    channel.main = null;
    this.save();
    return 'removed';
  }

  /** The main as a parsed Riot ID, falling back to the first player. */
  mainAccount(name) {
    const channel = this.get(name);
    if (channel.main) return parseRiotId(channel.main);
    return channel.players.length > 0 ? parseRiotId(channel.players[0].riotId) : null;
  }

  /**
   * Every account the tracker should watch, deduplicated across channels: the
   * same player followed in three channels is still one account to poll.
   */
  trackedAccounts() {
    const seen = new Map();

    for (const [name, channel] of Object.entries(this.#state.channels)) {
      // Nothing to poll for a channel the bot has left.
      if (channel.active === false) continue;

      for (const player of channel.players ?? []) {
        const key = `${channel.platform}:${player.puuid}`;
        if (!seen.has(key)) {
          seen.set(key, { ...player, platform: channel.platform, channels: [name] });
        } else {
          seen.get(key).channels.push(name);
        }
      }
    }

    return [...seen.values()];
  }
}

export const channels = new ChannelStore();
