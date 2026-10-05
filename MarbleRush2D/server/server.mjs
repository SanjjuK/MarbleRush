// server.mjs: MarbleRush 2D, server-side. One clock, one pool, one race for
// everybody watching.
//
//   node MarbleRush2D/server/server.mjs          (then open http://localhost:8090/MarbleRush2D/)
//   MR_PORT=8000 node MarbleRush2D/server/server.mjs
//
// No dependencies: node:http, node:crypto, node:fs. Live updates go out as
// Server-Sent Events, which every browser speaks natively.
//
// WHO DECIDES WHAT
//
//   The server owns the round: the lobby clock, the pool, every bet, the
//   race, the result and the money. Browsers only draw.
//
//   Each round has TWO seeds. The COURSE seed is public from the moment the
//   round opens, so everyone can see the track they are betting on. The RACE
//   seed (grid draw, and with it everything that happens) is secret: the server
//   publishes SHA-256 of it when betting opens, runs the whole race straight
//   away, and reveals the seed only when the gates open, when betting is shut
//   and knowing the result is worth nothing. Every browser then replays the
//   race from the two seeds on the shared clock; the engine is deterministic,
//   so they all see the race the server ran, and anyone can check the reveal
//   against the hash. The server also sends each marble's position once a
//   second, and a browser that has drifted snaps back to it.
//
// Money is demo money, kept per player id in data/wallets.json.

import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeRng } from '../../js/rng.js';
import { MARBLE_DATA } from '../../js/racers.js';
import { PLACE_SHARES, RAKE, MIN_BET, STARTING_BALANCE } from '../../js/betting.js';
import { buildTrack } from '../js/track2d.js';
import { Engine2D, SIM_DT } from '../js/engine2d.js';
import { buildPrint } from '../js/detcheck.js';

// How this server races, as a hash (see detcheck.js). Sent to every browser.
const PRINT = buildPrint();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');            // project root: serves /MarbleRush2D and /js
const DATA = process.env.MR_DATA || path.join(HERE, 'data');
const PORT = +(process.env.MR_PORT || 8090);

/** Round timing, seconds. */
export const T = {
  lobby: +(process.env.MR_LOBBY || 30),     // betting open
  countdown: 3,
  runout: 2.5,                               // after the last marble, before results
  results: 9,                                // results on screen before the next round
  maxRace: 480,
  // Course length in blocks. Only for tests: a real round uses the game's
  // own length, and every browser builds the course with the same number.
  blocks: process.env.MR_BLOCKS ? +process.env.MR_BLOCKS : undefined,
};

const K = MARBLE_DATA.length;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const now = () => Date.now();

/* ------------------------------- wallets -------------------------------- */

const wallets = new Map();        // pid -> { name, balance, history[], stats }
let walletsDirty = false;

async function loadWallets() {
  try {
    const raw = JSON.parse(await readFile(path.join(DATA, 'wallets.json'), 'utf8'));
    for (const [k, v] of Object.entries(raw)) wallets.set(k, v);
  } catch { /* first run */ }
}
async function saveWallets() {
  if (!walletsDirty) return;
  walletsDirty = false;
  await mkdir(DATA, { recursive: true });
  await writeFile(path.join(DATA, 'wallets.json'), JSON.stringify(Object.fromEntries(wallets)));
}
setInterval(() => saveWallets().catch(e => console.error('[wallets]', e)), 3000);

const PID = /^[a-z0-9]{8,40}$/i;
function wallet(pid) {
  let w = wallets.get(pid);
  if (!w) {
    // Other people see a short tag, never the id (the id is the key to
    // the wallet).
    w = { name: 'player·' + createHash('sha256').update(pid).digest('hex').slice(0, 4), balance: STARTING_BALANCE, history: [],
          stats: { races: 0, wins: 0, wagered: 0, returned: 0, best: 0, streak: 0, bestStreak: 0 } };
    wallets.set(pid, w);
    walletsDirty = true;
  }
  return w;
}

/* -------------------------------- bots ---------------------------------- */

const BOT_HANDLES = [
  'degen.eth', 'marblemaxi', '0x9f…4c21', 'rollie.eth', 'sats_only',
  'vault_ape', '0x3b…88af', 'chalkline', 'lp_sniper', 'tungsten.eth',
  'chuteclub', '0xd2…1e07', 'roundabout', 'basedbets', 'nonce.eth',
  'slipstream', '0x71…9b40', 'oracle_tom', 'gwei_wizard', 'banked.eth',
];

/** The house's other backers for a round, and when each one bets. */
function makeBots(rng) {
  const count = rng.int(7, 11);
  const appetite = MARBLE_DATA.map(() => 0.35 + rng() * 1.5);
  const total = appetite.reduce((a, b) => a + b, 0);
  const handles = BOT_HANDLES.slice();
  const bots = [];
  for (let i = 0; i < count; i++) {
    const handle = handles.splice(rng.int(0, handles.length - 1), 1)[0];
    let r = rng() * total, idx = 0;
    for (let k = 0; k < K; k++) { r -= appetite[k]; if (r <= 0) { idx = k; break; } }
    const whale = rng() < 0.14;
    const amount = whale ? Math.round(rng.range(150, 420) / 10) * 10 : Math.round(rng.range(10, 110) / 5) * 5;
    // Spread through the first 80% of the lobby, so the board fills while
    // people watch it.
    bots.push({ handle, marble: idx, amount, whale, at: rng.range(0.4, T.lobby * 0.8) });
  }
  return bots.sort((a, b) => a.at - b.at);
}

/* -------------------------------- round --------------------------------- */

let round = null;
let roundNo = 0;
const clients = new Map();        // res -> { pid }

function leastBacked(r) {
  let best = 0;
  for (let i = 1; i < K; i++) {
    if (r.pools[i] < r.pools[best] || (r.pools[i] === r.pools[best] && r.backers[i] < r.backers[best])) best = i;
  }
  return best;
}

function addBet(r, bet) {
  r.bets.push(bet);
  r.pools[bet.marble] += bet.amount;
  r.backers[bet.marble] += 1;
}

/** Open a round: seeds, commitment, the race run in full, the bots queued. */
export function openRound() {
  roundNo += 1;
  const courseSeed = randomBytes(8).toString('hex');
  const raceSeed = randomBytes(16).toString('hex');
  const track = buildTrack(makeRng(courseSeed), T.blocks ? { count: T.blocks } : {});
  const engine = new Engine2D({ track, rng: makeRng(raceSeed), racers: MARBLE_DATA });

  // The authoritative run, plus a position every second for drift checks.
  const t0 = performance.now();
  engine.settle();
  const lanes = engine.marbles.map(m => m.lane);
  const sync = [];
  engine.openGate();
  const order = [];
  let guard = Math.ceil(T.maxRace / SIM_DT);
  while (guard-- > 0 && !engine.allFinished) {
    engine.step(true);
    for (const m of engine.marbles) if (m.finished && !order.includes(m.index)) order.push(m.index);
    if (engine.tick % 240 === 0) sync.push(engine.marbles.map(m => [+m.x.toFixed(3), +m.y.toFixed(3)]));
  }
  const out = engine.marbles.filter(m => m.out).sort((a, b) => b.outTime - a.outTime).map(m => m.index);
  const result = {
    finishOrder: order.concat(out),
    eliminated: out,
    times: engine.marbles.map(m => +m.finishTime.toFixed(2)),
    time: +engine.time.toFixed(2),
    nudges: engine.nudges,
  };
  const ms = performance.now() - t0;

  const t = now();
  round = {
    id: roundNo, courseSeed, raceSeed, commitment: sha256(raceSeed),
    lanes, result, sync, layout: track.layout,
    phase: 'betting', opensAt: t, closesAt: t + T.lobby * 1000,
    raceAt: 0, resultAt: 0, nextAt: 0,
    pools: new Array(K).fill(0), backers: new Array(K).fill(0),
    bets: [], bots: makeBots(makeRng(raceSeed + ':bots')), ready: new Set(), settled: null,
  };
  console.log(`[round ${round.id}] open  course ${courseSeed}  commit ${round.commitment.slice(0, 16)}…  ` +
              `race ${result.time}s precomputed in ${ms.toFixed(0)}ms`);   // never the winner: logs get shared
  broadcast('round', publicRound());
}

/** Everything a browser may know right now. The race seed only once racing. */
function publicRound() {
  const r = round;
  const racing = r.phase === 'racing' || r.phase === 'results';
  return {
    id: r.id, phase: r.phase, courseSeed: r.courseSeed, commitment: r.commitment,
    lanes: r.lanes, layout: r.layout, blocks: T.blocks || null,
    opensAt: r.opensAt, closesAt: r.closesAt, raceAt: r.raceAt, resultAt: r.resultAt, nextAt: r.nextAt,
    raceSeed: racing ? r.raceSeed : null,
    pools: r.pools, backers: r.backers,
    bets: r.bets.map(b => ({ handle: b.handle, marble: b.marble, amount: b.amount, whale: b.whale, auto: b.auto, human: !!b.pid })),
    ready: r.ready.size, players: connectedPlayers().length,
    result: r.phase === 'results' ? r.result : null,
    lobbySeconds: T.lobby, now: now(),
  };
}

function connectedPlayers() {
  return [...new Set([...clients.values()].map(c => c.pid))];
}

/** Close the lobby: auto-bet the stragglers, then the countdown. */
function closeLobby() {
  const r = round;
  if (r.phase !== 'betting') return;
  // Bots that never got their money down take the fallback: minimum, on the
  // least backed marble, read live so a queue of them spreads out.
  for (const b of r.bots.splice(0)) {
    addBet(r, { handle: b.handle, marble: leastBacked(r), amount: MIN_BET, auto: true });
  }
  // So does every connected player without a bet: Sanjay's lobby rule.
  for (const pid of connectedPlayers()) {
    if (r.bets.some(b => b.pid === pid)) continue;
    const w = wallet(pid);
    if (w.balance < MIN_BET) continue;
    w.balance -= MIN_BET; w.stats.races += 1; w.stats.wagered += MIN_BET; walletsDirty = true;
    addBet(r, { pid, handle: w.name, marble: leastBacked(r), amount: MIN_BET, auto: true });
  }
  r.phase = 'countdown';
  r.raceAt = now() + T.countdown * 1000;
  r.resultAt = r.raceAt + (r.result.time + T.runout) * 1000;
  r.nextAt = r.resultAt + T.results * 1000;
  broadcast('round', publicRound());
}

/** Pay every backer. Shares of the net pool by finishing position. */
function settle() {
  const r = round;
  const order = r.result.finishOrder;
  const total = r.pools.reduce((a, b) => a + b, 0);
  const net = total * (1 - RAKE);
  const shares = PLACE_SHARES.map((s, i) => (order[i] !== undefined && r.pools[order[i]] > 0) ? s : 0);
  const live = shares.reduce((a, b) => a + b, 0);
  const per = {};
  for (const b of r.bets) {
    if (!b.pid) continue;
    const w = wallet(b.pid);
    const at = order.indexOf(b.marble);
    let payout = 0, place = -1, voided = false;
    if (live <= 0) { payout = b.amount; voided = true; }
    else if (at >= 0 && at < PLACE_SHARES.length && shares[at] > 0) {
      place = at;
      payout = (b.amount / r.pools[b.marble]) * net * (shares[at] / live);
    }
    const profit = payout - b.amount;
    w.balance += payout;
    if (payout > 0 && !voided) {
      w.stats.returned += payout;
      w.stats.best = Math.max(w.stats.best, profit);
      if (place === 0) { w.stats.wins += 1; w.stats.streak = Math.max(0, w.stats.streak) + 1; w.stats.bestStreak = Math.max(w.stats.bestStreak, w.stats.streak); }
    } else if (!voided) w.stats.streak = 0;
    w.history.unshift({ round: r.id, winner: order[0], backed: b.marble, stake: b.amount, payout, won: place === 0, place, void: voided, seed: r.raceSeed });
    if (w.history.length > 24) w.history.length = 24;
    per[b.pid] = { stake: b.amount, backed: b.marble, payout, profit, place, won: place === 0, void: voided, odds: payout / b.amount };
    walletsDirty = true;
  }
  r.settled = { per, totalPool: total, rake: total * RAKE, netPool: net };
}

/** The round clock. Runs every 100ms; cheap. */
function tick() {
  const r = round, t = now();
  if (!r) return;
  if (r.phase === 'betting') {
    let changed = false;
    while (r.bots.length && r.opensAt + r.bots[0].at * 1000 <= t) {
      const b = r.bots.shift();
      addBet(r, { handle: b.handle, marble: b.marble, amount: b.amount, whale: b.whale });
      changed = true;
    }
    if (changed) broadcast('pool', poolMsg());
    if (t >= r.closesAt) closeLobby();
  } else if (r.phase === 'countdown' && t >= r.raceAt) {
    r.phase = 'racing';
    broadcast('round', publicRound());
  } else if (r.phase === 'racing') {
    // A position check each second of race time.
    const s = Math.floor((t - r.raceAt) / 1000);
    if (s !== r.lastSync && s >= 1 && s <= r.sync.length) {
      r.lastSync = s;
      broadcast('sync', { id: r.id, second: s, pos: r.sync[s - 1] });
    }
    if (t >= r.resultAt) {
      settle();
      r.phase = 'results';
      broadcast('round', publicRound());
      for (const [res, c] of clients) send(res, 'settled', settledFor(c.pid));
    }
  } else if (r.phase === 'results' && t >= r.nextAt) {
    openRound();
  }
}

function settledFor(pid) {
  const r = round, w = wallet(pid);
  return { id: r.id, you: r.settled?.per[pid] || null, totalPool: r.settled?.totalPool, balance: w.balance,
           history: w.history, stats: w.stats, raceSeed: r.raceSeed, commitment: r.commitment };
}

const poolMsg = () => ({ id: round.id, pools: round.pools, backers: round.backers,
  bets: round.bets.map(b => ({ handle: b.handle, marble: b.marble, amount: b.amount, whale: b.whale, auto: b.auto, human: !!b.pid })),
  ready: round.ready.size, players: connectedPlayers().length, now: now() });

/* --------------------------------- SSE ---------------------------------- */

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event, data) {
  for (const res of clients.keys()) send(res, event, data);
}
setInterval(() => { for (const res of clients.keys()) res.write(': keep-alive\n\n'); }, 15000);

/* --------------------------------- HTTP --------------------------------- */

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.mp4': 'video/mp4' };
// Only the game and the shared modules are served. Nothing else in the
// project folder (backups, logs, the wallets file) is reachable.
const SERVED = ['MarbleRush2D/', 'js/'];

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let s = '';
  for await (const chunk of req) { s += chunk; if (s.length > 4096) throw new Error('too big'); }
  return s ? JSON.parse(s) : {};
}

async function api(req, res, url) {
  if (url.pathname === '/api/ping') return json(res, 200, { marblerush: true, now: now() });
  const pid = url.searchParams.get('pid') || req.headers['x-player'] || '';
  if (!PID.test(pid)) return json(res, 400, { error: 'bad player id' });

  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    clients.set(res, { pid });
    const w = wallet(pid);
    send(res, 'hello', { pid, name: w.name, print: PRINT, balance: w.balance, history: w.history, stats: w.stats, now: now(), timing: T });
    send(res, 'round', publicRound());
    if (round.phase === 'results') send(res, 'settled', settledFor(pid));
    broadcast('pool', poolMsg());
    req.on('close', () => { clients.delete(res); if (round) broadcast('pool', poolMsg()); });
    return;
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  const body = await readBody(req).catch(() => null);
  if (!body) return json(res, 400, { error: 'bad body' });
  const r = round, w = wallet(pid);

  if (url.pathname === '/api/bet') {
    const marble = body.marble | 0, amount = Math.round(+body.amount);
    if (r.phase !== 'betting') return json(res, 409, { error: 'betting is closed' });
    if (!(marble >= 0 && marble < K)) return json(res, 400, { error: 'no such marble' });
    if (!(amount >= MIN_BET) || amount > w.balance) return json(res, 400, { error: 'stake not allowed' });
    if (r.bets.some(b => b.pid === pid)) return json(res, 409, { error: 'already bet this round' });
    w.balance -= amount; w.stats.races += 1; w.stats.wagered += amount; walletsDirty = true;
    addBet(r, { pid, handle: w.name, marble, amount });
    broadcast('pool', poolMsg());
    return json(res, 200, { ok: true, balance: w.balance });
  }
  if (url.pathname === '/api/ready') {
    if (r.phase !== 'betting') return json(res, 409, { error: 'not in the lobby' });
    r.ready.add(pid);
    // Everyone connected is ready: no reason to hold the table.
    const players = connectedPlayers();
    if (players.length && players.every(p => r.ready.has(p) && r.bets.some(b => b.pid === p))) closeLobby();
    else broadcast('pool', poolMsg());
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/topup') {
    if (w.balance >= MIN_BET) return json(res, 409, { error: 'only when the wallet is empty' });
    w.balance += STARTING_BALANCE; walletsDirty = true;
    return json(res, 200, { ok: true, balance: w.balance });
  }
  return json(res, 404, { error: 'unknown endpoint' });
}

async function statics(req, res, url) {
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (rel === '' ) { res.writeHead(302, { location: '/MarbleRush2D/' }); return res.end(); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) || !SERVED.some(p => rel.startsWith(p)) || rel.includes('/server/')) {
    res.writeHead(404); return res.end('not found');
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
}

export async function start(port = PORT) {
  await loadWallets();
  openRound();
  setInterval(tick, 100);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const go = url.pathname.startsWith('/api/') ? api(req, res, url) : statics(req, res, url);
    go.catch(e => { console.error(e); if (!res.headersSent) json(res, 500, { error: 'server error' }); });
  });
  await new Promise(ok => server.listen(port, ok));
  console.log(`MarbleRush server on http://localhost:${port}/MarbleRush2D/`);
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) start();
