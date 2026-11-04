<img src="assets/logo.png" alt="" width="140" align="right">

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
| `!rank [Navn#TAG]` | `RASMUS EMERALD IV: 2LP` — Master og opefter får også deres placering på ladderen, `(Rank#167)` |
| `!ranks` | Kanalens liste, nummereret, højeste først |
| `!gains` / `!session` `[Navn#TAG]` | `RASMUS: 3W 2L (+24 LP) 🟩🟩🟥🟩🟥` for i dag |
| `!nextrank [Navn#TAG]` | `Petsen SILVER II: 40LP │ mangler 8 wins til GOLD IV` |
| `!lastgame [Navn#TAG]` | Fuld statistiklinje for seneste ranked kamp |
| `!lobby [Navn#TAG]` | Gennemsnitsrank i den igangværende kamp, plus eventuelle pros |
| `!chal` / `!cutoff` | `EUW1 CHALLENGER 2418LP │ GRANDMASTER 1808LP │ opdateret 03/11/26 kl 00:00 │ næste update 04/11/26 kl 00:00` |

## Admin-kommandoer

Alt der styrer kanalens opsætning har præfikset `!old`, og er lukket for
almindelige seere.

`!oldleave` kan kun køres af kanalens ejer — moderatorer kan ikke smide botten
ud. Spillerlisten gemmes, så botten kan tilføjes igen uden at sætte noget op
på ny.

| Kommando | Hvem | Virkning |
|---|---|---|
| `!oldcommands` | alle | Linker hertil |
| `!oldplayerlist` | mod | Viser kanalens spillerliste |
| `!oldaddplayer Navn#TAG` | mod | Tilføjer til listen, efter at kontoen er slået op hos Riot |
| `!oldremoveplayer Navn#TAG` | mod | Fjerner fra listen |
| `!oldaddmain Navn#TAG` | mod | Sætter main, og tilføjer til listen hvis den mangler |
| `!oldremovemain Navn#TAG` | mod | Fjerner main |
| `!oldregion euw1` | mod | Sætter kanalens region |
| `!oldleave` | kanalejer | Fjerner botten fra kanalen |

## Rang-ikoner med 7TV

Botten skriver tier-navnet som et almindeligt ord — `CHALLENGER`, `EMERALD` —
og 7TV bytter det ud med et ikon hos dem der har udvidelsen installeret.

![Botten med 7TV-ikoner i chatten](assets/7tv-preview.png)

### Sådan får din kanal ikonerne

**1. Hent emotes** fra [dette 7TV-sæt](https://7tv.app/users/01HMPER1EG00070FCM1Q64R22S)
og tilføj dem til din kanals emote set.

**2. Navnene skal være præcis disse**, med store bogstaver — 7TV skelner, så
`Emerald` og `EMERALD` er to forskellige emotes:

```
IRON  BRONZE  SILVER  GOLD  PLATINUM  EMERALD  DIAMOND  MASTER  GRANDMASTER  CHALLENGER
```

Mangler én af dem, skriver botten bare tier-navnet som tekst på den linje,
mens de øvrige viser ikoner.

**3. Seerne skal have 7TV installeret** — [browserudvidelsen](https://7tv.app)
findes til Chrome og Firefox. Uden den ser de `CHALLENGER 2418LP` som ren
tekst, hvilket stadig læses fint. Der findes ingen måde at sende billeder til
alle i en Twitch-chat.

Vil du helt undgå ikonerne, sættes `RANK_STYLE=letters` i `.env`. Så skriver
botten `C2418LP` i stedet.

## Regioner

Koden du skriver til `!oldregion`, og hvilken server den dækker. Riots egne
navne, bekræftet mod deres status-API.

| Kode | Server |
|---|---|
| `euw1` | EU West |
| `eun1` | EU Nordic & East |
| `tr1` | Tyrkiet |
| `ru` | Rusland |
| `me1` | Mellemøsten og Nordafrika |
| `na1` | Nordamerika |
| `br1` | Brasilien |
| `la1` | Latinamerika Nord |
| `la2` | Latinamerika Syd |
| `kr` | Korea |
| `jp1` | Japan |
| `oc1` | Oceanien |
| `sg2` | Singapore |
| `tw2` | Taiwan |
| `vn2` | Vietnam |

Filippinerne og Thailand har ikke længere egne servere — de er lagt ind under
Singapore.

`!oldregion` uden argument viser kanalens nuværende region og hele listen.

## Datakilder

- Rank, kampe og live-kampe: [Riot Games API](https://developer.riotgames.com/apis)
- Championnavne: Data Dragon
- Pro-spillere: [lolpros.gg](https://lolpros.gg) — udokumenteret internt
  endpoint, så `!lobby` falder tilbage til kun gennemsnitsrank hvis det ændrer
  sig. Deaktiveres ikke separat.
