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
// Players sign in with a Solana wallet (auth.mjs); a wallet address is the
// player id. Signed-out visitors can watch but not bet. Money is still demo
// money, kept per address in data/wallets.json.

import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeRng } from '../../js/rng.js';
import { MARBLE_DATA } from '../../js/racers.js';
import { PLACE_SHARES, RAKE, MIN_BET, STARTING_BALANCE } from '../../js/betting.js';
import { race } from './racesim.mjs';
import { buildPrint } from '../js/detcheck.js';
import { createAuth, parseCookie, shortAddress } from './auth.mjs';
import { openChain, scrub } from './chain.mjs';
import { CODE_FILES, codeHash, gitRev } from './codeversion.mjs';

// How this server races, as a hash (see detcheck.js). Sent to every browser.
const PRINT = buildPrint();
let CODE = { hash: '', rev: 'nogit', files: CODE_FILES };      // filled in at start: the hash of the race code as it was when this server began

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

const wallets = new Map();        // address -> { name, balance, history[], stats }
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

const auth = createAuth({ dir: DATA });
let chain = null;
const balanceCache = new Map();    // pid+token -> { t, v }: one RPC read per second per wallet at most
const SCHEDULE = () => path.join(DATA, 'schedule.json');                 // the Solana side; null until tools/chain-setup.mjs has run
setInterval(() => auth.save().catch(e => console.error('[sessions]', e)), 3000);

function wallet(pid) {
  let w = wallets.get(pid);
  if (!w) {
    // Other players see the short form of the address, as on a block explorer.
    w = { name: shortAddress(pid), balance: STARTING_BALANCE, history: [],
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
function makeBots(rng, scale = 1, budget = Infinity) {
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
    const base = whale ? Math.round(rng.range(150, 420) / 10) * 10 : Math.round(rng.range(10, 110) / 5) * 5;
    const amount = Math.max(1e-6, Math.round(base * scale * 100) / 100);   // a USDC round has cents-sized house bets, a RUSH round tens
    // Spread through the first 80% of the lobby, so the board fills while
    // people watch it.
    bots.push({ handle, marble: idx, amount, whale, at: rng.range(0.4, T.lobby * 0.8) });
  }
  // The house's exposure is capped: its stakes are the only money in a pool that is not a player's,
  // and the vault pays winners out of it.
  const sum = bots.reduce((a, b) => a + b.amount, 0);
  if (sum > budget) for (const b of bots) b.amount = Math.max(1e-6, Math.round(b.amount * (budget / sum) * 100) / 100);
  return bots.sort((a, b) => a.at - b.at);
}

/* -------------------------------- round --------------------------------- */

// A TABLE is one independent round loop with its own pool: its round, its lobby, its players.
// Round numbers are global, so a round id names exactly one round on exactly one table (chain memos,
// payout jobs and refunds are all keyed by it).
const tables = new Map();         // id -> { id, name, round, opening }
let roundNo = 0;
const clients = new Map();        // res -> { pid, table }, pid null for a spectator

const defaultTable = () => tables.values().next().value;
/** The table a request means: ?table= / body.table, else the first one. null when it names none. */
const tableFor = (id) => (id == null || id === '') ? defaultTable() : (tables.get(String(id)) || null);
/** The table that is playing round `id` right now, if any. */
const tableOfRound = (id) => [...tables.values()].find(t => t.round && t.round.id === id) || null;

const TABLE_DEFAULTS = { minPlayers: 0, maxPlayers: 20, bots: 'none', botBudget: 600, lobbyExtends: 1, maxTables: 8 };
const CANCEL_PAUSE_MS = 3000;
/** data from server/tables.json (or MR_TABLES); one house-bot table when there is no file. */
async function loadTables() {
  let list;
  try { list = JSON.parse(await readFile(process.env.MR_TABLES || path.join(HERE, 'tables.json'), 'utf8')).tables; } catch { /* none */ }
  if (!Array.isArray(list) || !list.length) list = [{ id: 'main', name: 'Main', bots: 'house' }];
  for (const c of list) {
    if (!/^[\w-]{1,24}$/.test(String(c.id))) throw new Error(`bad table id ${JSON.stringify(c.id)}`);
    // Tables start asleep: a round opens when the first person arrives.
    tables.set(c.id, { id: c.id, family: c.id, n: 1, name: c.name || c.id, cfg: { ...TABLE_DEFAULTS, ...c }, round: null, opening: null, idle: true });
  }
}

/* Tables of one family ("live", "live-2", ...) share a config. Visitors are placed where the people are; when
   a round has no seat left the next table of the family opens, and it closes again when its room is empty. */
const instances = (family) => [...tables.values()].filter(t => t.family === family);
const isFull = (t) => !!t.round && t.round.phase === 'betting' && seatsTaken(t.round) >= t.cfg.maxPlayers;

/** Open another table of the family, if it is under its limit. House stakes are only on the first table. */
function spawnInstance(family) {
  const have = instances(family);
  if (have.length >= have[0].cfg.maxTables) return null;
  let n = 2; while (tables.has(`${family}-${n}`)) n++;
  const base = have[0];
  const t = { id: `${family}-${n}`, family, n, name: `${base.name} ${n}`, cfg: { ...base.cfg, bots: 'none' }, round: null, opening: null, idle: true };
  tables.set(t.id, t);
  console.log(`[tables] ${t.id} opened: the others are full`);
  return t;
}

/** The table of `family` a newcomer should join: the busiest one with a seat to give, else a new one. */
function pickInstance(family) {
  const open = instances(family).filter(t => !isFull(t));
  if (open.length) return open.sort((a, b) => viewers(b) - viewers(a) || a.n - b.n)[0];
  return spawnInstance(family) || instances(family).sort((a, b) => a.n - b.n)[0];
}

/** Where a player turned away from `table` can go. Starts that table so it is ready by the time they arrive. */
function overflowFor(table) {
  const other = instances(table.family).filter(t => t !== table && !isFull(t)).sort((a, b) => viewers(b) - viewers(a) || a.n - b.n)[0] || spawnInstance(table.family);
  if (other) openTable(other);
  return other;
}
const fullReply = (res, table) => json(res, 409, { error: 'this table is full', full: true, move: overflowFor(table)?.id || null });

/** One line per table for the lobby screen and for the stats. */
function tableSummary(t) {
  const r = t.round, asleep = t.idle || !r;
  return { id: t.id, family: t.family, name: t.name, n: t.n, minPlayers: t.cfg.minPlayers, maxPlayers: t.cfg.maxPlayers, bots: t.cfg.bots,
    token: r ? r.token : (t.cfg.token || null), phase: asleep ? 'asleep' : r.phase === 'cancelled' ? 'betting' : r.phase, round: r ? r.id : null,
    bettors: asleep ? 0 : realBets(r).length, seats: asleep ? t.cfg.maxPlayers : Math.max(0, t.cfg.maxPlayers - seatsTaken(r)),
    viewers: viewers(t), closesAt: !asleep && r.phase === 'betting' ? r.closesAt : null };
}
const viewers = (table) => [...clients.values()].filter(c => c.table === table.id).length;
const realBets = (r) => r.bets.filter(b => b.pid);
/** Open the table's next round; one at a time. */
function openTable(table) {
  table.idle = false;
  if (!table.opening) table.opening = openRound(table).catch(e => console.error('[round]', e)).finally(() => { table.opening = null; });
  return table.opening;
}

/** Seats in use: wallets that have bet, plus bets in flight (a prepared bet holds its seat for a minute). */
const seatsTaken = (r) => realBets(r).length + [...r.inflight.values()].filter(t => now() - t < 60000).length;

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

/**
 * Which token this round is played in. data/schedule.json lists shows, each a
 * token and a window of time:
 *   { "shows": [ { "token": "USDC", "from": "2026-10-10T15:00:00Z", "to": "2026-10-10T17:00:00Z" } ] }
 * Outside every window it is the default token. Read at each round, so a show
 * can be added or removed without restarting.
 */
async function pickToken(table) {
  if (!chain) return null;
  if (table.cfg.token && chain.tokens.has(table.cfg.token)) return table.cfg.token;      // this table always plays one token
  try {
    const sched = JSON.parse(await readFile(SCHEDULE(), 'utf8'));
    const t = now();
    for (const s of sched.shows || []) {
      if (chain.tokens.has(s.token) && t >= Date.parse(s.from) && t < Date.parse(s.to)) return s.token;
    }
  } catch { /* no schedule: the default */ }
  return chain.defaultToken;
}

const chainMsg = (r) => ({ id: r.id, cluster: chain ? chain.cluster : null, token: r.token, commit: r.chain.commit, reveal: r.chain.reveal, payout: payoutSummary(r.id) });

/* --------------------------- surviving a restart -------------------------- */
//
// Bets live in memory, but a confirmed bet is real money in the vault. So the round's real bets are
// written to data/round.json as they land. If the server stops mid-round (a deploy, a crash), the next
// start refunds every bet of that unfinished round and continues the round numbering, so ids never repeat.

const ROUND_FILE = () => path.join(DATA, 'round.json');
const saved = new Map();          // table id -> the round state last written for it
let savedMax = 0;                 // the highest round number ever issued
function saveRoundState(r) {
  saved.set(r.tableId, { id: r.id, token: r.token, settled: !!r.settled || !!r.cancelled,
    bets: r.bets.filter(b => b.pid).map(b => ({ pid: b.pid, marble: b.marble, amount: b.amount, sig: b.sig })) });
  savedMax = Math.max(savedMax, r.id);
  const state = { maxId: savedMax, rounds: [...saved.values()] };
  mkdir(DATA, { recursive: true }).then(() => writeFile(ROUND_FILE(), JSON.stringify(state))).catch(e => console.error('[round state]', scrub(e)));
}
async function recoverRound() {
  let st;
  try { st = JSON.parse(await readFile(ROUND_FILE(), 'utf8')); } catch { return; }
  const list = st.rounds || [st];                                // the one-round file of an older version has the round itself
  savedMax = roundNo = Math.max(roundNo, st.maxId || 0, ...list.map(x => x.id || 0));   // numbering continues
  if (!chain) return;
  for (const s of list) {
    if (!s.token || s.settled || !(s.bets || []).length) continue;
    if (jobs.some(j => j.round === s.id && j.kind === 'refund')) continue;   // already handled
    console.log(`[restart] round ${s.id} was unfinished: refunding ${s.bets.length} bet(s) in ${s.token}`);
    queueJobs('refund', s.id, s.token, s.bets.map(b => ({ owner: b.pid, amount: b.amount })));
    chain.postMemo(`mr1|void|${s.id}|${s.token}|server restarted before the result, all bets refunded`).catch(() => {});
  }
}

/* ------------------------------ payout jobs ------------------------------ */
//
// Winners are paid out of the vault, a few to a transaction. Each transaction is a JOB that is
// written to data/jobs.json BEFORE it is sent, with its signature, so a crash or a flaky RPC
// can never lose a payout or pay it twice: on restart the job asks the cluster whether that
// signature landed. A refund (a bet that confirmed after betting closed) is the same job.

const JOBS_FILE = () => path.join(DATA, 'jobs.json');
let jobs = [];
let jobsRunning = false;
const saveJobs = () => mkdir(DATA, { recursive: true }).then(() => writeFile(JOBS_FILE(), JSON.stringify(jobs))).catch(e => console.error('[jobs]', e));

function payoutSummary(roundId) {
  const mine = jobs.filter(j => j.round === roundId);
  if (!mine.length) return { status: 'none', sigs: [] };
  const status = mine.every(j => j.status === 'done') ? 'confirmed' : mine.some(j => j.status === 'failed') ? 'failed' : 'pending';
  return { status, sigs: mine.filter(j => j.status === 'done').map(j => j.sig), kind: mine[0].kind };
}

function queueJobs(kind, roundId, token, items) {
  const per = 4;
  for (let i = 0; i < items.length; i += per) {
    jobs.push({ id: `${kind}-${roundId}-${i / per}-${randomBytes(3).toString('hex')}`, kind, round: roundId, token,
                items: items.slice(i, i + per), status: 'pending', tries: 0, sig: null });
  }
  console.log(`[${kind}] round ${roundId}: ${items.length} to pay in ${Math.ceil(items.length / per)} transaction(s)`);
  saveJobs();
  runJobs();
}

async function runJob(job) {
  const memo = `mr1|${job.kind}|${job.round}|${job.items.length}`;
  if (job.status === 'sending') {                           // we wrote it down but never saw it land
    const st = await chain.txState(job.sig, job.lastValid);
    if (st === 'confirmed') { job.status = 'done'; return; }
    if (st === 'unknown') { await chain.sendRaw(job.raw, job.sig, job.blockhash, job.lastValid); job.status = 'done'; return; }
    job.status = 'pending'; job.sig = null;                 // failed or expired: build it again
  }
  const have = await chain.vaultBalance(job.token);
  const need = job.items.reduce((a, b) => a + b.amount, 0);
  if (have < need) throw new Error(`vault short: has ${have} ${job.token}, needs ${need}`);
  const b = await chain.buildPayout(job.token, job.items, memo);
  Object.assign(job, { raw: b.raw, sig: b.signature, blockhash: b.blockhash, lastValid: b.lastValidBlockHeight, status: 'sending' });
  await saveJobs();                                         // signature on disk before it can reach the network
  await chain.sendRaw(b.raw, b.signature, b.blockhash, b.lastValidBlockHeight);
  job.status = 'done';
  console.log(`[${job.kind}] round ${job.round}: sent ${job.sig.slice(0, 12)}…`);
}

async function runJobs() {
  if (jobsRunning || !chain) return;
  jobsRunning = true;
  try {
    for (const job of jobs) {
      if (job.status === 'done' || job.status === 'failed') continue;
      try { await runJob(job); }
      catch (e) {
        job.tries += 1;
        console.error(`[${job.kind} ${job.id}] attempt ${job.tries}:`, scrub(e));
        if (job.tries >= 6) job.status = 'failed';
      }
      await saveJobs();
      const sum = payoutSummary(job.round);
      broadcast('payout', { id: job.round, token: job.token, ...sum });
    }
  } finally { jobsRunning = false; }
}
setInterval(() => runJobs().catch(() => {}), 15000);

/** Post one memo for a round and say so. A chain hiccup never stops the game: the slot just reads 'failed'. */
async function anchor(r, kind, text) {
  const slot = r.chain[kind];
  slot.status = 'pending';
  try {
    if (!(await chain.solAtLeast(0.005))) throw new Error('house wallet low on SOL: round memos paused so payouts can keep going');
    slot.sig = (await chain.postMemo(text)).signature;
    slot.status = 'confirmed';
  } catch (e) {
    slot.status = 'failed';
    console.error(`[round ${r.id}] ${kind} memo failed:`, scrub(e));
  }
  broadcast('chain', chainMsg(r), r.tableId);
}

/** Open a round: seeds, commitment, the race run in full, the bots queued. */
export async function openRound(table = defaultTable()) {
  roundNo += 1;
  const courseSeed = randomBytes(8).toString('hex');
  const raceSeed = randomBytes(16).toString('hex');
  // The authoritative run, plus a position every second for drift checks. On a worker thread: it takes
  // about half a second of CPU on a real course, and the other tables must keep talking meanwhile.
  const t0 = performance.now();
  const { lanes, sync, layout, result } = await race({ courseSeed, raceSeed, blocks: T.blocks });
  const ms = performance.now() - t0;

  const token = await pickToken(table);
  const tok = token ? chain.token(token) : null;
  const minBet = tok ? tok.minBet : MIN_BET;
  const t = now();
  const round = table.round = {
    id: roundNo, tableId: table.id, tableName: table.name, cfg: table.cfg, courseSeed, raceSeed, commitment: sha256(raceSeed), token, minBet, inflight: new Map(),
    chain: { commit: { status: chain ? 'pending' : 'off' }, reveal: { status: chain ? 'idle' : 'off' } },
    lanes, result, sync, layout,
    phase: 'betting', opensAt: t, closesAt: t + T.lobby * 1000,
    raceAt: 0, resultAt: 0, nextAt: 0,
    extended: 0, cancelled: null,
    pools: new Array(K).fill(0), backers: new Array(K).fill(0),
    bets: [], bots: table.cfg.bots === 'house' ? makeBots(makeRng(raceSeed + ':bots'), minBet / MIN_BET, table.cfg.botBudget * minBet / MIN_BET) : [], ready: new Set(), settled: null,
  };
  saveRoundState(round);
  console.log(`[round ${round.id}] open  course ${courseSeed}  commit ${round.commitment.slice(0, 16)}…  ` +
              `race ${result.time}s precomputed in ${ms.toFixed(0)}ms`);   // never the winner: logs get shared
  broadcast('round', publicRound(round), table.id);
  // Seal it: the commitment goes on chain now, before any bet can be taken.
  if (chain) anchor(round, 'commit', `mr1|commit|${round.id}|${token}|${courseSeed}|${round.commitment}|${PRINT}|${T.blocks || 0}|${CODE.hash}|${CODE.rev}`);
}

/** Everything a browser may know right now. The race seed only once racing. */
function publicRound(r) {
  const racing = r.phase === 'racing' || r.phase === 'results';
  return {
    id: r.id, phase: r.phase === 'cancelled' ? 'betting' : r.phase, cancelled: r.cancelled, courseSeed: r.courseSeed, commitment: r.commitment, token: r.token, minBet: r.minBet,
    lanes: r.lanes, layout: r.layout, blocks: T.blocks || null,
    opensAt: r.opensAt, closesAt: r.closesAt, raceAt: r.raceAt, resultAt: r.resultAt, nextAt: r.nextAt,
    raceSeed: racing ? r.raceSeed : null,
    pools: r.pools, backers: r.backers,
    bets: r.bets.map(b => ({ handle: b.handle, marble: b.marble, amount: b.amount, whale: b.whale, auto: b.auto, human: !!b.pid })),
    ready: r.ready.size, players: connectedPlayers(r.tableId).length,
    table: tableInfo(r), real: realBets(r).length,
    result: r.phase === 'results' ? r.result : null,
    lobbySeconds: T.lobby, now: now(),
  };
}

/** What a browser needs to know about the table this round belongs to. */
function tableInfo(r) {
  const c = r.cfg;
  return { id: r.tableId, name: r.tableName, minPlayers: c.minPlayers, maxPlayers: c.maxPlayers, bots: c.bots };
}

function connectedPlayers(tableId) {
  return [...new Set([...clients.values()].filter(c => c.table === tableId).map(c => c.pid).filter(Boolean))];
}

/** Close the lobby: auto-bet the stragglers, then the countdown. */
function closeLobby(r) {
  if (r.phase !== 'betting') return;
  // Bots that never got their money down take the fallback: minimum, on the
  // least backed marble, read live so a queue of them spreads out.
  for (const b of r.bots.splice(0)) {
    addBet(r, { handle: b.handle, marble: leastBacked(r), amount: r.minBet, auto: true });   // house stake: no pid
  }
  // A player who has not bet is NOT staked for: with real tokens that would need their
  // signature. They watch this one.
  r.phase = 'countdown';
  r.raceAt = now() + T.countdown * 1000;
  r.resultAt = r.raceAt + (r.result.time + T.runout) * 1000;
  r.nextAt = r.resultAt + T.results * 1000;
  broadcast('round', publicRound(r), r.tableId);
}

/**
 * The lobby clock ran out (or everyone is ready). A table with a minimum needs that many wallets
 * to have bet: if not, wait one more lobby, then cancel the round and give every stake back.
 */
function lobbyEnds(table, r) {
  const need = table.cfg.minPlayers, have = realBets(r).length;
  if (have >= need) return closeLobby(r);
  if (r.extended < table.cfg.lobbyExtends) {
    r.extended += 1;
    r.closesAt = now() + T.lobby * 1000;
    broadcast('round', publicRound(r), r.tableId);
    broadcast('notice', { id: r.id, kind: 'waiting', need, have, message: `Waiting for ${need - have} more player${need - have === 1 ? '' : 's'}` }, r.tableId);
    return;
  }
  cancelRound(table, r, `needed ${need} players, had ${have}`);
}

/** Give back every stake of a round that will not be raced, tell the table, and open the next one shortly. */
function cancelRound(table, r, reason) {
  const real = realBets(r);
  r.cancelled = reason;
  r.phase = 'cancelled';
  // A table nobody bet at waits longer each time (3s, 6s, ... 30s) instead of sealing a round a minute for a lone spectator.
  const pause = real.length ? (table.emptyCancels = 0, CANCEL_PAUSE_MS) : Math.min(30000, CANCEL_PAUSE_MS * 2 ** (table.emptyCancels = (table.emptyCancels || 0) + 1) / 2);
  r.nextAt = now() + pause;
  if (r.token && chain) {
    if (real.length) {
      queueJobs('refund', r.id, r.token, real.map(b => ({ owner: b.pid, amount: b.amount })));
      // the seed is revealed with the void: a round that was never raced cannot be quietly re-rolled
      if (r.chain.commit.status === 'confirmed') chain.postMemo(`mr1|void|${r.id}|${r.token}|${reason}|${r.raceSeed}|${r.chain.commit.sig}`).catch(() => {});
    }
  } else {
    for (const b of real) { const w = wallet(b.pid); w.balance += b.amount; w.stats.races -= 1; w.stats.wagered -= b.amount; walletsDirty = true; }
  }
  saveRoundState(r);
  console.log(`[round ${r.id}] cancelled: ${reason}; ${real.length} bet(s) refunded`);
  broadcast('notice', { id: r.id, kind: 'cancelled', reopensAt: r.nextAt, message: real.length ? `Round cancelled: ${reason}. Stakes returned.` : `Waiting for players: ${reason}.` }, r.tableId);
}

/** Pay every backer. Shares of the net pool by finishing position. */
function settle(r) {
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
    if (!r.token) w.balance += payout;                    // token rounds pay from the vault, below
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
  r.payouts = r.token ? r.bets.filter(b => b.pid && per[b.pid].payout > 0).map(b => ({ owner: b.pid, amount: per[b.pid].payout })) : [];
}

/** The round clock. Runs every 100ms; cheap. */
function tick(table) {
  const r = table.round, t = now();
  if (!r) return;
  if (r.phase === 'betting') {
    let changed = false;
    while (r.bots.length && r.opensAt + r.bots[0].at * 1000 <= t) {
      const b = r.bots.shift();
      addBet(r, { handle: b.handle, marble: b.marble, amount: b.amount, whale: b.whale });
      changed = true;
    }
    if (changed) broadcast('pool', poolMsg(r), r.tableId);
    if (t >= r.closesAt) lobbyEnds(table, r);
  } else if (r.phase === 'countdown' && t >= r.raceAt) {
    r.phase = 'racing';
    broadcast('round', publicRound(r), r.tableId);
  } else if (r.phase === 'racing') {
    // A position check each second of race time.
    const s = Math.floor((t - r.raceAt) / 1000);
    if (s !== r.lastSync && s >= 1 && s <= r.sync.length) {
      r.lastSync = s;
      broadcast('sync', { id: r.id, second: s, pos: r.sync[s - 1] }, r.tableId);
    }
    if (t >= r.resultAt) {
      settle(r);
      if (chain && r.chain.commit.status === 'confirmed') {
        anchor(r, 'reveal', `mr1|reveal|${r.id}|${r.token}|${r.raceSeed}|${r.result.finishOrder.join(',')}|${r.settled.totalPool}|${r.chain.commit.sig}`);
      }
      if (r.token && chain && r.payouts.length) queueJobs('payout', r.id, r.token, r.payouts);
      saveRoundState(r);
      r.phase = 'results';
      broadcast('round', publicRound(r), r.tableId);
      for (const [res, c] of clients) if (c.pid && c.table === r.tableId) send(res, 'settled', settledFor(c.pid, r));
    }
  } else if ((r.phase === 'results' || r.phase === 'cancelled') && t >= r.nextAt && !table.opening && !table.idle) {
    // Nobody watching: the table sleeps instead of sealing rounds for an empty room. The next visitor wakes it.
    if (viewers(table) === 0) { if (table.n > 1) { tables.delete(table.id); console.log(`[tables] ${table.id} closed: nobody left`); } else table.idle = true; }
    else openTable(table);
  }
}

function settledFor(pid, r) {
  const w = wallet(pid);
  return { id: r.id, you: r.settled?.per[pid] || null, totalPool: r.settled?.totalPool, balance: r.token ? undefined : w.balance,
           history: w.history, stats: w.stats, raceSeed: r.raceSeed, commitment: r.commitment };
}

const poolMsg = (r) => ({ id: r.id, pools: r.pools, backers: r.backers,
  bets: r.bets.map(b => ({ handle: b.handle, marble: b.marble, amount: b.amount, whale: b.whale, auto: b.auto, human: !!b.pid })),
  ready: r.ready.size, players: connectedPlayers(r.tableId).length, real: realBets(r).length, now: now() });

/* --------------------------------- SSE ---------------------------------- */

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
/** To everyone watching `tableId`, or to every connection when no table is named. */
function broadcast(event, data, tableId) {
  for (const [res, c] of clients) if (tableId === undefined || c.table === tableId) send(res, event, data);
}
setInterval(() => { for (const res of clients.keys()) res.write(': keep-alive\n\n'); }, 15000);

/* --------------------------------- HTTP --------------------------------- */

/** The caller's address. Behind a proxy (MR_TRUST_PROXY=1) it is the last hop the proxy appended; otherwise the socket's. */
const clientIp = (req) => {
  if (process.env.MR_TRUST_PROXY === '1') {
    const f = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
    if (f.length) return f[f.length - 1];
  }
  return req.socket.remoteAddress || '?';
};

/** A sliding-window limiter: allow(key) is true while `key` has made fewer than `max` calls in `ms`. */
function limiter(max, ms) {
  const hits = new Map();
  setInterval(() => { const t = Date.now(); for (const [k, l] of hits) { const keep = l.filter(x => x > t - ms); if (keep.length) hits.set(k, keep); else hits.delete(k); } }, 30_000).unref();
  return {
    allow(key) {
      const t = Date.now(), l = (hits.get(key) || []).filter(x => x > t - ms);
      if (l.length >= max) { hits.set(key, l); return false; }
      l.push(t); hits.set(key, l); return true;
    },
    undo(key) { const l = hits.get(key); if (l) l.pop(); },
  };
}
const apiLimit = limiter(150, 10_000);                 // any API call, per address
const prepareLimit = limiter(1, 1500);                 // one bet build per player per 1.5s: each one costs RPC calls
const faucetIpLimit = limiter(+(process.env.MR_FAUCET_PER_IP || 3), 86_400_000);
const faucetDayLimit = limiter(+(process.env.MR_FAUCET_PER_DAY || 150), 86_400_000);   // the faucet pays ~0.002 SOL of rent per new wallet
const sseByIp = new Map();
const SSE_PER_IP = 12, SSE_TOTAL = 800;

/** Headers for every response. The page signs wallet messages, so it must never be framed or load a foreign script. */
function hardenHeaders(req, res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('content-security-policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com", "img-src 'self' data: blob:", "connect-src 'self'",
    "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'",
  ].join('; '));
  if (secure(req)) res.setHeader('strict-transport-security', 'max-age=31536000');
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.mp4': 'video/mp4' };
// Only the game and the shared modules are served. Nothing else in the
// project folder (backups, logs, the wallets file) is reachable.
// The page itself, its styles and scripts, and the three shared modules it imports. The server code, the
// QA tools, the README and the data folder are NOT served.
const SERVED = [/^MarbleRush2D\/index\.html$/, /^MarbleRush2D\/css\/[\w.-]+$/, /^MarbleRush2D\/assets\/[\w-]+\.(png|svg)$/, /^MarbleRush2D\/js\/(vendor\/)?[\w.-]+\.js$/, /^js\/(rng|racers|betting)\.js$/];

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let s = '';
  for await (const chunk of req) { s += chunk; if (s.length > 4096) throw new Error('too big'); }
  return s ? JSON.parse(s) : {};
}

const COOKIE = 'mr_session';
const secure = (req) => process.env.MR_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
const cookie = (req, value, maxAge) =>
  `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure(req) ? '; Secure' : ''}`;

async function api(req, res, url) {
  if (url.pathname === '/api/ping') return json(res, 200, { marblerush: true, now: now() });
  if (url.pathname === '/api/chain') return json(res, 200, chain ? chain.publicInfo() : { cluster: null, tokens: [] });
  if (url.pathname === '/api/tables') return json(res, 200, { tables: [...tables.values()].map(tableSummary), now: now() });
  const token = parseCookie(req.headers.cookie, COOKIE);
  const pid = auth.sessionPid(token);                       // null: a spectator

  if (url.pathname === '/api/events') {
    const ip = clientIp(req);
    if (clients.size >= SSE_TOTAL || (sseByIp.get(ip) || 0) >= SSE_PER_IP) return json(res, 429, { error: 'too many open connections' });
    // ?table=live means "a Live table, wherever there is room"; with &pin=1 it means exactly that one.
    const want = url.searchParams.get('table') || defaultTable().family;
    const table = url.searchParams.get('pin') ? tables.get(want) : (instances(want).length ? pickInstance(want) : tables.get(want));
    if (!table) return json(res, 404, { error: 'no such table' });
    sseByIp.set(ip, (sseByIp.get(ip) || 0) + 1);
    res.on('close', () => { const n = (sseByIp.get(ip) || 1) - 1; if (n) sseByIp.set(ip, n); else sseByIp.delete(ip); });
    if (table.idle || !table.round) { await openTable(table); if (res.destroyed || !table.round) return; }   // wake a sleeping table
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    clients.set(res, { pid, table: table.id });
    const round = table.round;
    if (pid) {
      const w = wallet(pid);
      send(res, 'hello', { pid, name: w.name, print: PRINT, code: CODE, balance: w.balance, onchain: !!round.token, table: table.id, history: w.history, stats: w.stats, now: now(), timing: T });
    } else send(res, 'hello', { guest: true, print: PRINT, code: CODE, balance: 0, history: [], stats: null, table: table.id, now: now(), timing: T });
    send(res, 'round', publicRound(round));
    send(res, 'chain', chainMsg(round));
    if (pid && round.phase === 'results') send(res, 'settled', settledFor(pid, round));
    broadcast('pool', poolMsg(round), table.id);
    req.on('close', () => { clients.delete(res); if (table.round) broadcast('pool', poolMsg(table.round), table.id); });
    return;
  }
  if (url.pathname === '/api/balance') {
    if (!pid) return json(res, 401, { error: 'connect a wallet first' });
    if (!chain) return json(res, 503, { error: 'chain not set up' });
    const symbol = url.searchParams.get('token') || chain.defaultToken;
    if (!chain.tokens.has(symbol)) return json(res, 400, { error: 'unknown token' });
    const hit = balanceCache.get(pid + symbol);
    if (hit && Date.now() - hit.t < 1000) return json(res, 200, { token: symbol, balance: hit.v });
    const v = await chain.balanceOf(pid, symbol);
    balanceCache.set(pid + symbol, { t: Date.now(), v });
    if (balanceCache.size > 5000) balanceCache.clear();
    return json(res, 200, { token: symbol, balance: v });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  // A cookie rides along on any request the browser makes, so a POST must
  // come from this site's own pages.
  const origin = req.headers.origin;
  if (origin && (URL.canParse(origin) ? new URL(origin).host : null) !== req.headers.host) return json(res, 403, { error: 'wrong origin' });
  const body = await readBody(req).catch(() => null);
  if (!body) return json(res, 400, { error: 'bad body' });

  if (url.pathname === '/api/auth/nonce') {
    const out = auth.issueNonce({ address: String(body.address || ''), host: req.headers.host, ip: clientIp(req) });
    return json(res, out.error ? (out.status || 400) : 200, out);
  }
  if (url.pathname === '/api/auth/verify') {
    const out = auth.verifyLogin({ address: String(body.address || ''), nonce: String(body.nonce || ''), signature: body.signature });
    if (out.error) return json(res, 401, { error: out.error });
    res.setHeader('set-cookie', cookie(req, out.token, out.maxAge));
    return json(res, 200, { ok: true, address: out.pid, name: wallet(out.pid).name });
  }
  if (url.pathname === '/api/auth/logout') {
    auth.logout(token);
    res.setHeader('set-cookie', cookie(req, '', 0));
    return json(res, 200, { ok: true });
  }

  if (!pid) return json(res, 401, { error: 'connect a wallet to play' });

  if (url.pathname === '/api/faucet') {
    if (!chain) return json(res, 503, { error: 'chain not set up' });
    const symbol = String(body.token || chain.defaultToken);
    if (!chain.tokens.has(symbol)) return json(res, 400, { error: 'unknown token' });
    if (!(await chain.solAtLeast(0.01))) return json(res, 503, { error: 'the faucet is paused: the house wallet is low on SOL' });
    const ip = clientIp(req);
    if (!faucetIpLimit.allow(ip)) return json(res, 429, { error: 'too many faucet claims from this network today' });
    if (!faucetDayLimit.allow('all')) { faucetIpLimit.undo(ip); return json(res, 429, { error: 'the faucet has reached its daily limit, try tomorrow' }); }
    try {
      const out = await chain.claimFaucet(pid, symbol);
      if (out.error) { faucetIpLimit.undo(ip); faucetDayLimit.undo('all'); return json(res, out.status, { error: out.error, retryInMs: out.retryInMs }); }
      balanceCache.delete(pid + symbol);
      return json(res, 200, { ok: true, ...out, balance: await chain.balanceOf(pid, symbol) });
    } catch (e) {
      faucetIpLimit.undo(ip); faucetDayLimit.undo('all');
      console.error('[faucet]', scrub(e));
      return json(res, 502, { error: 'the faucet could not reach Solana, try again' });
    }
  }
  const table = tableFor(body.table);
  if (!table) return json(res, 404, { error: 'no such table' });
  const r = table.round, w = wallet(pid);
  if (!r && url.pathname !== '/api/topup') return json(res, 409, { error: 'this table is asleep: open it first' });

  if (url.pathname === '/api/bet/prepare') {
    if (!chain || !r.token) return json(res, 409, { error: 'this round has no token' });
    if (r.phase !== 'betting' || r.closesAt - now() < 4000) return json(res, 409, { error: 'betting is closed' });
    if (r.chain.commit.status === 'pending') return json(res, 409, { error: 'sealing the round on Solana, one moment' });
    if (r.chain.commit.status !== 'confirmed') return json(res, 409, { error: 'this round could not be sealed on Solana, so it is watch-only' });
    if (!prepareLimit.allow(pid)) return json(res, 429, { error: 'one moment' });
    if (!(await chain.solAtLeast(0.003))) return json(res, 503, { error: 'bets are paused: the house wallet is low on SOL for fees' });
    const tok = chain.token(r.token);
    const marble = body.marble | 0;
    const amount = Math.round(+body.amount * 10 ** 6) / 10 ** 6;
    if (!(marble >= 0 && marble < K)) return json(res, 400, { error: 'no such marble' });
    if (!(amount >= tok.minBet) || amount > tok.stakes[tok.stakes.length - 1] * 10) return json(res, 400, { error: 'stake not allowed' });
    if (r.bets.some(b => b.pid === pid) || (r.inflight.has(pid) && now() - r.inflight.get(pid) < 60000)) return json(res, 409, { error: 'already bet this round' });
    if (seatsTaken(r) >= table.cfg.maxPlayers) return fullReply(res, table);
    let have;
    try { have = await chain.balanceOf(pid, r.token); } catch { return json(res, 502, { error: 'could not read your balance from Solana' }); }
    if (have < amount) return json(res, 400, { error: `not enough ${r.token} in your wallet` });
    r.inflight.set(pid, now());
    try {
      const prep = await chain.prepareBet({ owner: pid, symbol: r.token, amount, roundId: r.id, marble, memo: `mr1|bet|${r.id}|${marble}|${amount}` });
      return json(res, 200, { ...prep, marble, amount, token: r.token });
    } catch (e) { r.inflight.delete(pid); console.error('[prepare]', scrub(e)); return json(res, 502, { error: 'could not build the bet' }); }
  }
  if (url.pathname === '/api/bet/submit') {
    if (!chain || !chain.preparedBet(String(body.prepId || ''), pid)) return json(res, 410, { error: 'that bet expired, try again' });
    let out;
    try { out = await chain.submitBet(String(body.prepId), pid, String(body.tx || '')); }
    catch (e) { console.error('[submit]', scrub(e)); r.inflight.delete(pid); return json(res, 502, { error: 'the bet did not reach Solana, try again' }); }
    r.inflight.delete(pid);
    if (out.error) return json(res, out.status, { error: out.error });
    // It landed. It counts only if its own round is still taking bets; otherwise it is refunded.
    if (r.id !== out.roundId || r.phase !== 'betting') {
      queueJobs('refund', out.roundId, out.symbol, [{ owner: pid, amount: out.amount }]);
      return json(res, 409, { error: 'the round closed just before your bet landed: it will be refunded', refunded: true, signature: out.signature });
    }
    if (!Number.isInteger(out.marble) || out.marble < 0 || out.marble >= K) { queueJobs('refund', out.roundId, out.symbol, [{ owner: pid, amount: out.amount }]); return json(res, 500, { error: 'bad bet, refunded' }); }
    const w = wallet(pid);
    w.stats.races += 1; w.stats.wagered += out.amount; walletsDirty = true;
    addBet(r, { pid, handle: w.name, marble: out.marble, amount: out.amount, sig: out.signature });
    saveRoundState(r);
    broadcast('pool', poolMsg(r), table.id);
    return json(res, 200, { ok: true, signature: out.signature, round: out.roundId, amount: out.amount });
  }
  if (url.pathname === '/api/bet') {
    const marble = body.marble | 0, amount = Math.round(+body.amount);
    if (r.phase !== 'betting') return json(res, 409, { error: 'betting is closed' });
    if (r.chain.commit.status === 'pending') return json(res, 409, { error: 'sealing the round on Solana, one moment' });
    if (r.token) return json(res, 409, { error: 'this round is played in real tokens: sign the bet in your wallet' });
    if (!(marble >= 0 && marble < K)) return json(res, 400, { error: 'no such marble' });
    if (!(amount >= MIN_BET) || amount > w.balance) return json(res, 400, { error: 'stake not allowed' });
    if (r.bets.some(b => b.pid === pid)) return json(res, 409, { error: 'already bet this round' });
    if (seatsTaken(r) >= table.cfg.maxPlayers) return fullReply(res, table);
    w.balance -= amount; w.stats.races += 1; w.stats.wagered += amount; walletsDirty = true;
    addBet(r, { pid, handle: w.name, marble, amount });
    broadcast('pool', poolMsg(r), table.id);
    return json(res, 200, { ok: true, balance: w.balance });
  }
  if (url.pathname === '/api/ready') {
    if (r.phase !== 'betting') return json(res, 409, { error: 'not in the lobby' });
    r.ready.add(pid);
    // Everyone connected is ready: no reason to hold the table.
    const players = connectedPlayers(table.id);
    if (players.length && realBets(r).length >= table.cfg.minPlayers && players.every(p => r.ready.has(p) && r.bets.some(b => b.pid === p))) closeLobby(r);
    else broadcast('pool', poolMsg(r), table.id);
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/topup') {
    if (chain) return json(res, 409, { error: 'use the token faucet' });
    if (w.balance >= MIN_BET) return json(res, 409, { error: 'only when the wallet is empty' });
    w.balance += STARTING_BALANCE; walletsDirty = true;
    return json(res, 200, { ok: true, balance: w.balance });
  }
  return json(res, 404, { error: 'unknown endpoint' });
}

async function statics(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname).replace(/^\/+/, ''); } catch { res.writeHead(400); return res.end('bad request'); }
  // Keep the query string (?palette=, ?only=) across the redirect.
  if (rel === '' ) { res.writeHead(302, { location: '/MarbleRush2D/' + url.search }); return res.end(); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) || !SERVED.some(re => re.test(rel))) {
    res.writeHead(404); return res.end('not found');
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
}

export async function start(port = PORT) {
  CODE = { hash: await codeHash(ROOT), rev: gitRev(ROOT), files: CODE_FILES };
  console.log(`[code] race code ${CODE.hash} (${CODE.rev})`);
  await loadWallets();
  await auth.load();
  try {
    chain = await openChain({ dataDir: process.env.MR_CHAIN_DIR || DATA });
    try { jobs = JSON.parse(await readFile(JOBS_FILE(), 'utf8')); runJobs(); } catch { /* none yet */ }
    if (chain) { try { console.log(`[chain] house wallet ${(await chain.authoritySol()).toFixed(4)} SOL` + (await chain.solAtLeast(0.05) ? '' : '  <-- LOW: top up before the faucet and bets pause')); } catch { /* offline */ } }
    console.log(chain ? `[chain] ${chain.cluster}, tokens ${[...chain.tokens.keys()].join(', ')}, authority ${chain.authority.publicKey.toBase58()}` : '[chain] not set up: demo money only');
  } catch (e) { console.error('[chain] could not open:', scrub(e)); }
  await recoverRound();
  await loadTables();
  setInterval(() => { for (const t of tables.values()) tick(t); }, 100);
  const server = http.createServer((req, res) => {
    hardenHeaders(req, res);
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end('bad request'); }
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/events' && !apiLimit.allow(clientIp(req))) return json(res, 429, { error: 'too many requests, slow down' });
    const go = url.pathname.startsWith('/api/') ? api(req, res, url) : statics(req, res, url);
    go.catch(e => { console.error(e); if (!res.headersSent) json(res, 500, { error: 'server error' }); });
  });
  await new Promise(ok => server.listen(port, ok));
  console.log(`MarbleRush server on http://localhost:${port}/MarbleRush2D/`);
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) start();
