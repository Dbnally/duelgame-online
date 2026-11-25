'use strict';
// Duelgame Online — real-player online version of the 3-Tick Duel Arena.
// Server-authoritative: gold, stakes, escrow, combat ticks and records live here.
// Combat rules are EXACTLY the duelgame's (see game.ts in the 3-Tick Duel Arena):
//   Attack beats Strength (4 dmg, "SLASH!"), Strength beats Defence (6 dmg, "SMASH!"),
//   Defence beats Attack (2 dmg, "BLOCKED!"). Same move: clash 1/1 except
//   defence/defence = 0/0 "GUARDED". MAX_HP 30. 3 ticks/sec, exchange every 3 ticks.
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
  { id: 'peasant', name: 'Peasant Rags', price: 0,    blurb: 'What you walked in wearing.', colors: { armor: '#9a8a72', trim: '#6b5d49', plume: '#b0a58e', shield: '#8a7a5f' } },
  { id: 'bronze',  name: 'Bronze Trim',  price: 75,   blurb: 'First real metal. Smells like victory.', colors: { armor: '#a8763e', trim: '#6e4a24', plume: '#d99a4e', shield: '#8a5c2e' } },
  { id: 'steel',   name: 'Steel Plate',  price: 200,  blurb: 'Polished plate that turns heads at the gate.', colors: { armor: '#9fb2c8', trim: '#5f7189', plume: '#dfe9f5', shield: '#7d93ad' } },
  { id: 'shadow',  name: 'Shadow Cloak', price: 350,  blurb: 'Dark leathers for fighters who strike first.', colors: { armor: '#3d4457', trim: '#232833', plume: '#6b7690', shield: '#2e3442' } },
  { id: 'mithril', name: 'Mithril Shine',price: 450,  blurb: 'Blue-purple sheen, light as cloth, hard as a vault door.', colors: { armor: '#7d7fd6', trim: '#4a4a9e', plume: '#b9b9f2', shield: '#5f5fb8' } },
  { id: 'dragon',  name: 'Dragon Red',   price: 900,  blurb: 'Red as a hitsplat. The pit goes quiet when it walks in.', colors: { armor: '#b03030', trim: '#6e1d1d', plume: '#e05a4e', shield: '#8c2626' } },
  { id: 'gilded',  name: 'Gilded King',  price: 2000, blurb: "Solid gold plate. You don't wear it — it announces you.", colors: { armor: '#e3b93c', trim: '#9e7d1c', plume: '#f7dd7a', shield: '#c9a227' } },
];
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
    return { aDmg: 1, bDmg: 1, word: 'CLASH!', winner: 'clash' };
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
const botByName = name => BOTS.find(b => b.name === name);
const botById = id => BOTS.find(b => b.id === id);
// Live bot state (duel occupancy + record for the lobby list)
const botState = {}; BOTS.forEach(b => botState[b.id] = { duelId: null, wins: 0, losses: 0 });

function pickBotMove(bot, playerHistory) {
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
  return { salt, hash: hashPw(password, salt), gold: 50, owned: ['peasant'], outfit: 'peasant', wins: 0, losses: 0, trophies: 0, campaign: { active: false, round: 0, won: [] } };
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
  return { username: name, gold: u ? u.gold : 0, wins: u ? u.wins : 0, losses: u ? u.losses : 0, outfit: o.id, colors: o.colors, inDuel: !!(c && c.duelId) };
}
function playerList() {
  const list = [];
  for (const name of clients.keys()) list.push(publicPlayer(name));
  for (const b of BOTS) list.push({ username: b.name, isBot: true, botId: b.id, title: b.title, stake: b.stake, taunt: b.taunt, gold: null, wins: botState[b.id].wins, losses: botState[b.id].losses, outfit: null, colors: b.colors, inDuel: !!botState[b.id].duelId, campaignOnly: !!b.campaignOnly });
  return list;
}
function broadcastPlayers() { const l = playerList(); broadcast({ type: 'players', players: l }); }
function personalState(name) {
  const u = db.users[name]; if (!u) return;
  const c = clients.get(name);
  send(c && c.ws, { type: 'state', gold: u.gold, wins: u.wins, losses: u.losses, owned: u.owned, outfit: u.outfit, trophies: u.trophies || 0, campaign: campaignOf(u) });
}
function sysChat(text) { broadcast({ type: 'chat', from: '⚔️ Duelgame', text, kind: 'system' }); }

// ---------- Duels ----------
function startDuel(nameA, nameB, stake, opts) {
  opts = opts || {};
  const isCampaign = !!opts.campaign;
  const botDef = botByName(nameB);
  const isBotDuel = !!botDef;
  const ua = db.users[nameA];
  let ub = null;
  if (isCampaign) { stake = 0; } // campaign duels take NO stake — prize only, paid once at settle
  else {
    ua.gold -= stake;
    if (!isBotDuel) { ub = db.users[nameB]; ub.gold -= stake; }
  }
  saveDb();
  const id = 'duel' + (duelSeq++);
  const duel = {
    id, a: nameA, b: nameB, stake, pot: isCampaign ? 0 : stake * 2, isBotDuel, botId: isBotDuel ? botDef.id : null,
    campaign: isCampaign, round: isCampaign ? opts.round : 0, prize: isCampaign ? opts.prize : 0,
    hp: { a: MAX_HP, b: MAX_HP },
    offBalance: { a: false, b: false }, // took >=2 dmg last exchange: next win glances
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
  broadcast({ type: 'duelStart', duelId: id, a: nameA, b: nameB, stake, pot: duel.pot, hpA: MAX_HP, hpB: MAX_HP, colorsA: colorsOf(nameA), colorsB: colorsOf(nameB), homeGap: HOME_GAP, reachGap: REACH_GAP, dispA: 0, dispB: 0, campaign: isCampaign, round: duel.round, prize: duel.prize });
  if (isCampaign) sysChat(`🏆 Campaign Round ${duel.round}: ${nameA} vs ${nameB} — ${duel.prize} gp prize!`);
  else sysChat(`${nameA} vs ${nameB} — ${stake} gp each in the pit!`);
  let count = 3;
  broadcast({ type: 'duelCountdown', duelId: id, n: count });
  duel.timer = setInterval(() => {
    if (duel.settled) return;
    if (duel.phase === 'countdown') {
      count--;
      if (count > 0) { broadcast({ type: 'duelCountdown', duelId: id, n: count }); return; }
      duel.phase = 'fight';
      broadcast({ type: 'duelCountdown', duelId: id, n: 0 });
      return;
    }
    duel.tick++;
    broadcast({ type: 'duelTick', duelId: id, tick: duel.tick, tickInExchange: ((duel.tick - 1) % 3) + 1 });
    if (duel.tick % 3 !== 0) return;
    if (duel.isBotDuel) duel.locked.b = pickBotMove(botDef, duel.historyA);
    const moveA = duel.locked.a || duel.last.a;
    const moveB = duel.locked.b || duel.last.b;
    duel.last.a = moveA; duel.last.b = moveB;
    duel.historyA.push(moveA);
    duel.locked.a = null; if (!duel.isBotDuel) duel.locked.b = null;
    // Walk-forward happened during this cycle: displaced fighters close back into reach.
    const walked = applyWalkForward(duel.disp);
    const r = resolveExchange(moveA, moveB);
    // Glancing hit: an off-balance fighter who WINS the triangle lands it weakly.
    // Winner never changes; clash/GUARDED never glance. offBalance is consumed either way.
    let glance = null;
    if (r.winner === 'a' && duel.offBalance.a) { glance = 'a'; r.bDmg = Math.max(1, r.bDmg - 1); }
    else if (r.winner === 'b' && duel.offBalance.b) { glance = 'b'; r.aDmg = Math.max(1, r.aDmg - 1); }
    const wasOff = { a: duel.offBalance.a, b: duel.offBalance.b };
    duel.hp.a -= r.aDmg; duel.hp.b -= r.bDmg;
    // Knockback from THIS exchange's damage; offBalance re-sets from damage taken now.
    const kbA = knockbackFor(r.aDmg), kbB = knockbackFor(r.bDmg);
    duel.disp.a = Math.round((duel.disp.a + kbA) * 1000) / 1000;
    duel.disp.b = Math.round((duel.disp.b + kbB) * 1000) / 1000;
    duel.offBalance.a = r.aDmg >= 2;
    duel.offBalance.b = r.bDmg >= 2;
    broadcast({ type: 'duelExchange', duelId: id, a: duel.a, b: duel.b, moveA, moveB, aDmg: r.aDmg, bDmg: r.bDmg, word: r.word, winnerSide: r.winner, hpA: Math.max(0, duel.hp.a), hpB: Math.max(0, duel.hp.b), kbA, kbB, glance, glanceA: glance === 'a', glanceB: glance === 'b', dispA: duel.disp.a, dispB: duel.disp.b, walkedA: walked.a, walkedB: walked.b, offBalanceA: wasOff.a, offBalanceB: wasOff.b });
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
  if (duel.timer) clearInterval(duel.timer);
  const loserName = winnerName === duel.a ? duel.b : duel.a;
  const winnerBot = botByName(winnerName), loserBot = botByName(loserName);
  let prizeWon = 0, trophyWon = false;
  if (duel.campaign) {
    // Campaign settle: NO pot exists. Human is duel.a. Win = minted prize paid
    // exactly once (this function is guarded by duel.settled) + run advances;
    // clearing round 4 also mints a trophy. Loss = run ends, prizes kept.
    const human = db.users[duel.a];
    if (human) {
      campaignOf(human); // ensure campaign/trophies fields exist
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
  } else {
    if (!winnerBot) { const w = db.users[winnerName]; if (w) { w.gold += duel.pot; w.wins += 1; } }
    else botState[winnerBot.id].wins += 1;
    if (!loserBot) { const l = db.users[loserName]; if (l) l.losses += 1; }
    else botState[loserBot.id].losses += 1;
  }
  saveDbNow();
  const ca = clients.get(duel.a); if (ca && ca.duelId === duel.id) ca.duelId = null;
  if (!duel.isBotDuel) { const cb = clients.get(duel.b); if (cb && cb.duelId === duel.id) cb.duelId = null; }
  if (duel.botId && botState[duel.botId].duelId === duel.id) botState[duel.botId].duelId = null;
  duels.delete(duel.id);
  broadcast({ type: 'duelEnd', duelId: duel.id, winner: winnerName, loser: loserName, pot: duel.pot, reason, campaign: !!duel.campaign, round: duel.round || 0, prize: prizeWon, trophy: trophyWon });
  if (duel.campaign) sysChat(prizeWon ? `🏆 ${winnerName} cleared Campaign Round ${duel.round} and won ${prizeWon} gp${trophyWon ? ' + a TROPHY!' : ''}` : `🏆 ${loserName}'s campaign run ended in Round ${duel.round} — ${winnerName} holds the pit.`);
  else sysChat(`🏆 ${winnerName} beat ${loserName} and took the ${duel.pot} gp pot!`);
  if (!winnerBot) personalState(winnerName);
  if (!loserBot) personalState(loserName);
  broadcastPlayers();
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
    const u = db.users[name];
    send(ws, { type: 'authOk', username: name, gold: u.gold, wins: u.wins, losses: u.losses, owned: u.owned, outfit: u.outfit, outfits: OUTFITS, bots: BOTS, players: playerList(), trophies: u.trophies || 0, campaign: campaignOf(u), campaignRounds: campaignInfo() });
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
    if (m.type === 'refill') {
      if (myUser.gold >= MIN_STAKE) return send(ws, { type: 'error', message: 'Refill refused: you still have 5+ gp. Broke is under 5 gp.' });
      myUser.gold += 50; saveDb();
      send(ws, { type: 'refillOk', gold: myUser.gold });
      personalState(me);
      return;
    }
    if (m.type === 'buy') {
      const o = outfitById(m.outfitId);
      if (myUser.owned.includes(o.id)) { myUser.outfit = o.id; saveDb(); personalState(me); broadcastPlayers(); return; }
      if (myUser.gold < o.price) return send(ws, { type: 'error', message: 'Not enough gold for that outfit.' });
      myUser.gold -= o.price; myUser.owned.push(o.id); myUser.outfit = o.id; saveDb();
      personalState(me); broadcastPlayers();
      return;
    }
    if (m.type === 'equip') {
      const o = outfitById(m.outfitId);
      if (!myUser.owned.includes(o.id)) return send(ws, { type: 'error', message: "You don't own that outfit." });
      myUser.outfit = o.id; saveDb();
      personalState(me); broadcastPlayers();
      return;
    }
    if (m.type === 'challenge') {
      const target = String(m.target || '');
      const stake = Number(m.stake);
      if (myClient.duelId) return send(ws, { type: 'error', message: 'You are already in a duel.' });
      const botDef = botByName(target) || botById(target);
      if (botDef) {
        if (botDef.campaignOnly) return send(ws, { type: 'error', message: 'The Arena Champion only fights in a Campaign final — enter in the 🏆 Campaign tab.' });
        if (stake !== botDef.stake) return send(ws, { type: 'error', message: `${botDef.name} fights for ${botDef.stake} gp.` });
        if (myUser.gold < stake) return send(ws, { type: 'error', message: "You can't afford that stake." });
        if (botState[botDef.id].duelId) return send(ws, { type: 'error', message: `${botDef.name} is already fighting.` });
        startDuel(me, botDef.name, stake);
        return;
      }
      if (!STAKES.includes(stake)) return send(ws, { type: 'error', message: 'Pick a valid stake.' });
      if (myUser.gold < stake) return send(ws, { type: 'error', message: "You can't afford that stake." });
      if (target === me) return send(ws, { type: 'error', message: "You can't duel yourself." });
      const tc = clients.get(target); const tu = db.users[target];
      if (!tc || !tu) return send(ws, { type: 'error', message: 'That player is not online.' });
      if (tc.duelId) return send(ws, { type: 'error', message: 'That player is already in a duel.' });
      if (tu.gold < stake) return send(ws, { type: 'error', message: `${target} can't afford ${stake} gp.` });
      pending.set(target, { from: me, stake, expires: Date.now() + 30000 });
      send(tc.ws, { type: 'challengeIncoming', from: me, stake });
      send(ws, { type: 'challengeSent', to: target, stake });
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
    if (c && c.duelId) {
      const d = duels.get(c.duelId);
      if (d) settleDuel(d, d.a === me ? d.b : d.a, 'forfeit');
    }
    broadcastPlayers();
    sysChat(`${me} left the lobby.`);
  });
});

server.listen(PORT, () => console.log(`Duelgame Online listening on :${PORT} (db: ${DB_PATH})`));
module.exports = { _settleById, _mintFbTokenForTest, duels, db, resolveExchange, knockbackFor, applyWalkForward, HOME_GAP, REACH_GAP, BOTS, OUTFITS, CAMPAIGN_ROUNDS, campaignInfo, fbConfigured, FB_REDIRECT_URI };
