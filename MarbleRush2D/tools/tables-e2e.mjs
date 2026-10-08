// tables-e2e.mjs: how a table decides whether a race happens, with demo money (no chain needed).
//
//   node MarbleRush2D/tools/tables-e2e.mjs
//
// Two tables from a temporary config: "practice" (labelled house bots, capped) and "live"
// (3 players needed, no bots, 4 seats). Checks that:
//   - a table is asleep until someone opens it, and sleeps again when the room is empty
//   - house bots are capped and are not players
//   - a live round with too few players waits one more lobby, then is cancelled and every stake returns
//   - with enough players it races with only their money in the pool and pays out of exactly that pool
//   - the fifth bettor at a four-seat table is turned away
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'mr-tables-e2e-'));
writeFileSync(join(dir, 'tables.json'), JSON.stringify({ tables: [
  { id: 'practice', name: 'Practice', minPlayers: 0, maxPlayers: 20, bots: 'house', botBudget: 100 },
  { id: 'live', name: 'Live', minPlayers: 3, maxPlayers: 4, bots: 'none' },
] }));
process.env.MR_TABLES = join(dir, 'tables.json');
process.env.MR_DATA = join(dir, 'data');
process.env.MR_LOBBY = '4';
process.env.MR_BLOCKS = '6';

const logs = [];
const realLog = console.log;
console.log = (...a) => { const line = a.join(' '); logs.push({ t: Date.now(), line }); realLog(...a); };
const opens = () => logs.filter(l => /^\[round \d+\] open/.test(l.line)).length;

const { start } = await import('../server/server.mjs');
const { b58encode } = await import('../server/auth.mjs');
const { RAKE } = await import('../../js/betting.js');
const PORT = 8192, base = `http://localhost:${PORT}`;
let failures = 0;
const check = (ok, what) => { realLog(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const server = await start(PORT);

function newWallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const address = b58encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  return { address, sign: (msg) => sign(null, Buffer.from(msg), privateKey).toString('base64') };
}
const post = async (p, body, cookie) => { const r = await fetch(`${base}/api/${p}`, { method: 'POST', body: JSON.stringify(body), headers: cookie ? { cookie } : {} }); return { code: r.status, body: await r.json(), cookie: r.headers.get('set-cookie') }; };
async function signIn() {
  const w = newWallet();
  const n = await post('auth/nonce', { address: w.address });
  const v = await post('auth/verify', { address: w.address, nonce: n.body.nonce, signature: w.sign(n.body.message) });
  return { w, cookie: v.cookie.split(';')[0] };
}
/** An SSE stream onto one table, parsed into events. */
function watch(table, cookie) {
  const events = [], waiters = [], ctrl = new AbortController();
  (async () => {
    const res = await fetch(`${base}/api/events?table=${table}`, { signal: ctrl.signal, headers: cookie ? { cookie } : {} });
    const dec = new TextDecoder(); let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block), data = /^data: (.*)$/m.exec(block);
        if (!ev || !data) continue;
        const e = { type: ev[1], data: JSON.parse(data[1]) };
        events.push(e);
        for (const w of waiters.slice()) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); w.ok(e); }
      }
    }
  })().catch(() => {});
  return {
    events, close: () => ctrl.abort(),
    wait: (pred, ms = 60000) => { const hit = events.find(pred); return hit ? Promise.resolve(hit) : new Promise((ok, no) => { waiters.push({ pred, ok }); setTimeout(() => no(new Error('timeout')), ms); }); },
  };
}
const balanceOf = async (login) => { const s = watch('practice', login.cookie); const h = await s.wait(e => e.type === 'hello'); s.close(); return h.data.balance; };

realLog('\n  tables\n');

// --- asleep until someone arrives ---------------------------------------------------------
await sleep(2500);
check(opens() === 0, 'no round is sealed while nobody is watching');
const spec = watch('practice');
const first = await spec.wait(e => e.type === 'round');
check(first.data.id === 1 && first.data.table.id === 'practice' && first.data.table.bots === 'house', 'the first visitor wakes the table: round 1 on practice');
check((await fetch(`${base}/api/events?table=nope`)).status === 404, 'an unknown table is a 404');

// --- house bots ---------------------------------------------------------------------------
const racing = await spec.wait(e => e.type === 'round' && e.data.id === 1 && e.data.phase === 'countdown');
const house = racing.data.bets.filter(b => !b.human);
const houseTotal = house.reduce((a, b) => a + b.amount, 0);
check(house.length >= 7 && racing.data.bets.every(b => !b.human), `the practice pool is house stakes, none of them a player's (${house.length} of them)`);
check(houseTotal <= 100 + house.length * racing.data.minBet, `and the house's exposure is capped (${houseTotal.toFixed(0)} vs budget 100 plus ${racing.data.minBet} fallbacks)`);

// --- a live round without enough players is cancelled ---------------------------------------
const A = await signIn(), B = await signIn(), C = await signIn(), D = await signIn(), E = await signIn();
const sA = watch('live', A.cookie), sB = watch('live', B.cookie);
const r1 = await sA.wait(e => e.type === 'round' && e.data.phase === 'betting');
check(r1.data.table.id === 'live' && r1.data.table.minPlayers === 3 && r1.data.table.bots === 'none', 'the live table needs 3 players and has no bots');
check((await post('bet', { table: 'live', marble: 0, amount: 50 }, A.cookie)).code === 200 && (await post('bet', { table: 'live', marble: 1, amount: 25 }, B.cookie)).code === 200, 'two players bet');
check(r1.data.bets.length === 0, 'there are no house stakes on the live table');
const waiting = await sA.wait(e => e.type === 'notice' && e.data.kind === 'waiting');
check(waiting.data.id === r1.data.id && /1 more player/.test(waiting.data.message), 'short of the minimum, the lobby waits one more round of the clock');
const closesLater = await sA.wait(e => e.type === 'round' && e.data.id === r1.data.id && e.data.closesAt > r1.data.closesAt);
check(!!closesLater, 'and the clock on the page is pushed back');
const cancelled = await sA.wait(e => e.type === 'notice' && e.data.kind === 'cancelled', 30000);
check(cancelled.data.id === r1.data.id && /needed 3 players, had 2/.test(cancelled.data.message), 'still short: the round is cancelled with the reason');
check(logs.some(l => l.line.includes(`[round ${r1.data.id}] cancelled`) && l.line.includes('2 bet(s) refunded')), 'both stakes are refunded');
check(await balanceOf(A) === 1000 && await balanceOf(B) === 1000, 'both wallets are whole again');
const r2 = await sA.wait(e => e.type === 'round' && e.data.id > r1.data.id && e.data.phase === 'betting');
check(r2.data.id > r1.data.id, `the next round opens (${r2.data.id})`);

// --- enough players: it races, with only their money in the pool -----------------------------------
const sC = watch('live', C.cookie), sD = watch('live', D.cookie), sE = watch('live', E.cookie);
await sC.wait(e => e.type === 'round' && e.data.id === r2.data.id);
const b = await Promise.all([[A, 0, 50], [B, 1, 25], [C, 2, 25], [D, 3, 10]].map(([p, m, a]) => post('bet', { table: 'live', marble: m, amount: a }, p.cookie)));
check(b.every(x => x.code === 200), 'four players take the four seats');
const fifth = await post('bet', { table: 'live', marble: 4, amount: 10 }, E.cookie);
check(fifth.code === 409 && /full/.test(fifth.body.error), 'a fifth bettor is turned away: this table is full');
check(fifth.body.full === true && fifth.body.move === 'live-2', 'and is told where to go: a second Live table opens');
const sE2 = watch('live', E.cookie);                                  // "a Live table, wherever there is room"
const over = await sE2.wait(e => e.type === 'round');
check(over.data.table.id === 'live-2' && over.data.table.name === 'Live 2' && over.data.table.bots === 'none', 'a newcomer asking for Live is seated at Live 2: no house stakes there');
const listing = (await (await fetch(`${base}/api/tables`)).json()).tables;
const l1 = listing.find(t => t.id === 'live'), l2 = listing.find(t => t.id === 'live-2');
check(l1.seats === 0 && l1.bettors === 4 && l2 && l2.seats === 4 && listing.find(t => t.id === 'practice').bots === 'house', 'the table list shows Live full and Live 2 open');
check((await post('bet', { table: 'live-2', marble: 4, amount: 10 }, E.cookie)).code === 200, 'and the newcomer bets there');
const go = await sA.wait(e => e.type === 'round' && e.data.id === r2.data.id && e.data.phase === 'countdown', 30000);
check(go.data.bets.length === 4 && go.data.bets.every(x => x.human), 'the race starts with exactly the four players in the pool');
const done = await sA.wait(e => e.type === 'settled' && e.data.id === r2.data.id, 90000);
const stake = 50 + 25 + 25 + 10;
check(done.data.totalPool === stake, `the pool is the players' stakes and nothing else (${done.data.totalPool})`);
const finals = await Promise.all([A, B, C, D].map(balanceOf));
const paidOut = finals.reduce((a, x) => a + x, 0) - 4 * 1000 + stake;
check(paidOut <= stake * (1 - RAKE) + 1e-6, `players are paid at most the pool minus the rake (${paidOut.toFixed(2)} of ${(stake * (1 - RAKE)).toFixed(2)})`);

// --- the public numbers add up -------------------------------------------------------------------
const st = await (await fetch(`${base}/api/stats`)).json();
const demo = st.tokens.DEMO;
check(st.totals.players >= 4 && st.totals.cancelled >= 1 && demo.cancelledRefunded >= 75, 'stats: players counted, the cancelled rounds counted, their stakes shown as returned');
check(Math.abs(demo.houseNet - stake * RAKE) < 1e-6, `stats: with no house stakes in the pool the house kept exactly the rake (${demo.houseNet.toFixed(2)} of ${stake})`);
const live = st.recent.find(r => r.id === r2.data.id);
check(!!live && live.bettors === 4 && live.pool === stake && live.order.length === 5, 'stats: the latest-rounds list has the raced round with its pool and finishing order');
check(!JSON.stringify(st).includes(A.w.address) && !JSON.stringify(st).includes(B.w.address), 'stats: no wallet address appears anywhere in the public numbers');
check((await fetch(`${base}/MarbleRush2D/stats.html`)).status === 200 && (await fetch(`${base}/MarbleRush2D/js/stats.js`)).status === 200, 'the stats page is served');

// --- tables sleep when the room is empty ------------------------------------------------------------
for (const s of [spec, sA, sB, sC, sD, sE, sE2]) s.close();
await sleep(1000);
const before = opens();
await sleep(50000);                                                  // the running rounds end; nobody is there to see another
check(opens() === before, 'with nobody watching, no new round is sealed once the running ones end');
check(!(await (await fetch(`${base}/api/tables`)).json()).tables.some(t => t.id === 'live-2'), 'and the overflow table closes once its room is empty');
check(logs.some(l => l.line.includes('needed 3 players, had 1')) && await balanceOf(E) === 1000, 'the lone bettor at Live 2 was refunded when it fell short');
const back = watch('practice');
const woke = await back.wait(e => e.type === 'round');
check(woke.data.id > r2.data.id && opens() === before + 1, `the next visitor wakes it (round ${woke.data.id})`);
back.close();

realLog(`\n  ${failures ? failures + ' FAILED' : 'all passed'}\n`);
server.close();
process.exit(failures ? 1 : 0);
