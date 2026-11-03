# LoL Twitch Bot

Twitch chat bot that reports League of Legends ranked data for a tracked roster
of players, using the official Riot API.

## Commands

Every channel has its own roster, main account and region, so one bot serves
several streamers without them seeing each other's players.

### Everyone

| Command | Output |
|---|---|
| `!rank [Name#TAG]` | `RASMUS EMERALD IV: 2LP` — apex players also get `(Rank#167)` |
| `!ranks` | The channel's roster, numbered, highest first |
| `!gains [Name#TAG]` | `RASMUS: 3W 2L (+24 LP) 🟩🟩🟥🟩🟥` for today |
| `!lastgame [Name#TAG]` | Full stat line for the most recent ranked game |
| `!game [Name#TAG]` | Average rank of the live game, plus any pros in it |
| `!chal` / `!cutoff` | `EUW1 CHALLENGER 2418LP │ GRANDMASTER 1808LP │ opdateret kl 10:00 │ næste update er kl 11:00` |
| `!oldplayerlist` | The channel's roster |

Without an argument, commands use the channel's main account. `!chal` and
`!cutoff` are two names for the same command, and both report the channel's
own region.

### Moderators and broadcaster

| Command | Effect |
|---|---|
| `!oldaddplayer Name#TAG` | Adds to the roster, after checking the account exists |
| `!oldremoveplayer Name#TAG` | Removes from the roster |
| `!oldaddmain Name#TAG` | Sets the main, adding it to the roster if needed |
| `!oldremovemain Name#TAG` | Clears the main |

### Broadcaster only

| Command | Effect |
|---|---|
| `!oldregion euw1` | Sets the channel's region |

Unauthorised use is ignored silently rather than answered, so a locked command
cannot be used to spam chat.

Riot accounts are global but rank data is not, so adding a EUW player to a NA
channel succeeds and then shows Unranked forever. The bot says so on the add
rather than leaving it to be discovered.

`RANK_STYLE` defaults to `emotes`, which writes the tier name instead of its
letter (`EMERALD IV: 77LP`), and 7TV replaces it with a channel emote of that
name. 7TV is case sensitive, so the channel needs one emote per tier named
exactly `IRON`, `BRONZE`, `SILVER`, `GOLD`, `PLATINUM`, `EMERALD`, `DIAMOND`,
`MASTER`, `GRANDMASTER` and `CHALLENGER`. Apex tiers take no colon, because
`CHALLENGER:` would not match the emote. Viewers without the extension see
plain text. Set `RANK_STYLE=letters` for `E4 77LP` instead.

## Rate limits and polling

A personal Riot key allows 20 requests per second and 100 per two minutes, and
the second window is the binding one. Every call goes through a rate limiter
that queues rather than letting requests fail with 429s. Limits are budgeted
per region, matching how Riot counts them.

Polling is adaptive, and this is what makes many channels affordable. Most
tracked accounts are idle most of the day; polling all of them every minute is
what would blow the budget. Idle accounts are checked every ten minutes and
only move to the fast interval once they are playing. The measurement stays
correct because it only needs at most one ranked game to fall between two
readings, and a League game lasts far longer than the idle interval.

Thirty accounts cost roughly five requests per minute at rest, against a
budget of fifty.

**A personal key is documented as being for personal projects, not
production.** Running across other streamers' channels is hard to describe as
personal use, so apply for a production key before this grows.

## Ladder positions and cutoffs## Ladder positions and cutoffs

Riot publishes neither a player's ladder position nor the LP needed to reach
Grandmaster or Challenger, so both are derived from the full leagues.

A cutoff is **positional, not tier-based**. The obvious answer — the lowest LP
inside the Challenger league — is wrong, because Riot only recalculates apex
tier membership periodically. At any moment dozens of Grandmasters out-rank
the weakest Challengers, and Masters out-rank the weakest Grandmasters. With
300 Challenger slots, the real threshold is whatever the 300th player on the
combined ladder has; Grandmaster is the 1000th (300 + 700). Slot counts are
read from the leagues themselves, so smaller regions work too.

Computing the Grandmaster figure therefore needs Master as well — 10k players
and about 2 MB on EUW. Only its LP values are kept and the payload is dropped
immediately, and this runs once per schedule rather than per command.

Positions use only Challenger and Grandmaster: the best Master players sit far
below any position worth reporting.

Positions are shown only down to `LADDER_POSITION_LIMIT` (default 250).

Cutoffs are refreshed on **fixed clock boundaries** rather than a rolling
timer. The default `CUTOFF_REFRESH_MINUTES=1440` means once a day at local
midnight; `60` would mean on the hour. A daily interval aligns to midnight in
`TIMEZONE`, not UTC, because aligning it to UTC would fire at 01:00 or 02:00
Danish time depending on daylight saving. A rolling
cache would give each viewer a slightly different number at a slightly
different age; a scheduled one gives chat a single quotable figure, and `!chal`
reports both when it was taken and when it is taken next. The snapshot is
persisted, so a restart neither resets the schedule nor loses the last value.

## How LP tracking works

**The Riot API does not expose LP history.** There is no field saying a game was
worth +30 LP. Every LP figure this bot reports is measured by the bot itself:

1. A background poller checks each tracked player's ladder position every 60s.
2. When a new ranked match appears, the change since the last snapshot is
   attributed to that match and stored in `data/tracker.json`.
3. `!gains` compares the current position against the position at local midnight.

Consequences worth knowing:

- **LP is only measured while the bot runs.** Games played during downtime are
  shown without an LP figure rather than with a wrong one.
- **The first game after a cold start has no baseline** to measure against, so
  it shows without LP. Everything after it is measured.
- Tier and division changes are handled correctly: Emerald IV 92 LP to
  Emerald III 12 LP reads as +20, not -80.

## Setup

```bash
npm install
cp .env.example .env   # then fill it in
npm run check          # verifies the Riot side without needing Twitch
npm start
```

`npm run check` runs every command against `DEFAULT_RIOT_ID` and prints the
exact chat output. Use it to confirm the API key, region and roster before
touching Twitch credentials.

### Credentials

- **Riot API key** — https://developer.riotgames.com. A Development key expires
  every 24 hours; apply for a **Personal API Key** for anything long-running.
- **Twitch OAuth token** — generated for the bot account. Accepted with or
  without the `oauth:` prefix.

Both live in `.env`, which is gitignored. Never commit it.

## Deploying on Pelican / Pterodactyl (PebbleHost bot hosting)

The panel runs the bot in a Docker container, so there is no SSH, no root and
no systemd. The container restarts the bot automatically if it exits.

1. **Server settings** — use a Node.js egg with a **Node 20+** image. The bot
   needs Node 18 or newer.
2. **Startup** — set the start file to `src/index.js`. The egg runs
   `npm install` on every boot, so `node_modules` must *not* be uploaded.
3. **Files** — upload `src/`, `package.json` and `package-lock.json` through
   the file manager or SFTP, into `/home/container`.
4. **Secrets** — create `.env` in `/home/container` using the panel's file
   editor, following `.env.example`. Do not reuse a key that has been sent over
   chat or email; generate fresh ones.
5. **Start** — hit Start and watch the console. Four lines confirm success:
   connected, channels, commands, tracker.

`data/tracker.json` is created on first run and persists in the container
volume, so LP history survives restarts.

## Deploying on a plain server (systemd)

Only relevant with real root access — not for Pelican or Pterodactyl panels.

```bash
sudo useradd --system --home /opt/lol-twitch-bot lolbot
sudo cp -r . /opt/lol-twitch-bot
sudo chown -R lolbot:lolbot /opt/lol-twitch-bot
sudo cp deploy/lol-twitch-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lol-twitch-bot
```

Logs: `journalctl -u lol-twitch-bot -f`

## Rate limits

With a 60s poll interval the bot uses roughly one request per tracked player per
minute, plus a few per command. Responses are cached (ranks 60s, completed
matches forever, live games 30s) and identical concurrent requests are
deduplicated, so chat spam does not reach Riot.

`!game` is the heaviest command at up to 11 requests. If you add many players to
`PLAYERS`, raise `POLL_INTERVAL_SECONDS`.

## Data sources

- Rank, matches and live games: [Riot Games API](https://developer.riotgames.com/apis)
- Champion names: Data Dragon
- Pro player identification: [lolpros.gg](https://lolpros.gg) — undocumented
  internal endpoint, so `!game` degrades to average-rank-only if it changes.
  Disable with `ENABLE_LOLPROS=false`.
