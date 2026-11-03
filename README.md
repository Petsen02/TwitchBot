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

## Udseende

`RANK_STYLE` er som standard `emotes`, som skriver tier-navnet i stedet for
bogstavet (`EMERALD IV: 77LP`). 7TV erstatter navnet med en kanal-emote.

7TV skelner mellem store og små bogstaver, så kanalen skal have én emote per
tier, navngivet præcis `IRON`, `BRONZE`, `SILVER`, `GOLD`, `PLATINUM`,
`EMERALD`, `DIAMOND`, `MASTER`, `GRANDMASTER` og `CHALLENGER`.

Master og opefter får intet kolon, fordi `CHALLENGER:` ikke ville matche
emoten — navnet skal stå alene mellem mellemrum. Seere uden 7TV-udvidelsen ser
tier-navnet som almindelig tekst, hvilket stadig læses fint.

`RANK_STYLE=letters` giver `E4 77LP` i stedet.

## Placeringer og cutoffs

Riot udgiver hverken en spillers placering på ladderen eller den LP der skal
til for at nå Grandmaster eller Challenger. Begge dele udledes af ligaerne.

En cutoff er **positionel, ikke tier-baseret**. Det nærliggende svar — den
laveste LP inde i Challenger-ligaen — er forkert, fordi Riot kun genberegner
medlemskabet periodisk. På ethvert tidspunkt har snesevis af Grandmasters mere
LP end de svageste Challengers, og Masters mere end de svageste Grandmasters.
Med 300 Challenger-pladser er grænsen derfor hvad nummer 300 på den samlede
ladder har; Grandmaster er nummer 1000 (300 + 700). Pladstallene læses fra
ligaerne selv, så mindre servere også virker.

Grandmaster-tallet kræver derfor også Master — 10.000 spillere og omkring 2 MB
på EUW. Kun LP-værdierne beholdes, resten kasseres med det samme, og det sker
på tidsplanen frem for ved hver kommando.

Placeringer vises kun ned til `LADDER_POSITION_LIMIT` (standard 250), og bruger
kun Challenger og Grandmaster: de bedste Masters ligger langt under enhver
placering der er værd at nævne.

Cutoffs opdateres på **faste klokkeslæt** frem for en rullende timer.
Standarden `CUTOFF_REFRESH_MINUTES=1440` betyder én gang i døgnet ved midnat;
`60` ville betyde hver hele time. Et døgnsinterval retter sig efter midnat i
`TIMEZONE`, ikke UTC — ellers ville det ramme klokken 01 eller 02 dansk tid
afhængigt af sommertid.

En rullende cache ville give hver seer et lidt forskelligt tal i en lidt
forskellig alder. En fast tidsplan giver chatten ét tal, og `!chal` oplyser
både hvornår det blev hentet og hvornår det hentes igen.

## Sådan virker LP-målingen

**Riots API har ingen LP-historik.** Der findes intet felt der siger at en kamp
gav +30 LP. Hvert LP-tal botten viser er målt af den selv:

1. En baggrundspoller aflæser hver spillers position på ladderen.
2. Når en ny ranked kamp dukker op, tilskrives ændringen siden sidste aflæsning
   den kamp, og gemmes i `data/tracker.json`.
3. `!gains` sammenligner den nuværende position med positionen ved midnat.

Konsekvenser værd at kende:

- **LP måles kun mens botten kører.** Kampe spillet under nedetid vises uden
  LP-tal frem for med et forkert.
- **Første kamp efter en kold start har intet udgangspunkt** at måle fra og
  vises uden LP. Alt derefter måles.
- Skift af tier og division håndteres korrekt: Emerald IV 92 LP til
  Emerald III 12 LP er +20, ikke −80.

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
