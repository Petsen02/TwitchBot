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

## Datakilder

- Rank, kampe og live-kampe: [Riot Games API](https://developer.riotgames.com/apis)
- Championnavne: Data Dragon
- Pro-spillere: [lolpros.gg](https://lolpros.gg) — udokumenteret internt
  endpoint, så `!game` falder tilbage til kun gennemsnitsrank hvis det ændrer
  sig. Deaktiveres ikke separat.
