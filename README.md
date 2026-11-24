# ⚔️ Duelgame Online

A standalone online game: **the 3-Tick Duel Arena ("duelgame") against real online players** — plus practice bots for when no humans are on.

This is a *separate* project from the 3-Tick Duel Arena artifact, from Duel Me, and from nallystake. It copies Duel Me's proven patterns (scrypt-hashed auth, JSON persistence, escrowed stakes, double-settle guard, auth queued until the websocket is open) but implements the **duelgame's** combat triangle, not Duel Me's Melee/Magic/Range.

## Run it

```bash
npm install
npm start          # http://localhost:3000  (PORT env to change)
npm test           # two-client integration test
```

Accounts, gold, outfits and W-L records persist in `data/db.json` (created on first run; override with `DB_PATH` env). Passwords are hashed with Node's built-in `scrypt` — the only dependency is `ws`.

## Deploy (Render)

Free web service, see `render.yaml`: build `npm install`, start `npm start` (`node server.js`), `PORT` is provided by Render. Note: on Render's free tier the filesystem is ephemeral, so `data/db.json` resets on redeploy/restart unless a persistent disk is attached — same caveat as duel-me-online.

## How to play (mobile first)

- **Register / log in** — new accounts start with **50 gp** and Peasant Rags.
- **Lobby:** live list of online real players with gold, W-L record and outfit colours. Pick a stake chip (**5 / 10 / 25 / 50 / 100 / 250 gp**) and challenge anyone online; the server checks *both* players can afford it before the challenge is sent. Accept/decline popup on the other side; 30-second expiry.
- **Practice bots** (same server combat, fixed stakes): **Squire Pip** 5 gp, **Hedge Knight Bram** 10 gp, **Pit Dog Mara** 25 gp — with their duelgame style weights and cunning (they sometimes counter your favourite move).
- **Outfit shop:** 7 outfits — Peasant Rags 0, Bronze Trim 75, Steel Plate 200, Shadow Cloak 350, Mithril Shine 450, Dragon Red 900, Gilded King 2000. Buying/equipping persists and recolours your knight for everyone.
- **Refill:** when you're under 5 gp (can't afford the minimum stake), claim a **free +50 gp refill**.

## Duel rules (exactly the duelgame's)

- Both stakes are **escrowed** the moment a duel starts; 3-2-1 countdown, then the fight.
- The server ticks **3 times per second**; one exchange resolves **every 3 ticks (1 second)** using each player's locked-in move. You can change your locked move until the exchange lands; no move locked = your last move repeats (default Attack).
- **The triangle:** Attack beats Strength — **4 dmg, "SLASH!"** · Strength beats Defence — **6 dmg, "SMASH!"** · Defence beats Attack — **2 dmg, "BLOCKED!"**. Same move = "CLASH!" — both take 1, **except** defence vs defence = "GUARDED" — 0/0.
- **30 HP each.** First to 0 loses. Winner is paid the **full pot exactly once** (server-side settle guard), records update.
- **Disconnecting or leaving mid-duel is a forfeit** — the other player wins the pot.

## Files

- `server.js` — HTTP + WebSocket server: accounts, lobby/presence, challenges, escrow, server-run duel ticks, bots, persistence.
- `public/index.html` — the whole client: Three.js low-poly pit (two knights in outfit colours, swing animation, hitsplats, crown + "WINNER +pot GP" over the winner), login, lobby, challenge popup, Attack/Strength/Defence buttons with a 3-tick indicator, HP bars, outfit shop, practice bots.
- `test/two-clients.js` — triangle unit asserts against the server's own `resolveExchange`, two clients register (50 gp each), see each other + all 3 bots, challenge/accept 10 gp, fight to a KO spamming moves, asserts winner 60 / loser 40, gold conserved, records 1W/0L vs 0W/1L, proves the double-settle guard, and exercises the refill rule (refused at 50 gp; works at 0 gp after two forfeited 25 gp Mara duels).
