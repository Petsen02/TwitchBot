# LoL Twitch Bot (Lavet med AI)

Twitch-chatbot der viser League of Legends-rangdata for en liste af spillere,
via Riots officielle API.

> **Ansvarsfraskrivelse**
>
> LoL Twitch Bot is not endorsed by Riot Games and does not reflect the views
> or opinions of Riot Games or anyone officially involved in producing or
> managing Riot Games properties. Riot Games and all associated properties are
> trademarks or registered trademarks of Riot Games, Inc.

## Kommandoer

Hver kanal har sin egen spillerliste, main og region, så én bot kan betjene
flere streamere uden at de ser hinandens spillere.

| Kommando | Svar |
|---|---|
| `!rank [Navn#TAG]` | `RASMUS EMERALD IV: 2LP` — apex-spillere får også `(Rank#167)` |
| `!ranks` | Kanalens liste, nummereret, højeste først |
| `!gains [Navn#TAG]` | `RASMUS: 3W 2L (+24 LP) 🟩🟩🟥🟩🟥` for i dag |
| `!lastgame [Navn#TAG]` | Fuld statistiklinje for seneste ranked kamp |
| `!game [Navn#TAG]` | Gennemsnitsrank i den igangværende kamp, plus eventuelle pros |
| `!chal` / `!cutoff` | `EUW1 CHALLENGER 2418LP │ GRANDMASTER 1808LP │ opdateret 03/11/26 kl 00:00 │ næste update 04/11/26 kl 00:00` |

## Admin-kommandoer

Alt der styrer kanalens opsætning har præfikset `!old`, og er lukket for
almindelige seere.

| Kommando | Hvem | Virkning |
|---|---|---|
| `!oldplayerlist` | mod | Viser kanalens spillerliste |
| `!oldaddplayer Navn#TAG` | mod | Tilføjer til listen, efter at kontoen er slået op hos Riot |
| `!oldremoveplayer Navn#TAG` | mod | Fjerner fra listen |
| `!oldaddmain Navn#TAG` | mod | Sætter main, og tilføjer til listen hvis den mangler |
| `!oldremovemain Navn#TAG` | mod | Fjerner main |
| `!oldregion euw1` | mod | Sætter kanalens region |

## Opsætning

```bash
npm install
cp .env.example .env   # udfyld den
npm run check          # tester Riot-siden uden Twitch
npm start
```

`npm run check` kører hver kommando mod den første kanal og printer det
nøjagtige chat-output. Brug den til at bekræfte nøgle, region og spillerliste
før du rører Twitch-opsætningen.

### Nøgler

- **Riot API-nøgle** — developer.riotgames.com. En development-nøgle udløber
  hver 24. time; ansøg om en **personal-nøgle** til noget der skal køre.
- **Twitch OAuth-token** — oprettet for bot-kontoen. Accepteres med eller uden
  `oauth:` foran.

Begge ligger i `.env`, som er i `.gitignore`. Den må aldrig committes.

## Drift på Pelican eller Pterodactyl

Panelet kører botten i en Docker-container, så der er ingen SSH, ingen root og
ingen systemd. Containeren genstarter selv botten hvis den stopper.

1. **Egg** — `node.js generic` med et **Node 20+** image.
2. **Variabler** — `MAIN_FILE` til `src/index.js`. Til git-drift sættes
   `GIT_ADDRESS` til repoets URL og `USER_UPLOAD` slås fra.
3. **Startup Command** — standardkommandoen kører `ts-node` på grund af en fejl
   i egget, hvor `[[ "${MAIN_FILE}" == "*.js" ]]` altid er falsk. Brug i stedet:

```
if [ -d /home/container/.git ]; then cd /home/container && git pull; fi; if [ -f /home/container/package.json ]; then /usr/local/bin/npm install; fi; /usr/local/bin/node /home/container/src/index.js
```

4. **`.env`** oprettes i `/home/container` efter `.env.example`.
5. **Start** og læs konsollen. Linjerne viser kanaler, kommandoer, rank style og
   hver kanals spillerliste.

`data/` oprettes ved første kørsel og overlever genstarter og `git pull`, så
LP-historik og spillerlister består.

## Drift på en almindelig server

Kun relevant med rigtig root-adgang — ikke på Pelican eller Pterodactyl.

```bash
sudo useradd --system --home /opt/lol-twitch-bot lolbot
sudo cp -r . /opt/lol-twitch-bot
sudo chown -R lolbot:lolbot /opt/lol-twitch-bot
sudo cp deploy/lol-twitch-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lol-twitch-bot
```

Logs: `journalctl -u lol-twitch-bot -f`

## Logning

Alt konsoloutput skrives også til `logs/bot-ÅÅÅÅ-MM-DD.log`, én fil per dag.
Et uventet nedbrud skriver desuden en rapport i `crashes/` med fejlen og de
sidste 150 linjer op til den — det panelets konsol kaster væk ved genstart.
Filer ældre end 14 dage ryddes automatisk.

## Datakilder

- Rank, kampe og live-kampe: [Riot Games API](https://developer.riotgames.com/apis)
- Championnavne: Data Dragon
- Pro-spillere: [lolpros.gg](https://lolpros.gg) — udokumenteret internt
  endpoint, så `!game` falder tilbage til kun gennemsnitsrank hvis det ændrer
  sig. Deaktiveres ikke separat.
