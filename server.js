'use strict';
// Duelgame Online — real-player online version of the 3-Tick Duel Arena.
// Server-authoritative: gold, stakes, escrow, combat ticks and records live here.
// Combat rules are the duelgame's (see game.ts in the 3-Tick Duel Arena):
//   Attack beats Strength (4 dmg, "SLASH!"), Strength beats Defence (6 dmg, "SMASH!"),
//   Defence beats Attack (2 dmg, "BLOCKED!"). MAX_HP 30. 3 ticks/sec, exchange every 3 ticks.
// Rebalanced 2026-11-26 (Derek-approved fix plan, from the honest playtest): same move
//   clash is 2/2 (was 1/1 — too many dead exchanges); GUARDED arms a +1 "riposte" for
//   the next exchange's winner; a 3rd consecutive Defence blocks for 0 (anti-turtle).
//   Both duel-layer effects live in the duel timer; resolveExchange stays pure apart
//   from the clash number itself.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'db.json');
const PUBLIC = path.join(__dirname, 'public');

// ---------- Facebook Login (OAuth 2.0 authorization-code flow, no extra deps) ----------
// Config comes ONLY from env vars — the app secret must never be committed.
// Register this redirect URI in the Facebook app: PUBLIC_URL + /auth/facebook/callback
const FB_APP_ID = process.env.FACEBOOK_APP_ID || '';
const FB_APP_SECRET = process.env.FACEBOOK_APP_SECRET || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://duelgame-online.onrender.com').replace(/\/+$/, '');
const FB_REDIRECT_URI = PUBLIC_URL + '/auth/facebook/callback';
const fbConfigured = () => !!(FB_APP_ID && FB_APP_SECRET);

// ---------- Google AdSense ----------
// Derek's publisher ID (digits only, e.g. "1234567890123456" from "ca-pub-1234567890123456").
// Set as env ADSENSE_PUB_ID on Render. Used only for /ads.txt, which AdSense
// requires to verify the site is allowed to sell its ad space. The client
// carries the matching ca-pub- ID in public/index.html (window.ADSENSE_PUB_ID).
const ADSENSE_PUB_ID = String(process.env.ADSENSE_PUB_ID || '8773554474653193').replace(/^ca-/, '');
const adsConfigured = () => /^\d{10,}$/.test(ADSENSE_PUB_ID);

// ---------- Outfits (same 7, same prices/colors as game.ts OUTFITS) ----------
const OUTFITS = [
  { id: 'peasant', name: 'Peasant Rags', price: 0,    net: 0,  blurb: 'What you walked in wearing.', colors: { armor: '#9a8a72', trim: '#6b5d49', plume: '#b0a58e', shield: '#8a7a5f' } },
  { id: 'bronze',  name: 'Bronze Trim',  price: 40,   net: null,  blurb: 'First real metal. Smells like victory.', colors: { armor: '#a8763e', trim: '#6e4a24', plume: '#d99a4e', shield: '#8a5c2e' } },
  { id: 'steel',   name: 'Steel Plate',  price: 200,  net: 5,  blurb: 'Polished plate that turns heads at the gate.', colors: { armor: '#9fb2c8', trim: '#5f7189', plume: '#dfe9f5', shield: '#7d93ad' } },
  { id: 'shadow',  name: 'Shadow Cloak', price: 350,  net: 10, blurb: 'Dark leathers for fighters who strike first.', colors: { armor: '#3d4457', trim: '#232833', plume: '#6b7690', shield: '#2e3442' } },
  { id: 'mithril', name: 'Mithril Shine',price: 450,  net: 20, blurb: 'Blue-purple sheen, light as cloth, hard as a vault door.', colors: { armor: '#7d7fd6', trim: '#4a4a9e', plume: '#b9b9f2', shield: '#5f5fb8' } },
  { id: 'dragon',  name: 'Dragon Red',   price: 900,  net: 35, blurb: 'Red as a hitsplat. The pit goes quiet when it walks in.', colors: { armor: '#b03030', trim: '#6e1d1d', plume: '#e05a4e', shield: '#8c2626' } },
  { id: 'gilded',  name: 'Gilded King',  price: 2000, net: 50, blurb: "Solid gold plate. You don't wear it — it announces you.", colors: { armor: '#e3b93c', trim: '#9e7d1c', plume: '#f7dd7a', shield: '#c9a227' } },
  // Variety wave (Derek, 2026-11-26 night): cheaper colour so new players can
  // look different fast, plus clue-scroll exclusives (clue:true — never sold).
  { id: 'crimson', name: 'Crimson Warcloak', price: 120, net: null, blurb: 'Deep red cloth over chain. Cheap, loud, proud.', colors: { armor: '#8e2434', trim: '#4d1220', plume: '#e5484d', shield: '#6e1a28' } },
  { id: 'forest',  name: 'Forest Garb',  price: 180,  net: null, blurb: 'Moss greens for fighters who like the trees.', colors: { armor: '#3f6b35', trim: '#24401d', plume: '#8fce62', shield: '#2f5527' } },
  { id: 'ocean',   name: 'Ocean Mail',   price: 260,  net: 3,  blurb: 'Blue-green mail that ripples like harbour water.', colors: { armor: '#1f7a8c', trim: '#0f4552', plume: '#4fd8e8', shield: '#166272' } },
  { id: 'royal',   name: 'Royal Purple', price: 600,  net: 15, blurb: 'The colour of kings and very confident challengers.', colors: { armor: '#6d28a8', trim: '#3c1560', plume: '#c084fc', shield: '#54207f' } },
  { id: 'frost',   name: 'Frost Plate',  price: 800,  net: 25, blurb: 'Pale ice-blue plate. Cold to the touch, colder to fight.', colors: { armor: '#cfe8f5', trim: '#7fb2cc', plume: '#ffffff', shield: '#a8d0e6' } },
  { id: 'gildedshadow', name: 'Gilded Shadow', price: 0, net: null, clue: true, blurb: 'Shadow leathers edged in gold. Only found in a reward scroll.', colors: { armor: '#2b2f3a', trim: '#c9a227', plume: '#f7dd7a', shield: '#232833' } },
  { id: 'rainbow', name: 'Rainbow Knight', price: 0, net: null, clue: true, blurb: 'Every colour at once. A scroll legend — almost nobody has seen one.', colors: { armor: '#d94f70', trim: '#2f9e6e', plume: '#ffd23e', shield: '#3e7bd9' } },
];
// ---------- Pets (shop — they follow your knight around the arena) ----------
const PETS = [
  { id: 'pup',    name: 'Pup',         price: 150,  blurb: 'Loyal, wags at winners.', color: '#a8763e', accent: '#6e4a24' },
  { id: 'cat',    name: 'Kitten',      price: 250,  blurb: 'Judges every fight. Silently.', color: '#8a8f98', accent: '#565b63' },
  { id: 'parrot', name: 'Parrot',      price: 650,  blurb: 'Repeats the last hitsplat. Loudly.', color: '#2f9e6e', accent: '#d94f70' },
  { id: 'fox',    name: 'Fox',         price: 0,    clue: true, blurb: 'Quick and smug. Only found in a reward scroll.', color: '#d97b2f', accent: '#f5ede0' },
  { id: 'dragon', name: 'Baby Dragon', price: 1500, blurb: 'Breathes tiny sparks when you win.', color: '#b03030', accent: '#e3b93c' },
];
const petById = id => PETS.find(p => p.id === id) || null;
// ---------- Accessories (hat slot — clue-scroll rewards, worn over armour) ----------
const ACCESSORIES = [
  { id: 'phat_red',    name: 'Red Party Hat',    color: '#d92626', clue: true },
  { id: 'phat_blue',   name: 'Blue Party Hat',   color: '#2659d9', clue: true },
  { id: 'phat_green',  name: 'Green Party Hat',  color: '#26a83c', clue: true },
  { id: 'phat_purple', name: 'Purple Party Hat', color: '#7d3fd1', clue: true },
  { id: 'tophat',      name: 'Black Top Hat',    color: '#1c1c22', clue: true },
  { id: 'crown',       name: 'Golden Crown',     color: '#e3b93c', clue: true },
];
const accById = id => ACCESSORIES.find(a => a.id === id) || null;
// ---------- Clue-scroll rewards (RuneScape style: mostly gold + unique cosmetics) ----------
function rollClueReward(u) {
  const roll = Math.random() * 100;
  const giveItem = (kind, id, name) => {
    const list = kind === 'outfit' ? u.owned : kind === 'pet' ? u.petsOwned : u.accOwned;
    if (list.includes(id)) { u.gold += 100; return { kind: 'gold', amount: 100, dupOf: name }; }
    list.push(id);
    return { kind, id, name };
  };
  if (roll < 38) { const amt = 25 + Math.floor(Math.random() * 51); u.gold += amt; return { kind: 'gold', amount: amt }; }   // 25–75 gp
  if (roll < 58) { const amt = 100 + Math.floor(Math.random() * 101); u.gold += amt; return { kind: 'gold', amount: amt }; } // 100–200 gp
  if (roll < 74) { const hats = ACCESSORIES.filter(a => a.id.startsWith('phat')); const h = hats[Math.floor(Math.random() * hats.length)]; return giveItem('accessory', h.id, h.name); }
  if (roll < 82) return giveItem('pet', 'fox', 'Fox');
  if (roll < 90) return giveItem('outfit', 'gildedshadow', 'Gilded Shadow');
  if (roll < 95) return giveItem('accessory', 'tophat', 'Black Top Hat');
  if (roll < 98) return giveItem('accessory', 'crown', 'Golden Crown');
  return giveItem('outfit', 'rainbow', 'Rainbow Knight');
}
// Net score = wins - losses. The cool armour is EARNED at a net score and HELD
// only while the net score stays high enough (Derek's rule, 2026-11-25): drop
// below an outfit's net and you lose that outfit — you must rebuy it once your
// net score earns it back.
const netOf = u => (u ? (u.wins || 0) - (u.losses || 0) : 0);
function enforceNetGear(u) {
  // Strip owned outfits whose net requirement the player no longer meets.
  // Returns the list of stripped outfit ids. Peasant (net 0) can never strip.
  if (!u || !Array.isArray(u.owned)) return [];
  const net = netOf(u);
  const stripped = u.owned.filter(id => { const o = outfitById(id); return o && o.net != null && o.net > net; });
  if (stripped.length) {
    u.owned = u.owned.filter(id => !stripped.includes(id));
    if (stripped.includes(u.outfit)) u.outfit = 'peasant';
  }
  return stripped;
}
const outfitById = id => OUTFITS.find(o => o.id === id) || OUTFITS[0];

// ---------- Combat (EXACTLY the duelgame rules) ----------
const MOVES = ['attack', 'strength', 'defence'];
const BEATS = { attack: 'strength', strength: 'defence', defence: 'attack' };
const WIN_DAMAGE = { attack: 4, strength: 6, defence: 2 };
const MAX_HP = 30;
const MIN_STAKE = 5;
const STAKES = [5, 10, 25, 50, 100, 250];

function resolveExchange(a, b) {
  // returns {aDmg: damage dealt TO a, bDmg: damage dealt TO b, word, winner:'a'|'b'|'clash'}
  if (a === b) {
    if (a === 'defence') return { aDmg: 0, bDmg: 0, word: 'GUARDED', winner: 'clash' };
    return { aDmg: 2, bDmg: 2, word: 'CLASH!', winner: 'clash' };
  }
  const wordFor = m => m === 'defence' ? 'BLOCKED!' : m === 'strength' ? 'SMASH!' : 'SLASH!';
  if (BEATS[a] === b) return { aDmg: 0, bDmg: WIN_DAMAGE[a], word: wordFor(a), winner: 'a' };
  return { aDmg: WIN_DAMAGE[b], bDmg: 0, word: wordFor(b), winner: 'b' };
}

// ---------- Reach / knockback / off-balance (duel layer; resolveExchange stays pure) ----------
// Fighters stand HOME_GAP apart. Taking a hit knocks you back; at the start of the
// next exchange cycle you walk forward until the gap is back within REACH_GAP.
// If you took >=2 damage you are offBalance for the NEXT exchange only: if you win
// that exchange by the triangle, your hit glances for base-1 damage (min 1).
// The triangle winner NEVER changes; clash/GUARDED are never glanced.
const HOME_GAP = 3.1;   // stance: knights at x ±1.55
const REACH_GAP = 3.4;  // can hit while gap <= this
const PIT_R = 4.6;      // duel movement stays inside this radius
const RUN_WALK = 2.7;   // units/second toward a fresh tap target — a touch faster…
const CHASE_WALK = 2.25; // …than the auto-chase, so a clean run really opens distance and whiffs land
function clampPit(p) { const rr = Math.hypot(p.x, p.z); if (rr > PIT_R) { p.x = Math.round(p.x / rr * PIT_R * 1000) / 1000; p.z = Math.round(p.z / rr * PIT_R * 1000) / 1000; } }
function pushFrom(p, from, amt) { let dx = p.x - from.x, dz = p.z - from.z; let d = Math.hypot(dx, dz); if (d < 0.001) { dx = p.x >= 0 ? 1 : -1; dz = 0; d = 1; } p.x = Math.round((p.x + dx / d * amt) * 1000) / 1000; p.z = Math.round((p.z + dz / d * amt) * 1000) / 1000; clampPit(p); }
// Duel movement (Derek, 2026-11-26): a fighter with a fresh tap target runs
// to it; everyone else auto-follows their opponent back to stance distance —
// so running makes hits whiff, and the chase always closes back in.
function stepDuelMovement(duel) {
  const P = duel.pos;
  for (const s of ['a', 'b']) {
    const mp = P[s], opp = P[s === 'a' ? 'b' : 'a'];
    let tx = null, tz = null, speed = CHASE_WALK;
    const mt = duel.mt[s];
    if (mt && Date.now() < mt.until && Math.hypot(mt.x - mp.x, mt.z - mp.z) > 0.08) { tx = mt.x; tz = mt.z; speed = RUN_WALK; }
    else {
      duel.mt[s] = null;
      const dx = mp.x - opp.x, dz = mp.z - opp.z, sep = Math.hypot(dx, dz);
      if (sep > HOME_GAP && sep > 0.001) { tx = opp.x + dx / sep * HOME_GAP; tz = opp.z + dz / sep * HOME_GAP; }
    }
    if (tx === null) continue;
    const dx = tx - mp.x, dz = tz - mp.z, d = Math.hypot(dx, dz);
    if (d < 0.001) continue;
    const st = Math.min(d, speed / 3); // per 333ms tick
    mp.x = Math.round((mp.x + dx / d * st) * 1000) / 1000;
    mp.z = Math.round((mp.z + dz / d * st) * 1000) / 1000;
    clampPit(mp);
  }
}
const knockbackFor = dmg => dmg <= 0 ? 0 : Math.round((0.25 + 0.16 * dmg) * 1000) / 1000;
// Walk-forward model (mirrored by the client): during a cycle, displaced fighters
// walk in until the combined displacement leaves the gap exactly at REACH_GAP.
// The most-displaced fighter walks first.
function applyWalkForward(disp) {
  let excess = (disp.a + disp.b) - (REACH_GAP - HOME_GAP);
  const walked = { a: 0, b: 0 };
  while (excess > 0.0005 && (disp.a > 0 || disp.b > 0)) {
    const side = disp.a >= disp.b ? 'a' : 'b';
    const step = Math.min(disp[side], excess);
    disp[side] = Math.round((disp[side] - step) * 1000) / 1000;
    walked[side] = Math.round((walked[side] + step) * 1000) / 1000;
    excess = Math.round((excess - step) * 1000) / 1000;
  }
  return walked;
}

// ---------- Practice bots (from game.ts OPPONENTS, cpu tier) ----------
const BOTS = [
  { id: 'pip',  name: 'Squire Pip',       title: 'Training-yard squire',    stake: 5,  style: { attack: 3, strength: 2, defence: 5 }, cunning: 0,    colors: { armor: '#8a7a5c', trim: '#5c4f38', plume: '#c9b458', shield: '#a08b62' }, taunt: 'Pip hides behind his shield a lot. Smash through it.' },
  { id: 'bram', name: 'Hedge Knight Bram',title: 'Road-worn sellsword',     stake: 10, style: { attack: 4, strength: 3, defence: 3 }, cunning: 0.15, colors: { armor: '#6e7f5e', trim: '#44513a', plume: '#7d9b6a', shield: '#5e7050' }, taunt: 'Bram mixes it up. Watch what he leans on.' },
  { id: 'mara', name: 'Pit Dog Mara',     title: 'Bare-knuckle pit fighter', stake: 25, style: { attack: 6, strength: 3, defence: 1 }, cunning: 0.2,  colors: { armor: '#7d4a3a', trim: '#4e2d22', plume: '#c0392b', shield: '#8a5a44' }, taunt: 'Mara almost never guards. Block her swings and punish the big ones.' },
  { id: 'champion', name: 'Arena Champion', title: 'Campaign final · holder of the gold belt', stake: 0, style: { attack: 4, strength: 4, defence: 3 }, cunning: 0.6, colors: { armor: '#d4af37', trim: '#17130a', plume: '#f7dd7a', shield: '#26221a' }, taunt: 'The Champion reads you like a book. Only met in a Campaign final.', campaignOnly: true },
];

// ---------- Campaign / tournament mode ----------
// A run = 4 rounds vs bots in order. FREE entry, NO stake taken; each round win
// pays a minted prize (like the refill mint — it is not taken from any pot, and
// the duel's pot stays 0 so it can never double-pay with the stake system).
// Lose any round (incl. forfeit/disconnect) = run ends, prizes already won are
// kept. Clearing round 4 awards a trophy (profile.trophies +1, persisted).
const CAMPAIGN_ROUNDS = [
  { botId: 'pip', prize: 10 },
  { botId: 'bram', prize: 20 },
  { botId: 'mara', prize: 40 },
  { botId: 'champion', prize: 100 },
];
const campaignInfo = () => CAMPAIGN_ROUNDS.map(r => { const b = botById(r.botId); return { botId: r.botId, name: b.name, title: b.title, prize: r.prize, colors: b.colors, taunt: b.taunt }; });
function campaignOf(u) {
  if (!u.campaign) u.campaign = { active: false, round: 0, won: [] };
  if (typeof u.trophies !== 'number') u.trophies = 0;
  return { active: !!u.campaign.active, round: u.campaign.active ? u.campaign.round : 0, wonRounds: [...(u.campaign.won || [])] };
}
// ---------- Explore tunnel (Derek, 2026-11-26 night): 3 fights, then a chest
// holding a reward scroll. These bots live only in the tunnel — they never
// appear in the lobby list and can't be challenged directly. ----------
const EXPLORE_BOTS = [
  { id: 'xrat',     name: 'Tunnel Rat',     title: 'Tunnel fight 1 of 3', stake: 0, style: { attack: 2, strength: 2, defence: 4 }, cunning: 0,    colors: { armor: '#7a6a55', trim: '#4e4234', plume: '#a08b6a', shield: '#5f5142' }, taunt: 'It guards the tunnel mouth, squeaking bravely.', exploreOnly: true },
  { id: 'xgoblin',  name: 'Cave Goblin',    title: 'Tunnel fight 2 of 3', stake: 0, style: { attack: 4, strength: 3, defence: 2 }, cunning: 0.1,  colors: { armor: '#5e7a3a', trim: '#38501f', plume: '#a8c95e', shield: '#4a612c' }, taunt: 'It wants your boots. Both of them.', exploreOnly: true },
  { id: 'xguardian',name: 'Tunnel Guardian',title: 'Tunnel fight 3 of 3 · guards the chest', stake: 0, style: { attack: 4, strength: 4, defence: 3 }, cunning: 0.35, colors: { armor: '#8f96a3', trim: '#c9a227', plume: '#e3b93c', shield: '#6e7683' }, taunt: 'Stone-faced and gold-trimmed. The chest is behind it.', exploreOnly: true },
];
const botByName = name => BOTS.find(b => b.name === name) || EXPLORE_BOTS.find(b => b.name === name);
const botById = id => BOTS.find(b => b.id === id) || EXPLORE_BOTS.find(b => b.id === id);
// Live bot state (duel occupancy + record for the lobby list)
const botState = {}; BOTS.forEach(b => botState[b.id] = { duelId: null, wins: 0, losses: 0 });
EXPLORE_BOTS.forEach(b => botState[b.id] = { duelId: null, wins: 0, losses: 0 });

function favouriteOf(history) {
  if (!history || history.length < 3) return null;
  const counts = { attack: 0, strength: 0, defence: 0 };
  for (const m of history) counts[m]++;
  const fav = MOVES.reduce((x, y) => (counts[y] > counts[x] ? y : x));
  return counts[fav] >= 3 ? fav : null;
}
// Bot habits a player can SEE and exploit (fix plan B5): Pip guards twice after
// being smashed; Mara never defends twice in a row; Bram, once you've leaned on
// one move 3+ times, gets a visible warning beat ("warn") and then counters it.
function pickBotMove(bot, duel) {
  const mem = duel.botMemory || (duel.botMemory = { guard: 0, warn: false, lastMove: null });
  if (bot.id === 'pip' && mem.guard > 0) { mem.guard--; mem.lastMove = 'defence'; return 'defence'; }
  if (bot.id === 'bram' && mem.warn) {
    mem.warn = false;
    const fav = favouriteOf(duel.historyA);
    if (fav) { const mv = MOVES.find(m => BEATS[m] === fav); mem.lastMove = mv; return mv; }
  }
  let mv = pickBotMoveWeighted(bot, duel.historyA);
  if (bot.id === 'mara' && mv === 'defence' && mem.lastMove === 'defence') mv = Math.random() < 0.5 ? 'attack' : 'strength';
  mem.lastMove = mv;
  return mv;
}
const PRACTICE_PATTERN = ['defence', 'defence', 'attack', 'strength', 'defence', 'attack', 'strength', 'strength'];
function pickBotMoveWeighted(bot, playerHistory) {
  // Port of game.ts pickOpponentMove: cunning counters the player's favourite.
  if (playerHistory.length >= 3 && Math.random() < bot.cunning) {
    const counts = { attack: 0, strength: 0, defence: 0 };
    for (const m of playerHistory) counts[m]++;
    const favourite = MOVES.reduce((x, y) => (counts[y] > counts[x] ? y : x));
    return MOVES.find(m => BEATS[m] === favourite);
  }
  const total = bot.style.attack + bot.style.strength + bot.style.defence;
  let roll = Math.random() * total;
  for (const m of MOVES) { roll -= bot.style[m]; if (roll <= 0) return m; }
  return 'attack';
}

// ---------- Store (JSON file) ----------
function loadDb() { try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch { return { users: {} }; } }
let db = loadDb();
let saveTimer = null;
function saveDb() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveDbNow(); }, 50);
}
function saveDbNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ---------- Passwords (scrypt, no extra deps — same as duel-me) ----------
function hashPw(password, salt) { return crypto.scryptSync(String(password), salt, 32).toString('hex'); }
function newUser(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPw(password, salt), gold: 50, owned: ['peasant'], outfit: 'peasant', wins: 0, losses: 0, trophies: 0, fights: 0, adBreakPending: false, adDay: '', adClaims: 0, campaign: { active: false, round: 0, won: [] }, practiced: false, lastWinDay: '', campaignBest: 0, streak: 0, bestStreak: 0, bankGold: 0, bankItems: [], petsOwned: [], pet: null, accOwned: [], accessory: null, scrolls: 0, exploreStep: 0, exploreDone: false };
}
// Older accounts predate the streak/bank/pet/scroll fields — fill them in
// wherever the user record is touched.
function ensureFields(u) {
  if (!u) return u;
  if (typeof u.streak !== 'number') u.streak = 0;
  if (typeof u.bestStreak !== 'number') u.bestStreak = 0;
  if (typeof u.bankGold !== 'number') u.bankGold = 0;
  if (!Array.isArray(u.bankItems)) u.bankItems = [];
  if (!Array.isArray(u.lastFights)) u.lastFights = []; // recent form, newest first: 'W'/'L', max 5
  if (!Array.isArray(u.petsOwned)) u.petsOwned = [];
  if (!('pet' in u)) u.pet = null;
  if (!Array.isArray(u.accOwned)) u.accOwned = [];
  if (!('accessory' in u)) u.accessory = null;
  if (typeof u.scrolls !== 'number') u.scrolls = 0;
  if (typeof u.exploreStep !== 'number') u.exploreStep = 0;
  if (typeof u.exploreDone !== 'boolean') u.exploreDone = false;
  return u;
}
// Highscores for the setup screen: best win streak first, then most wins.
function highscores() {
  return Object.entries(db.users).map(([name, u]) => ({ name, best: u.bestStreak || 0, streak: u.streak || 0, fights: u.fights || 0, wins: u.wins || 0, losses: u.losses || 0 }))
    .sort((x, y) => (y.best - x.best) || (y.wins - x.wins) || (y.fights - x.fights)).slice(0, 10);
}
function checkPw(user, password) {
  const h = Buffer.from(hashPw(password, user.salt), 'hex');
  const stored = Buffer.from(user.hash, 'hex');
  return h.length === stored.length && crypto.timingSafeEqual(h, stored);
}

// ---------- Facebook accounts + one-time tokens ----------
// A Facebook login finds the profile by facebookId. First FB login creates a
// normal account (50 gp, Peasant Rags, 0-0) whose password is a random value
// nobody knows — password login for that username is effectively disabled;
// the player always signs in through Facebook. We never auto-link an existing
// username/password account to a Facebook id (no linking UI in this round).
const fbStates = new Map();     // oauth state -> expiresAt (single-use, 10 min)
const fbLoginTokens = new Map(); // login token -> {username, expiresAt} (reusable until expiry, 5 min — duplicate callback hits must not strand the player)
const fbConsumedStates = new Map(); // state -> {token, expiresAt} for states already turned into a login, so a repeated callback hit redirects to that same login instead of an error page
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
function pruneFbMaps() {
  const now = Date.now();
  for (const [k, exp] of fbStates) if (exp <= now) fbStates.delete(k);
  for (const [k, rec] of fbLoginTokens) if (rec.expiresAt <= now) fbLoginTokens.delete(k);
  for (const [k, rec] of fbConsumedStates) if (rec.expiresAt <= now) fbConsumedStates.delete(k);
}
function findUserByFacebookId(fbId) {
  for (const [name, u] of Object.entries(db.users)) if (u && String(u.facebookId) === String(fbId)) return name;
  return null;
}
function fbUsernameFromName(fbName) {
  let base = String(fbName || '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 16);
  if (!base) base = 'fbplayer';
  let candidate = base, n = 2;
  while (db.users[candidate] || botByName(candidate)) {
    const suffix = String(n++);
    candidate = base.slice(0, 16 - suffix.length) + suffix;
  }
  return candidate;
}
function getOrCreateFbUser(fbId, fbName) {
  const existing = findUserByFacebookId(fbId);
  if (existing) return existing;
  const username = fbUsernameFromName(fbName);
  const u = newUser(crypto.randomBytes(32).toString('hex')); // random unusable password — FB is the only way in
  u.facebookId = String(fbId);
  if (fbName) u.facebookName = String(fbName).slice(0, 80);
  db.users[username] = u;
  saveDbNow();
  return username;
}
function mintFbToken(username) {
  pruneFbMaps();
  const token = randomToken();
  fbLoginTokens.set(token, { username, expiresAt: Date.now() + 5 * 60 * 1000 });
  return token;
}
function consumeFbToken(token) {
  pruneFbMaps();
  const rec = fbLoginTokens.get(String(token || ''));
  if (!rec) return null;
  if (rec.expiresAt <= Date.now()) { fbLoginTokens.delete(String(token)); return null; }
  return rec; // reusable until expiry on purpose (see fbLoginTokens note above)
}
// Test helper (same pattern as _settleById): mint a one-time fbLogin token.
// Accepts a username string, or a Facebook profile {id, name} — the profile
// form runs the real get-or-create path so tests can prove account creation.
function _mintFbTokenForTest(profileOrName) {
  let username;
  if (typeof profileOrName === 'string') {
    username = profileOrName;
    if (!db.users[username]) { db.users[username] = newUser(crypto.randomBytes(32).toString('hex')); saveDbNow(); }
  } else {
    username = getOrCreateFbUser(String(profileOrName.id), profileOrName.name || 'Facebook Player');
  }
  return { token: mintFbToken(username), username };
}
// The only part that talks to Facebook: code -> access token -> /me profile.
// Kept behind this one small function so the callback's state/token logic
// stays readable (and so tests never need a real Facebook app).
async function fbFetchProfile(code) {
  const tokenUrl = 'https://graph.facebook.com/v21.0/oauth/access_token?' + new URLSearchParams({
    client_id: FB_APP_ID, client_secret: FB_APP_SECRET, redirect_uri: FB_REDIRECT_URI, code: String(code),
  });
  const tokenRes = await fetch(tokenUrl, { signal: AbortSignal.timeout(10000) });
  const tokenJson = await tokenRes.json().catch(() => null);
  if (!tokenRes.ok || !tokenJson || !tokenJson.access_token) throw new Error('facebook code exchange failed: ' + ((tokenJson && tokenJson.error && tokenJson.error.message) || ('HTTP ' + tokenRes.status)));
  const meRes = await fetch('https://graph.facebook.com/v21.0/me?fields=id,name&access_token=' + encodeURIComponent(tokenJson.access_token), { signal: AbortSignal.timeout(10000) });
  const me = await meRes.json().catch(() => null);
  if (!meRes.ok || !me || !me.id) throw new Error('facebook profile fetch failed: ' + ((me && me.error && me.error.message) || ('HTTP ' + meRes.status)));
  return { id: String(me.id), name: String(me.name || '') };
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };
function sendHtml(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Duelgame Online</title>' +
    '<style>body{margin:0;font-family:system-ui,sans-serif;background:#17130e;color:#f5ead2;padding:24px 16px}main{max-width:640px;margin:0 auto}h1{color:#f7dd7a}a{color:#7db4ff}section{margin:18px 0;line-height:1.55}</style></head><body><main>' + body + '</main></body></html>');
}
function fbNotSetUp(res) {
  sendHtml(res, 200, '<h1>⚔️ Duelgame Online</h1><section><p>Facebook login isn\'t set up yet on this server. You can still play — go back and register or log in with a username and password.</p><p><a href="/">← Back to the game</a></p></section>');
}
function fbFailPage(res, status, msg) {
  sendHtml(res, status, '<h1>⚔️ Duelgame Online</h1><section><p>' + msg + '</p><p><a href="/">← Back to the game</a></p></section>');
}
function privacyPage(res) {
  sendHtml(res, 200, `<h1>⚔️ Duelgame Online — Privacy Policy</h1>
<section><p><i>Effective date: November 25, 2026.</i></p>
<p>Duelgame Online is a free online duelling game. This page explains, plainly, what information the game stores and what happens to it.</p></section>
<section><h2>What we store</h2>
<p><b>Username/password accounts:</b> your chosen username and a hashed password (we never store the password itself), plus your game data — gold, wins and losses, outfits you own and wear, campaign progress and trophies.</p>
<p><b>If you use Facebook Login:</b> Facebook sends us your Facebook account id and your display name. We store that id (so we can find your game account next time) and the display name, alongside the same game data described above. We do not ask Facebook for your email, friend list, photos, posts, or anything else — the login request only asks for your public profile (id and name).</p>
<p><b>Gameplay:</b> chat messages and duels are broadcast to other players in the lobby while you play; they are not kept as a permanent record by the game.</p></section>
<section><h2>How it is used</h2>
<p>Only to run the game: signing you in, saving your gold, record, outfits and campaign progress, and showing your username to other players in the lobby and in duels.</p></section>
<section><h2>Sharing, selling, and advertising</h2>
<p>We do not sell your information. Facebook only receives what is part of the login flow itself, handled under Facebook's own policies.</p>
<p><b>Advertising:</b> this game is supported by ads served by Google AdSense. Google and its partners may use cookies to serve ads based on your visits to this and other sites. We do not share your game account information (username, gold, record) with Google for advertising. You can opt out of personalised advertising at <a href="https://adssettings.google.com">Google Ads Settings</a>, and learn more in <a href="https://policies.google.com/technologies/ads">Google's advertising policy</a>.</p></section>
<section><h2>Deleting your data</h2>
<p>You can ask for your account and its game data to be deleted at any time. Contact the Duelgame Online game operator through the Facebook account or page that runs the game, tell us your in-game username (and say if you signed in with Facebook), and we will delete the account and its stored data.</p></section>
<section><h2>Changes</h2>
<p>If this policy changes, the updated version will be posted on this page with a new effective date.</p>
<p><a href="/">← Back to the game</a></p></section>`);
}
async function handleFbCallback(res, url) {
  if (!fbConfigured()) return fbNotSetUp(res);
  if (url.searchParams.get('error')) return fbFailPage(res, 400, 'Facebook login was cancelled or denied. No problem — you can still register or log in with a username and password.');
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  pruneFbMaps();
  // Facebook's return sometimes reaches this callback more than once for one
  // login (retries / redirect chains — seen live 2026-11-25: one login, three
  // callback hits, the later ones landing the player on an error page). If
  // this state already produced a login, send the player to that same login.
  const consumedState = state ? fbConsumedStates.get(state) : null;
  if (consumedState && consumedState.expiresAt > Date.now()) {
    console.log('[fb] callback: duplicate hit for an already-completed login — redirecting to its token');
    res.writeHead(302, { Location: '/?fbtoken=' + encodeURIComponent(consumedState.token) });
    return res.end();
  }
  const stateExp = fbStates.get(state);
  if (state) fbStates.delete(state); // single-use, whatever happens next
  console.log('[fb] callback: stateFound=' + !!stateExp + ' stateExpired=' + !!(stateExp && stateExp <= Date.now()) + ' hasCode=' + !!code + ' statesHeld=' + fbStates.size);
  if (!stateExp || stateExp <= Date.now() || !code) return fbFailPage(res, 400, 'That Facebook login link was invalid or expired. Please go back and tap “Log in with Facebook” again.');
  let profile;
  try { profile = await fbFetchProfile(code); }
  catch (e) { console.log('[fb] exchange/profile failed: ' + (e && e.message)); return fbFailPage(res, 502, 'Facebook login failed while talking to Facebook. Please try again in a moment.'); }
  console.log('[fb] login ok for profile id ' + profile.id);
  const username = getOrCreateFbUser(profile.id, profile.name);
  const token = mintFbToken(username);
  if (state) fbConsumedStates.set(state, { token, expiresAt: Date.now() + 10 * 60 * 1000 });
  res.writeHead(302, { Location: '/?fbtoken=' + encodeURIComponent(token) });
  res.end();
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let p = url.pathname;
  if (p === '/privacy') return privacyPage(res);
  if (p === '/ads.txt') {
    if (!adsConfigured()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('ads.txt not configured yet'); }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('google.com, pub-' + ADSENSE_PUB_ID + ', DIRECT, f08c47fec0942fa0\n');
  }
  if (p === '/auth/facebook') {
    if (!fbConfigured()) return fbNotSetUp(res);
    pruneFbMaps();
    const state = randomToken(24);
    fbStates.set(state, Date.now() + 10 * 60 * 1000);
    const dialog = 'https://www.facebook.com/v21.0/dialog/oauth?' + new URLSearchParams({
      client_id: FB_APP_ID, redirect_uri: FB_REDIRECT_URI, scope: 'public_profile', state, response_type: 'code',
    });
    res.writeHead(302, { Location: dialog });
    return res.end();
  }
  if (p === '/auth/facebook/callback') { handleFbCallback(res, url).catch(() => { try { fbFailPage(res, 500, 'Facebook login failed unexpectedly. Please try again.'); } catch {} }); return; }
  if (p === '/') p = '/index.html';
  if (p === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- Live state ----------
const clients = new Map(); // username -> {ws, duelId}
const pending = new Map(); // targetUsername -> {from, stake, expires}
const duels = new Map();   // duelId -> duel
let duelSeq = 1;

function send(ws, obj) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {} }
function broadcast(obj, except) { for (const [name, c] of clients) if (name !== except) send(c.ws, obj); }
function publicPlayer(name) {
  const u = db.users[name]; const c = clients.get(name);
  const o = outfitById(u ? u.outfit : 'peasant');
  let vs = null, stake = 0, campRound = 0;
  if (c && c.duelId) { const d = duels.get(c.duelId); if (d) { vs = d.a === name ? d.b : d.a; stake = d.stake; campRound = d.campaign ? d.round : 0; } }
  return { username: name, gold: u ? u.gold : 0, wins: u ? u.wins : 0, losses: u ? u.losses : 0, outfit: o.id, colors: o.colors, inDuel: !!(c && c.duelId), trophies: u ? (u.trophies || 0) : 0, vs, stake, campRound, pet: u ? (u.pet || null) : null, accessory: u ? (u.accessory || null) : null, wx: c && c.walk ? c.walk.x : null, wz: c && c.walk ? c.walk.z : null };
}
function playerList() {
  const list = [];
  for (const name of clients.keys()) list.push(publicPlayer(name));
  for (const b of BOTS) {
    let vs = null;
    const did = botState[b.id].duelId;
    if (did) { const d = duels.get(did); if (d) vs = d.a === b.name ? d.b : d.a; }
    list.push({ username: b.name, isBot: true, botId: b.id, title: b.title, stake: b.stake, taunt: b.taunt, gold: null, wins: botState[b.id].wins, losses: botState[b.id].losses, outfit: null, colors: b.colors, inDuel: !!did, campaignOnly: !!b.campaignOnly, trophies: 0, vs, stake: b.stake, campRound: 0 });
  }
  return list;
}
function duelSummary() {
  return [...duels.values()].map(d => ({ duelId: d.id, a: d.a, b: d.b, stake: d.stake, campaign: !!d.campaign, round: d.round || 0, practice: !!d.practice, explore: d.explore || 0, hpA: Math.max(0, d.hp.a), hpB: Math.max(0, d.hp.b), posA: d.pos ? d.pos.a : null, posB: d.pos ? d.pos.b : null }));
}
function broadcastPlayers() { const l = playerList(); broadcast({ type: 'players', players: l, duels: duelSummary() }); }
// ---------- Challenge queue (Derek, 2026-11-26): challenging a player who is
// mid-fight must not vanish into silence. The challenger is told at once, and
// the offer is delivered the moment the target's fight ends. ----------
const challengeQueue = new Map(); // targetUsername -> [{from, stake, expires}]
function queuedOutFor(name) {
  const out = [];
  for (const [target, q] of challengeQueue) for (const e of q) if (e.from === name) out.push({ target, stake: e.stake });
  return out;
}
function deliverQueued(name) {
  const tc = clients.get(name); if (!tc) return;
  if (pending.has(name)) return; // a live offer is already on their screen
  const q = challengeQueue.get(name); if (!q) return;
  while (q.length) {
    const e = q[0];
    const fc = clients.get(e.from); const fu = db.users[e.from]; const tu = db.users[name];
    const expired = Date.now() > e.expires;
    if (expired || !fc || !fu || fc.duelId || !tu || fu.gold < e.stake || tu.gold < e.stake) {
      q.shift();
      if (fc && !expired) send(fc.ws, { type: 'error', message: 'Your queued challenge to ' + name + ' lapsed — ' + (fc.duelId ? 'you are in a duel now.' : 'it can no longer be afforded.') });
      continue;
    }
    q.shift();
    pending.set(name, { from: e.from, stake: e.stake, expires: Date.now() + 30000 });
    send(tc.ws, { type: 'challengeIncoming', from: e.from, stake: e.stake, queued: true });
    send(fc.ws, { type: 'challengeSent', to: name, stake: e.stake, queued: true });
    personalState(e.from);
    break;
  }
  if (!q.length) challengeQueue.delete(name);
}
// ---------- Quick match: offer a free player; if nobody bites in 10s, a bot
// steps in (honest backfill — the player is told, never left hanging). ------
const quickTimers = new Map(); // username -> timeout id
function clearQuick(name) { const t = quickTimers.get(name); if (t) { clearTimeout(t); quickTimers.delete(name); } }
function quickBackfill(name) {
  quickTimers.delete(name);
  const c = clients.get(name); const u = db.users[name];
  if (!c || !u || c.duelId) return;
  for (const [t, p] of pending) if (p.from === name) pending.delete(t); // withdraw my unanswered offer
  const free = BOTS.filter(b => !b.campaignOnly && !botState[b.id].duelId && u.gold >= b.stake);
  const bot = free.length ? free[Math.floor(Math.random() * free.length)] : null;
  if (!bot) { send(c.ws, { type: 'error', message: 'No players free and every bot is busy or beyond your gold — try again in a moment.' }); return; }
  send(c.ws, { type: 'quickMatchBot', bot: bot.name });
  if (bot.id === 'pip' && !u.practiced) { u.practiced = true; saveDb(); startDuel(name, bot.name, bot.stake, { practice: true }); return; }
  startDuel(name, bot.name, bot.stake);
}
const AD_GOLD_AMOUNT = 10, AD_GOLD_DAILY_CAP = 5, AD_WATCH_MS = 30000;
function adDayStr() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Indiana/Indianapolis' }); }
function adClaimsLeft(u) { return u.adDay === adDayStr() ? Math.max(0, AD_GOLD_DAILY_CAP - (u.adClaims || 0)) : AD_GOLD_DAILY_CAP; }
function personalState(name) {
  const u = db.users[name]; if (!u) return;
  ensureFields(u);
  enforceNetGear(u);
  const c = clients.get(name);
  send(c && c.ws, { type: 'state', gold: u.gold, wins: u.wins, losses: u.losses, owned: u.owned, outfit: u.outfit, trophies: u.trophies || 0, fights: u.fights || 0, adBreakPending: !!u.adBreakPending, adClaimsLeft: adClaimsLeft(u), adGoldAmount: AD_GOLD_AMOUNT, campaign: campaignOf(u), practiced: !!u.practiced, campaignBest: u.campaignBest || 0, queuedOut: queuedOutFor(name), streak: u.streak || 0, bestStreak: u.bestStreak || 0, scores: highscores(), bankGold: u.bankGold || 0, bankItems: u.bankItems || [], petsOwned: u.petsOwned || [], pet: u.pet || null, accOwned: u.accOwned || [], accessory: u.accessory || null, scrolls: u.scrolls || 0, exploreStep: u.exploreStep || 0, exploreDone: !!u.exploreDone, lastFights: u.lastFights || [] });
}
function sysChat(text) { broadcast({ type: 'chat', from: '⚔️ Duelgame', text, kind: 'system' }); }

// ---------- Duels ----------
function startDuel(nameA, nameB, stake, opts) {
  opts = opts || {};
  clearQuick(nameA); clearQuick(nameB); // a started duel cancels any quick-match backfill
  const isCampaign = !!opts.campaign;
  const isPractice = !!opts.practice;
  const isExplore = !!opts.explore;
  const botDef = botByName(nameB);
  const isBotDuel = !!botDef;
  const ua = db.users[nameA];
  let ub = null;
  if (isCampaign || isPractice || isExplore) { stake = 0; } // campaign + practice + explore duels take NO stake
  else {
    ua.gold -= stake;
    if (!isBotDuel) { ub = db.users[nameB]; ub.gold -= stake; }
  }
  saveDb();
  const id = 'duel' + (duelSeq++);
  const duel = {
    id, a: nameA, b: nameB, stake, pot: (isCampaign || isPractice || isExplore) ? 0 : stake * 2, isBotDuel, botId: isBotDuel ? botDef.id : null,
    campaign: isCampaign, practice: isPractice, explore: isExplore ? opts.explore : 0, round: isCampaign ? opts.round : 0, prize: isCampaign ? opts.prize : 0,
    hp: { a: MAX_HP, b: MAX_HP },
    offBalance: { a: false, b: false }, // took >=2 dmg last exchange: next win glances
    riposte: { a: false, b: false },    // GUARDED armed it: next exchange's winner +1
    defStreak: { a: 0, b: 0 },          // consecutive Defence picks (3rd+ blocks for 0)
    botMemory: { guard: 0, warn: false, lastMove: null },
    exch: 0,
    pos: { a: { x: -HOME_GAP / 2, z: 0 }, b: { x: HOME_GAP / 2, z: 0 } }, // physical spots in the pit
    mt: { a: null, b: null },           // manual run targets {x, z, until} from ground taps
    disp: { a: 0, b: 0 },               // authoritative knockback displacement per fighter
    locked: { a: null, b: null }, last: { a: 'attack', b: 'attack' },
    historyA: [], tick: 0, settled: false, phase: 'countdown', timer: null,
  };
  duels.set(id, duel);
  const ca = clients.get(nameA); if (ca) ca.duelId = id;
  if (!isBotDuel) { const cb = clients.get(nameB); if (cb) cb.duelId = id; }
  else botState[botDef.id].duelId = id;
  personalState(nameA); if (ub) personalState(nameB);
  broadcastPlayers();
  const colorsOf = n => { const bot = botByName(n); if (bot) return bot.colors; const u = db.users[n]; return outfitById(u ? u.outfit : 'peasant').colors; };
  broadcast({ type: 'duelStart', duelId: id, a: nameA, b: nameB, stake, pot: duel.pot, hpA: MAX_HP, hpB: MAX_HP, colorsA: colorsOf(nameA), colorsB: colorsOf(nameB), homeGap: HOME_GAP, reachGap: REACH_GAP, dispA: 0, dispB: 0, posA: duel.pos.a, posB: duel.pos.b, campaign: isCampaign, practice: isPractice, explore: duel.explore, round: duel.round, prize: duel.prize });
  if (isCampaign) sysChat(`🏆 Campaign Round ${duel.round}: ${nameA} vs ${nameB} — ${duel.prize} gp prize!`);
  else if (isExplore) sysChat(`🗺️ ${nameA} delves deeper — tunnel fight ${duel.explore} of 3 vs ${nameB}!`);
  else if (isPractice) sysChat(`🎓 ${nameA} is learning the ropes — practice duel vs ${nameB}, no gold on the line.`);
  else sysChat(`${nameA} vs ${nameB} — ${stake} gp each in the pit!`);
  let count = 3;
  broadcast({ type: 'duelCountdown', duelId: id, n: count });
  duel.timer = setInterval(() => {
    if (duel.settled) return;
    if (duel.phase === 'countdown') {
      duel.cdTick = (duel.cdTick || 0) + 1;
      if (duel.cdTick % 3 !== 0) return; // one number every ~1s, so 3-2-1-FIGHT! takes ~3s and the fighters' walk-in (~2.7s with stagger) lands face to face as FIGHT! hits
      count--;
      if (count > 0) { broadcast({ type: 'duelCountdown', duelId: id, n: count }); return; }
      duel.phase = 'fight';
      broadcast({ type: 'duelCountdown', duelId: id, n: 0 });
      return;
    }
    duel.tick++;
    stepDuelMovement(duel);
    broadcast({ type: 'duelTick', duelId: id, tick: duel.tick, tickInExchange: ((duel.tick - 1) % 3) + 1, posA: duel.pos.a, posB: duel.pos.b });
    if (duel.tick % 3 !== 0) return;
    // Practice duel: the first 3 exchanges WAIT for the learner's tap — no
    // auto-play while they're still reading the screen (playtest fix 1.1).
    if (duel.practice && duel.exch < 3 && !duel.locked.a) return;
    if (duel.isBotDuel) duel.locked.b = duel.practice ? PRACTICE_PATTERN[duel.exch % PRACTICE_PATTERN.length] : pickBotMove(botDef, duel);
    const moveA = duel.locked.a || duel.last.a;
    const moveB = duel.locked.b || duel.last.b;
    duel.last.a = moveA; duel.last.b = moveB;
    duel.historyA.push(moveA);
    duel.locked.a = null; if (!duel.isBotDuel) duel.locked.b = null;
    duel.defStreak.a = moveA === 'defence' ? duel.defStreak.a + 1 : 0;
    duel.defStreak.b = moveB === 'defence' ? duel.defStreak.b + 1 : 0;
    // Walk-forward happened during this cycle: displaced fighters close back into reach.
    const walked = applyWalkForward(duel.disp);
    const r = resolveExchange(moveA, moveB);
    // Derek's range rule (2026-11-26): hits only count side by side. If the
    // pair has separated past reach — somebody ran — both swings whiff.
    const sepNow = Math.hypot(duel.pos.a.x - duel.pos.b.x, duel.pos.a.z - duel.pos.b.z);
    const missed = sepNow > REACH_GAP;
    if (missed) { r.aDmg = 0; r.bDmg = 0; r.word = 'MISS!'; r.winner = null; }
    // Riposte: GUARDED arms +1 for the NEXT exchange's winner; any other
    // exchange spends it. Anti-turtle: a 3rd straight Defence blocks for 0.
    let riposteSide = null, turtleSide = null;
    if (r.word === 'GUARDED') { duel.riposte.a = true; duel.riposte.b = true; }
    else {
      if ((r.winner === 'a' || r.winner === 'b') && duel.riposte[r.winner]) {
        riposteSide = r.winner;
        if (r.winner === 'a') r.bDmg += 1; else r.aDmg += 1;
      }
      duel.riposte.a = false; duel.riposte.b = false;
    }
    // Glancing hit: an off-balance fighter who WINS the triangle lands it weakly.
    // Winner never changes; clash/GUARDED never glance. offBalance is consumed either way.
    let glance = null;
    if (r.winner === 'a' && duel.offBalance.a) { glance = 'a'; r.bDmg = Math.max(1, r.bDmg - 1); }
    else if (r.winner === 'b' && duel.offBalance.b) { glance = 'b'; r.aDmg = Math.max(1, r.aDmg - 1); }
    if (r.word === 'BLOCKED!') { // winner is the defender; turtle check last so the block truly absorbs
      const w = r.winner;
      if (duel.defStreak[w] >= 3) { turtleSide = w; if (w === 'a') r.bDmg = 0; else r.aDmg = 0; }
    }
    const wasOff = { a: duel.offBalance.a, b: duel.offBalance.b };
    duel.hp.a -= r.aDmg; duel.hp.b -= r.bDmg;
    duel.exch++;
    // Bot habits react: Pip, smashed, guards twice; Bram starts watching a leaned-on move.
    let warnBram = false;
    if (duel.isBotDuel && botDef) {
      if (botDef.id === 'pip' && r.bDmg >= 6) duel.botMemory.guard = 2;
      if (botDef.id === 'bram' && !duel.botMemory.warn && favouriteOf(duel.historyA)) { duel.botMemory.warn = true; warnBram = true; }
    }
    // Knockback from THIS exchange's damage; offBalance re-sets from damage taken now.
    const kbA = knockbackFor(r.aDmg), kbB = knockbackFor(r.bDmg);
    duel.disp.a = Math.round((duel.disp.a + kbA) * 1000) / 1000;
    duel.disp.b = Math.round((duel.disp.b + kbB) * 1000) / 1000;
    // Knockback is physical too: the hit shoves you away from your opponent.
    if (kbA > 0) pushFrom(duel.pos.a, duel.pos.b, kbA);
    if (kbB > 0) pushFrom(duel.pos.b, duel.pos.a, kbB);
    duel.offBalance.a = r.aDmg >= 2;
    duel.offBalance.b = r.bDmg >= 2;
    broadcast({ type: 'duelExchange', duelId: id, a: duel.a, b: duel.b, moveA, moveB, aDmg: r.aDmg, bDmg: r.bDmg, word: r.word, winnerSide: r.winner, hpA: Math.max(0, duel.hp.a), hpB: Math.max(0, duel.hp.b), kbA, kbB, glance, glanceA: glance === 'a', glanceB: glance === 'b', dispA: duel.disp.a, dispB: duel.disp.b, walkedA: walked.a, walkedB: walked.b, offBalanceA: wasOff.a, offBalanceB: wasOff.b, riposte: riposteSide, turtle: turtleSide, warnBram, practice: !!duel.practice, exch: duel.exch, miss: missed, sep: Math.round(sepNow * 100) / 100, posA: duel.pos.a, posB: duel.pos.b });
    if (duel.hp.a <= 0 || duel.hp.b <= 0) {
      let winner;
      if (duel.hp.a <= 0 && duel.hp.b <= 0) winner = duel.hp.a === duel.hp.b ? duel.a : (duel.hp.a > duel.hp.b ? duel.a : duel.b);
      else winner = duel.hp.a <= 0 ? duel.b : duel.a;
      settleDuel(duel, winner, 'ko');
    }
  }, 333);
  return duel;
}

function settleDuel(duel, winnerName, reason) {
  if (duel.settled) return false; // double-settle guard: pot is paid exactly once
  duel.settled = true;
  // Ad breaks: count every completed fight per human player, server-side so a
  // refresh cannot dodge it. Every 5th fight raises a pending ad break.
  // Practice duels don't count — they're lessons, not fights.
  if (!duel.practice) [duel.a, duel.b].forEach(n => { const u = db.users[n]; if (u) { u.fights = (u.fights || 0) + 1; if (u.fights % 5 === 0) u.adBreakPending = true; } });
  if (duel.timer) clearInterval(duel.timer);
  const loserName = winnerName === duel.a ? duel.b : duel.a;
  const winnerBot = botByName(winnerName), loserBot = botByName(loserName);
  let prizeWon = 0, trophyWon = false, dailyBonus = 0;
  if (duel.practice) {
    // Practice settle: no gold, no W/L, no bot record — pure lesson.
  } else if (duel.campaign) {
    // Campaign settle: NO pot exists. Human is duel.a. Win = minted prize paid
    // exactly once (this function is guarded by duel.settled) + run advances;
    // clearing round 4 also mints a trophy. Loss = run ends, prizes kept.
    const human = db.users[duel.a];
    if (human) {
      campaignOf(human); // ensure campaign/trophies fields exist
      human.campaignBest = Math.max(human.campaignBest || 0, duel.round);
      if (winnerName === duel.a) {
        prizeWon = duel.prize;
        human.gold += duel.prize; human.wins += 1;
        human.campaign.won = [...(human.campaign.won || []), duel.round];
        if (duel.round >= CAMPAIGN_ROUNDS.length) { human.trophies += 1; trophyWon = true; human.campaign.active = false; human.campaign.round = 0; }
        else human.campaign.round = duel.round + 1;
      } else {
        human.losses += 1;
        human.campaign.active = false; human.campaign.round = 0; // run ends; won prizes stay in gold
      }
    }
    if (winnerBot) botState[winnerBot.id].wins += 1;
    if (loserBot) botState[loserBot.id].losses += 1;
  } else if (duel.explore) {
    // Explore settle: no pot. Win = delve one fight deeper; winning fight 3
    // leaves a chest waiting (exploreDone) that pays out a reward scroll.
    // Loss = the run ends and the tunnel resets.
    const human = db.users[duel.a];
    if (human) {
      ensureFields(human);
      if (winnerName === duel.a) {
        human.wins += 1;
        if (duel.explore >= 3) { human.exploreStep = 0; human.exploreDone = true; }
        else human.exploreStep = duel.explore + 1;
      } else {
        human.losses += 1;
        human.exploreStep = 0;
      }
    }
    if (winnerBot) botState[winnerBot.id].wins += 1;
    if (loserBot) botState[loserBot.id].losses += 1;
  } else {
    if (!winnerBot) { const w = db.users[winnerName]; if (w) { w.gold += duel.pot; w.wins += 1; } }
    else botState[winnerBot.id].wins += 1;
    if (!loserBot) { const l = db.users[loserName]; if (l) l.losses += 1; }
    else botState[loserBot.id].losses += 1;
  }
  // Daily first-win bonus (fix plan C): +10 gp once per day for a human winner.
  if (!duel.practice && !winnerBot) { const w = db.users[winnerName]; if (w) { const today = adDayStr(); if (w.lastWinDay !== today) { w.lastWinDay = today; w.gold += 10; dailyBonus = 10; } } }
  // Win streaks (setup-screen highscores): winner's streak grows, loser's resets.
  if (!duel.practice) {
    const wu = db.users[winnerName], lu = db.users[loserName];
    if (wu) { ensureFields(wu); wu.streak = (wu.streak || 0) + 1; wu.bestStreak = Math.max(wu.bestStreak || 0, wu.streak); wu.lastFights.unshift('W'); wu.lastFights = wu.lastFights.slice(0, 5); }
    if (lu) { ensureFields(lu); lu.streak = 0; lu.lastFights.unshift('L'); lu.lastFights = lu.lastFights.slice(0, 5); }
  }
  // Net-gear rule: a loss can drop a fighter's net score below their armour's
  // requirement — that armour is lost and must be rebought when re-earned.
  for (const n of [duel.a, duel.b]) { const u = db.users[n]; if (u) enforceNetGear(u); }
  saveDbNow();
  const ca = clients.get(duel.a); if (ca && ca.duelId === duel.id) ca.duelId = null;
  if (!duel.isBotDuel) { const cb = clients.get(duel.b); if (cb && cb.duelId === duel.id) cb.duelId = null; }
  if (duel.botId && botState[duel.botId].duelId === duel.id) botState[duel.botId].duelId = null;
  duels.delete(duel.id);
  broadcast({ type: 'duelEnd', duelId: duel.id, winner: winnerName, loser: loserName, pot: duel.pot, reason, campaign: !!duel.campaign, practice: !!duel.practice, explore: duel.explore || 0, round: duel.round || 0, prize: prizeWon, trophy: trophyWon, dailyBonus });
  if (duel.practice) sysChat(`🎓 Practice over: ${winnerName} beat ${loserName} — no gold changed hands.`);
  else if (duel.explore) sysChat(winnerName === duel.a ? (duel.explore >= 3 ? `🗺️ ${winnerName} beat the Tunnel Guardian — a chest waits in the tunnel!` : `🗺️ ${winnerName} cleared tunnel fight ${duel.explore} of 3.`) : `🗺️ ${winnerName} ended ${loserName}'s tunnel run at fight ${duel.explore} of 3.`);
  else if (duel.campaign) sysChat(prizeWon ? `🏆 ${winnerName} cleared Campaign Round ${duel.round} and won ${prizeWon} gp${trophyWon ? ' + a TROPHY!' : ''}` : `🏆 ${loserName}'s campaign run ended in Round ${duel.round} — ${winnerName} holds the pit.`);
  else sysChat(`🏆 ${winnerName} beat ${loserName} and took the ${duel.pot} gp pot!`);
  if (!winnerBot) personalState(winnerName);
  if (!loserBot) personalState(loserName);
  broadcastPlayers();
  // Freed fighters get their queued challenges now (Derek's no-one-ignored rule).
  if (db.users[duel.a]) deliverQueued(duel.a);
  if (!duel.isBotDuel && db.users[duel.b]) deliverQueued(duel.b);
  return true;
}

function _settleById(duelId, winnerName) {
  const d = duels.get(duelId);
  if (!d) return false;
  return settleDuel(d, winnerName, 'test');
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  let me = null;
  // Shared by username/password auth and Facebook login: identical authOk payload.
  function startSession(name) {
    if (clients.has(name)) { const old = clients.get(name); try { old.ws.close(); } catch {} }
    clients.set(name, { ws, duelId: null });
    const u = ensureFields(db.users[name]);
    send(ws, { type: 'authOk', username: name, gold: u.gold, wins: u.wins, losses: u.losses, owned: u.owned, outfit: u.outfit, outfits: OUTFITS, bots: BOTS, players: playerList(), trophies: u.trophies || 0, fights: u.fights || 0, adBreakPending: !!u.adBreakPending, adClaimsLeft: adClaimsLeft(u), adGoldAmount: AD_GOLD_AMOUNT, campaign: campaignOf(u), campaignRounds: campaignInfo(), practiced: !!u.practiced, campaignBest: u.campaignBest || 0, queuedOut: queuedOutFor(name), pets: PETS, accessories: ACCESSORIES, streak: u.streak || 0, bestStreak: u.bestStreak || 0, scores: highscores(), bankGold: u.bankGold || 0, bankItems: u.bankItems || [], petsOwned: u.petsOwned || [], pet: u.pet || null, accOwned: u.accOwned || [], accessory: u.accessory || null, scrolls: u.scrolls || 0, exploreStep: u.exploreStep || 0, exploreDone: !!u.exploreDone, lastFights: u.lastFights || [] });
    setTimeout(() => deliverQueued(name), 600); // an offer queued while they were away lands once they're in
    broadcastPlayers();
    sysChat(`${name} entered the lobby.`);
    return name;
  }
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'register' || m.type === 'login') {
      const name = String(m.username || '').trim().slice(0, 16);
      const pw = String(m.password || '');
      if (!/^[A-Za-z0-9_ ]+$/.test(name) || pw.length < 3) return send(ws, { type: 'authErr', message: 'Name: letters/numbers, password 3+ chars.' });
      if (botByName(name)) return send(ws, { type: 'authErr', message: 'That name is taken.' });
      if (m.type === 'register') {
        if (db.users[name]) return send(ws, { type: 'authErr', message: 'Name already taken — try logging in.' });
        db.users[name] = newUser(pw); saveDbNow();
      } else {
        const u = db.users[name];
        if (!u || !checkPw(u, pw)) return send(ws, { type: 'authErr', message: 'Wrong name or password.' });
      }
      me = startSession(name);
      return;
    }
    if (m.type === 'fbLogin') {
      // One-time token issued by GET /auth/facebook/callback after Facebook
      // confirmed the player. Consumed on ANY attempt: a second use, an
      // expired token, or an unknown token all get the same refusal.
      const rec = consumeFbToken(m.token);
      if (!rec || !db.users[rec.username]) return send(ws, { type: 'authErr', message: 'Facebook login link expired — try again.' });
      me = startSession(rec.username);
      return;
    }
    if (!me) return;
    const myClient = clients.get(me);
    const myUser = db.users[me];
    if (!myClient || !myUser) return;

    if (m.type === 'chat') {
      const text = String(m.text || '').trim().slice(0, 200);
      if (text) broadcast({ type: 'chat', from: me, text });
      return;
    }
    if (m.type === 'adBreakDone') {
      myUser.adBreakPending = false; saveDb(); personalState(me);
      return;
    }
    if (m.type === 'adWatchStart') {
      myClient.adWatchAt = Date.now();
      send(ws, { type: 'adWatchStarted', needMs: AD_WATCH_MS, serverNow: Date.now(), endsAt: Date.now() + AD_WATCH_MS });
      return;
    }
    if (m.type === 'claimAdGold') {
      if (adClaimsLeft(myUser) <= 0) return send(ws, { type: 'error', message: 'No free-gold claims left today — back tomorrow!' });
      if (!myClient.adWatchAt || Date.now() - myClient.adWatchAt < AD_WATCH_MS) return send(ws, { type: 'error', message: 'The ad has not finished yet.' });
      myClient.adWatchAt = 0;
      const today = adDayStr(); if (myUser.adDay !== today) { myUser.adDay = today; myUser.adClaims = 0; }
      myUser.adClaims++; myUser.gold += AD_GOLD_AMOUNT; saveDb();
      send(ws, { type: 'adGoldOk', amount: AD_GOLD_AMOUNT, gold: myUser.gold });
      personalState(me);
      return;
    }
    if (m.type === 'refill') {
      if (myUser.gold >= MIN_STAKE) return send(ws, { type: 'error', message: 'Refill refused: you still have 5+ gp. Broke is under 5 gp.' });
      myUser.gold += 50; saveDb();
      send(ws, { type: 'refillOk', gold: myUser.gold });
      personalState(me);
      return;
    }
    if (m.type === 'buy') {
      const o = outfitById(m.outfitId);
      if (o.clue) return send(ws, { type: 'error', message: `${o.name} isn't sold — it's only found in a reward scroll.` });
      if (myUser.owned.includes(o.id)) {
        if ((myUser.bankItems || []).includes(o.id)) return send(ws, { type: 'error', message: `${o.name} is in your bank — withdraw it first.` });
        myUser.outfit = o.id; saveDb(); personalState(me); broadcastPlayers(); return;
      }
      if (o.net != null && o.net > netOf(myUser)) return send(ws, { type: 'error', message: `${o.name} needs a net score of +${o.net} (wins − losses). Yours is ${netOf(myUser) >= 0 ? '+' : ''}${netOf(myUser)}.` });
      if (myUser.gold < o.price) return send(ws, { type: 'error', message: 'Not enough gold for that outfit.' });
      myUser.gold -= o.price; myUser.owned.push(o.id); myUser.outfit = o.id; saveDb();
      personalState(me); broadcastPlayers();
      return;
    }
    if (m.type === 'equip') {
      const o = outfitById(m.outfitId);
      if (!myUser.owned.includes(o.id)) return send(ws, { type: 'error', message: "You don't own that outfit." });
      if ((myUser.bankItems || []).includes(o.id)) return send(ws, { type: 'error', message: `${o.name} is in your bank — withdraw it first.` });
      if (o.net != null && o.net > netOf(myUser)) return send(ws, { type: 'error', message: `${o.name} needs a net score of +${o.net} (wins − losses).` });
      myUser.outfit = o.id; saveDb();
      personalState(me); broadcastPlayers();
      return;
    }
    if (m.type === 'buyPet') {
      ensureFields(myUser);
      const p = petById(m.petId);
      if (!p) return send(ws, { type: 'error', message: 'No such pet.' });
      if (p.clue) return send(ws, { type: 'error', message: `${p.name} isn't sold — it's only found in a reward scroll.` });
      if (myUser.petsOwned.includes(p.id)) { myUser.pet = p.id; saveDb(); personalState(me); broadcastPlayers(); return; }
      if (myUser.gold < p.price) return send(ws, { type: 'error', message: 'Not enough gold for that pet.' });
      myUser.gold -= p.price; myUser.petsOwned.push(p.id); myUser.pet = p.id; saveDb();
      personalState(me); broadcastPlayers();
      sysChat(`🐾 ${me} adopted a ${p.name}!`);
      return;
    }
    if (m.type === 'equipPet') {
      ensureFields(myUser);
      if (m.petId === null || m.petId === '') { myUser.pet = null; saveDb(); personalState(me); broadcastPlayers(); return; }
      const p = petById(m.petId);
      if (!p || !myUser.petsOwned.includes(p.id)) return send(ws, { type: 'error', message: "You don't own that pet." });
      if ((myUser.bankItems || []).includes(p.id)) return send(ws, { type: 'error', message: `${p.name} is in your bank — withdraw it first.` });
      myUser.pet = p.id; saveDb();
      personalState(me); broadcastPlayers();
      return;
    }
    if (m.type === 'equipAccessory') {
      ensureFields(myUser);
      if (m.accId === null || m.accId === '') { myUser.accessory = null; saveDb(); personalState(me); broadcastPlayers(); return; }
      const a = accById(m.accId);
      if (!a || !myUser.accOwned.includes(a.id)) return send(ws, { type: 'error', message: "You don't own that." });
      if ((myUser.bankItems || []).includes(a.id)) return send(ws, { type: 'error', message: `${a.name} is in your bank — withdraw it first.` });
      myUser.accessory = a.id; saveDb();
      personalState(me); broadcastPlayers();
      return;
    }
    if (m.type === 'bankGold') {
      ensureFields(myUser);
      const amt = Math.floor(Number(m.amount));
      if (!amt || amt <= 0) return send(ws, { type: 'error', message: 'Pick an amount.' });
      if (m.action === 'deposit') {
        if (myUser.gold < amt) return send(ws, { type: 'error', message: "You don't have that much gold on you." });
        myUser.gold -= amt; myUser.bankGold += amt;
      } else if (m.action === 'withdraw') {
        if (myUser.bankGold < amt) return send(ws, { type: 'error', message: "Your bank doesn't hold that much." });
        myUser.bankGold -= amt; myUser.gold += amt;
      } else return;
      saveDb(); personalState(me);
      return;
    }
    if (m.type === 'bankItem') {
      ensureFields(myUser);
      const id = String(m.itemId || '');
      const known = outfitById(id).id === id || petById(id) || accById(id);
      if (!known) return send(ws, { type: 'error', message: 'No such item.' });
      const owned = myUser.owned.includes(id) || myUser.petsOwned.includes(id) || myUser.accOwned.includes(id);
      if (!owned) return send(ws, { type: 'error', message: "You don't own that item." });
      if (m.action === 'deposit') {
        if (myUser.bankItems.includes(id)) return send(ws, { type: 'error', message: 'That is already in your bank.' });
        if (myUser.outfit === id || myUser.pet === id || myUser.accessory === id) return send(ws, { type: 'error', message: 'Take it off / put it away first — then bank it.' });
        myUser.bankItems.push(id);
      } else if (m.action === 'withdraw') {
        if (!myUser.bankItems.includes(id)) return send(ws, { type: 'error', message: 'That is not in your bank.' });
        myUser.bankItems = myUser.bankItems.filter(x => x !== id);
      } else return;
      saveDb(); personalState(me);
      return;
    }
    if (m.type === 'walkTo') {
      // Tap-to-walk (lobby only): the knight strolls to a spot in the ring
      // band — never into the pit itself. Position rides the players list.
      if (myClient.duelId) return;
      let x = Number(m.x), z = Number(m.z);
      if (!isFinite(x) || !isFinite(z)) return;
      let r = Math.hypot(x, z);
      if (r < 0.001) { x = 0; z = 10.2; r = 10.2; }
      const rc = Math.min(10.6, Math.max(4.9, r));
      myClient.walk = { x: Math.round(x / r * rc * 100) / 100, z: Math.round(z / r * rc * 100) / 100 };
      broadcastPlayers();
      return;
    }
    if (m.type === 'exploreStart') {
      ensureFields(myUser);
      if (myClient.duelId) return send(ws, { type: 'error', message: 'Finish your duel first.' });
      if (myUser.exploreDone) return send(ws, { type: 'error', message: 'Your chest is still waiting — open it first!' });
      if (myUser.exploreStep > 0) return send(ws, { type: 'error', message: 'You are already in the tunnel.' });
      myUser.exploreStep = 1; saveDb(); personalState(me);
      sysChat(`🗺️ ${me} slipped into the tunnel under the arena…`);
      return;
    }
    if (m.type === 'exploreFight') {
      ensureFields(myUser);
      if (myClient.duelId) return send(ws, { type: 'error', message: 'You are already in a duel.' });
      const step = myUser.exploreStep;
      if (!step || step < 1 || step > 3) return send(ws, { type: 'error', message: 'Hit Go Explore first.' });
      const botDef = EXPLORE_BOTS[step - 1];
      if (botState[botDef.id].duelId) return send(ws, { type: 'error', message: `${botDef.name} is busy — a second.` });
      startDuel(me, botDef.name, 0, { explore: step });
      return;
    }
    if (m.type === 'exploreAbandon') {
      ensureFields(myUser);
      if (myClient.duelId) return send(ws, { type: 'error', message: 'You are in a duel — forfeit to leave the tunnel.' });
      myUser.exploreStep = 0; saveDb(); personalState(me);
      return;
    }
    if (m.type === 'exploreChest') {
      ensureFields(myUser);
      if (!myUser.exploreDone) return send(ws, { type: 'error', message: 'No chest is waiting — clear all 3 tunnel fights first.' });
      myUser.exploreDone = false; myUser.scrolls += 1; saveDb();
      send(ws, { type: 'chestOpened', scrolls: myUser.scrolls });
      personalState(me);
      sysChat(`🎁 ${me} opened the tunnel chest and found a reward scroll!`);
      return;
    }
    if (m.type === 'openScroll') {
      ensureFields(myUser);
      if (myUser.scrolls < 1) return send(ws, { type: 'error', message: 'No reward scrolls — clear the tunnel to earn one.' });
      myUser.scrolls -= 1;
      const reward = rollClueReward(myUser);
      saveDb();
      send(ws, { type: 'scrollReward', reward });
      personalState(me); broadcastPlayers();
      if (reward.kind !== 'gold') sysChat(`⭐ ${me} opened a reward scroll and found: ${reward.name}!`);
      return;
    }
    if (m.type === 'duelRun') {
      const d = myClient.duelId && duels.get(myClient.duelId);
      if (d && !d.settled) {
        let x = Number(m.x), z = Number(m.z);
        if (isFinite(x) && isFinite(z)) {
          const rr = Math.hypot(x, z); if (rr > PIT_R) { x = x / rr * PIT_R; z = z / rr * PIT_R; }
          d.mt[d.a === me ? 'a' : 'b'] = { x: Math.round(x * 1000) / 1000, z: Math.round(z * 1000) / 1000, until: Date.now() + 2600 };
        }
      }
      return;
    }
    if (m.type === 'quickMatch') {
      const stake = Number(m.stake);
      if (myClient.duelId) return send(ws, { type: 'error', message: 'You are already in a duel.' });
      if (!STAKES.includes(stake)) return send(ws, { type: 'error', message: 'Pick a valid stake.' });
      if (myUser.gold < stake) return send(ws, { type: 'error', message: "You can't afford that stake." });
      clearQuick(me);
      const freeHumans = [];
      for (const [n, c] of clients) { if (n !== me && !c.duelId) { const ou = db.users[n]; if (ou && ou.gold >= stake && !pending.has(n)) freeHumans.push(n); } }
      if (freeHumans.length) {
        const target = freeHumans[Math.floor(Math.random() * freeHumans.length)];
        pending.set(target, { from: me, stake, expires: Date.now() + 30000 });
        send(clients.get(target).ws, { type: 'challengeIncoming', from: me, stake });
        send(ws, { type: 'quickMatchSent', target, stake });
      } else {
        send(ws, { type: 'quickMatchWait' });
      }
      quickTimers.set(me, setTimeout(() => quickBackfill(me), 10000));
      return;
    }
    if (m.type === 'challenge') {
      clearQuick(me); // a hand-picked challenge replaces any quick match
      const target = String(m.target || '');
      const stake = Number(m.stake);
      if (myClient.duelId) return send(ws, { type: 'error', message: 'You are already in a duel.' });
      const botDef = botByName(target) || botById(target);
      if (botDef) {
        if (botDef.exploreOnly) return send(ws, { type: 'error', message: `${botDef.name} only lurks in the tunnel — hit 🗺️ Go Explore to meet it.` });
        if (botDef.campaignOnly) return send(ws, { type: 'error', message: 'The Arena Champion only fights in a Campaign final — enter in the 🏆 Campaign tab.' });
        if (stake !== botDef.stake) return send(ws, { type: 'error', message: `${botDef.name} fights for ${botDef.stake} gp.` });
        if (myUser.gold < stake) return send(ws, { type: 'error', message: "You can't afford that stake." });
        if (botState[botDef.id].duelId) { const bd = duels.get(botState[botDef.id].duelId); const opp = bd ? (bd.a === botDef.name ? bd.b : bd.a) : 'someone'; return send(ws, { type: 'error', message: `${botDef.name} is fighting ${opp} right now — they'll be free in a few seconds.` }); }
        // First-ever bot fight vs Pip is a free PRACTICE duel (fix plan B1):
        // no stake, gentle scripted moves, exchanges wait for the learner's taps.
        if (botDef.id === 'pip' && !myUser.practiced) { myUser.practiced = true; saveDb(); startDuel(me, botDef.name, stake, { practice: true }); return; }
        startDuel(me, botDef.name, stake);
        return;
      }
      if (!STAKES.includes(stake)) return send(ws, { type: 'error', message: 'Pick a valid stake.' });
      if (myUser.gold < stake) return send(ws, { type: 'error', message: "You can't afford that stake." });
      if (target === me) return send(ws, { type: 'error', message: "You can't duel yourself." });
      const tc = clients.get(target); const tu = db.users[target];
      if (!tc || !tu) return send(ws, { type: 'error', message: 'That player is not online.' });
      if (tu.gold < stake) return send(ws, { type: 'error', message: `${target} can't afford ${stake} gp.` });
      if (tc.duelId) {
        // Busy target: QUEUE the challenge (Derek's rule) — the challenger is
        // told who they're fighting, and the offer lands when the fight ends.
        const td = duels.get(tc.duelId);
        const vsName = td ? (td.a === target ? td.b : td.a) : 'someone';
        const q = challengeQueue.get(target) || [];
        if (q.some(e => e.from === me)) return send(ws, { type: 'error', message: `You already have a challenge queued for ${target}.` });
        if (q.length >= 3) return send(ws, { type: 'error', message: `${target} already has 3 challenges waiting — try again shortly.` });
        q.push({ from: me, stake, expires: Date.now() + 90000 });
        challengeQueue.set(target, q);
        send(ws, { type: 'challengeQueued', target, stake, vs: vsName });
        personalState(me);
        return;
      }
      pending.set(target, { from: me, stake, expires: Date.now() + 30000 });
      send(tc.ws, { type: 'challengeIncoming', from: me, stake });
      send(ws, { type: 'challengeSent', to: target, stake });
      return;
    }
    if (m.type === 'challengeCancel') {
      const target = String(m.target || '');
      const q = challengeQueue.get(target);
      if (q) {
        const kept = q.filter(e => e.from !== me);
        if (kept.length) challengeQueue.set(target, kept); else challengeQueue.delete(target);
        send(ws, { type: 'challengeQueueCancelled', target });
        personalState(me);
      }
      return;
    }
    if (m.type === 'accept') {
      const p = pending.get(me);
      if (!p || p.from !== m.from || Date.now() > p.expires) return send(ws, { type: 'error', message: 'That challenge expired.' });
      pending.delete(me);
      const fromUser = db.users[p.from]; const fromClient = clients.get(p.from);
      if (!fromClient || !fromUser) return send(ws, { type: 'error', message: 'Challenger went offline.' });
      if (fromUser.gold < p.stake || myUser.gold < p.stake) return send(ws, { type: 'error', message: 'Someone can no longer afford the stake.' });
      if (fromClient.duelId || myClient.duelId) return send(ws, { type: 'error', message: 'Someone is already in a duel.' });
      startDuel(p.from, me, p.stake);
      return;
    }
    if (m.type === 'decline') {
      const p = pending.get(me);
      if (p && p.from === m.from) {
        pending.delete(me);
        const fc = clients.get(p.from);
        if (fc) send(fc.ws, { type: 'error', message: `${me} declined your challenge.` });
      }
      deliverQueued(me); // a declined offer makes room for the next queued one
      return;
    }
    if (m.type === 'campaignStart') {
      campaignOf(myUser);
      if (myClient.duelId) return send(ws, { type: 'error', message: 'Finish your duel first.' });
      if (myUser.campaign.active) return send(ws, { type: 'error', message: 'You already have a campaign run going.' });
      myUser.campaign = { active: true, round: 1, won: [] };
      saveDbNow(); personalState(me);
      send(ws, { type: 'campaign', campaign: campaignOf(myUser), trophies: myUser.trophies || 0 });
      sysChat(`🏆 ${me} entered a Campaign tournament! Round 1: ${botById(CAMPAIGN_ROUNDS[0].botId).name}.`);
      return;
    }
    if (m.type === 'campaignAbandon') {
      campaignOf(myUser);
      if (myClient.duelId) return send(ws, { type: 'error', message: 'You are in a duel — forfeit to end the run.' });
      if (!myUser.campaign.active) return send(ws, { type: 'error', message: 'No campaign run to abandon.' });
      myUser.campaign.active = false; myUser.campaign.round = 0; // prizes already won stay in gold
      saveDbNow(); personalState(me);
      send(ws, { type: 'campaign', campaign: campaignOf(myUser), trophies: myUser.trophies || 0 });
      return;
    }
    if (m.type === 'campaignFight') {
      campaignOf(myUser);
      if (!myUser.campaign.active) return send(ws, { type: 'error', message: 'Enter the tournament first.' });
      if (myClient.duelId) return send(ws, { type: 'error', message: 'You are already in a duel.' });
      const round = myUser.campaign.round;
      const def = CAMPAIGN_ROUNDS[round - 1];
      if (!def) return send(ws, { type: 'error', message: 'That run is finished.' });
      const botDef = botById(def.botId);
      if (botState[botDef.id].duelId) return send(ws, { type: 'error', message: `${botDef.name} is already fighting.` });
      startDuel(me, botDef.name, 0, { campaign: true, round, prize: def.prize });
      return;
    }
    if (m.type === 'duelMove') {
      if (!MOVES.includes(m.move)) return;
      const d = myClient.duelId && duels.get(myClient.duelId);
      if (!d || d.phase !== 'fight') return;
      if (d.a === me) d.locked.a = m.move;
      else if (d.b === me) d.locked.b = m.move;
      return;
    }
    if (m.type === 'forfeit') {
      const d = myClient.duelId && duels.get(myClient.duelId);
      if (d) settleDuel(d, d.a === me ? d.b : d.a, 'forfeit');
      return;
    }
  });
  ws.on('close', () => {
    if (!me) return;
    const c = clients.get(me);
    clients.delete(me);
    pending.delete(me);
    clearQuick(me);
    challengeQueue.delete(me);
    for (const [t, q] of challengeQueue) { const kept = q.filter(e => e.from !== me); if (kept.length) challengeQueue.set(t, kept); else challengeQueue.delete(t); }
    if (c && c.duelId) {
      const d = duels.get(c.duelId);
      if (d) settleDuel(d, d.a === me ? d.b : d.a, 'forfeit');
    }
    broadcastPlayers();
    sysChat(`${me} left the lobby.`);
  });
});

server.listen(PORT, () => console.log(`Duelgame Online listening on :${PORT} (db: ${DB_PATH})`));
module.exports = { _settleById, _mintFbTokenForTest, duels, db, resolveExchange, knockbackFor, applyWalkForward, HOME_GAP, REACH_GAP, PIT_R, stepDuelMovement, BOTS, OUTFITS, CAMPAIGN_ROUNDS, campaignInfo, fbConfigured, FB_REDIRECT_URI, netOf, enforceNetGear, PETS, ACCESSORIES, EXPLORE_BOTS, highscores, rollClueReward };
