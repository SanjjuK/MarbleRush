// server-e2e.mjs: End-to-end test of the round server, as two players would
// use it. Starts the server on a spare port with a short lobby and a short
// course, then:
//
//   1. both players connect and see the same round (same course, same hash)
//   2. both bet; the pool shows their money on top of the house backers
//   3. bad bets are refused: after close, twice, too big, no such marble
//   4. at the gate the race seed is revealed and hashes to the commitment
//   5. a CLIENT-SIDE replay from the two seeds gives the server's result, and
//      matches every once-a-second position check
//   6. settlement: each player's balance moves by exactly what the tote says
//   7. the next round opens
//
//   node MarbleRush2D/tools/server-e2e.mjs
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.MR_LOBBY = '5';
process.env.MR_DATA = mkdtempSync(join(tmpdir(), 'mr-e2e-'));   // never the real wallets
process.env.MR_BLOCKS = '6';
const { start } = await import('../server/server.mjs');
const { makeRng } = await import('../../js/rng.js');
const { MARBLE_DATA } = await import('../../js/racers.js');
const { RAKE, PLACE_SHARES } = await import('../../js/betting.js');
const { buildTrack } = await import('../js/track2d.js');
const { Engine2D, SIM_DT } = await import('../js/engine2d.js');

const PORT = 8191;
const base = `http://localhost:${PORT}`;
let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };

const server = await start(PORT);

/** A player: an SSE stream parsed into events, and a way to wait for one. */
function player(pid) {
  const events = [];
  const waiters = [];
  const ctrl = new AbortController();
  (async () => {
    const res = await fetch(`${base}/api/events?pid=${pid}`, { signal: ctrl.signal });
    const dec = new TextDecoder();
    let buf = '';
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
    pid, events,
    wait: (pred, ms = 60000) => {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((ok, no) => { waiters.push({ pred, ok }); setTimeout(() => no(new Error('timeout')), ms); });
    },
    post: async (p, body) => { const r = await fetch(`${base}/api/${p}?pid=${pid}`, { method: 'POST', body: JSON.stringify(body) }); return { code: r.status, body: await r.json() }; },
    close: () => ctrl.abort(),
  };
}

const A = player('alicealice01'), B = player('bobbobbob02');
console.log('\n  round server, end to end\n');
// Start clean: wait for a fresh betting round (the first may be half gone).
let ra = await A.wait(e => e.type === 'round' && e.data.phase === 'betting');
const id = ra.data.id;
const rb = await B.wait(e => e.type === 'round' && e.data.id === id);
check(ra.data.courseSeed === rb.data.courseSeed && ra.data.commitment === rb.data.commitment, 'both players see the same round');
check(ra.data.raceSeed === null, 'race seed is secret while betting is open');

const helloA = await A.wait(e => e.type === 'hello');
const balA0 = helloA.data.balance, balB0 = (await B.wait(e => e.type === 'hello')).data.balance;

let r = await A.post('bet', { marble: 0, amount: 50 });
check(r.code === 200, 'A bets 50 on marble 0');
r = await B.post('bet', { marble: 1, amount: 25 });
check(r.code === 200, 'B bets 25 on marble 1');
check((await A.post('bet', { marble: 2, amount: 10 })).code === 409, 'a second bet in one round is refused');
const C = player('carolcarol03');
await C.wait(e => e.type === 'hello');
check((await C.post('bet', { marble: 7, amount: 10 })).code === 400, 'a bet on a marble that does not exist is refused');
check((await C.post('bet', { marble: 0, amount: 1e9 })).code === 400, 'a stake bigger than the wallet is refused');
check((await C.post('bet', { marble: 0, amount: 1 })).code === 400, 'a stake under the minimum is refused');

const pool = await A.wait(e => e.type === 'pool' && e.data.bets.filter(b => b.human).length >= 2);
check(pool.data.pools[0] >= 50 && pool.data.pools[1] >= 25, 'the shared pool carries both players\' money');

const racing = await A.wait(e => e.type === 'round' && e.data.id === id && e.data.phase === 'racing', 30000);
check((await C.post('bet', { marble: 0, amount: 10 })).code === 409, 'betting after the gates open is refused');
const seed = racing.data.raceSeed;
check(!!seed && createHash('sha256').update(seed).digest('hex') === ra.data.commitment, 'the revealed race seed hashes to the published commitment');
const cBet = racing.data.bets.find(b => b.human && b.auto);
check(!!cBet, 'the player who never bet was auto-staked the minimum at the close');

// Replay it the way a browser does.
const track = buildTrack(makeRng(racing.data.courseSeed), racing.data.blocks ? { count: racing.data.blocks } : {});
const eng = new Engine2D({ track, rng: makeRng(seed), racers: MARBLE_DATA });
eng.settle(); eng.openGate();
check(eng.marbles.map(m => m.lane).join() === racing.data.lanes.join(), 'the replay draws the same grid');
const order = [], posAt = [];
while (!eng.allFinished && eng.time < 480) {
  eng.step(true);
  for (const m of eng.marbles) if (m.finished && !order.includes(m.index)) order.push(m.index);
  if (eng.tick % 240 === 0) posAt.push(eng.marbles.map(m => [+m.x.toFixed(3), +m.y.toFixed(3)]));
}
const out = eng.marbles.filter(m => m.out).sort((a, b) => b.outTime - a.outTime).map(m => m.index);
const replayOrder = order.concat(out);

const syncs = [];
const done = await A.wait(e => e.type === 'round' && e.data.id === id && e.data.phase === 'results', 600000);
for (const e of A.events) if (e.type === 'sync' && e.data.id === id) syncs.push(e.data);
check(done.data.result.finishOrder.join() === replayOrder.join(), `client replay matches the server result (${replayOrder.map(i => MARBLE_DATA[i].name).join(' > ')})`);
check(syncs.length > 0 && syncs.every(s => JSON.stringify(s.pos) === JSON.stringify(posAt[s.second - 1])), `every position check agrees (${syncs.length} checks)`);

const sA = (await A.wait(e => e.type === 'settled' && e.data.id === id)).data;
const sB = (await B.wait(e => e.type === 'settled' && e.data.id === id)).data;
const fin = done.data;
const net = fin.pools.reduce((a, b) => a + b, 0) * (1 - RAKE);
const expect = (marble, stake) => {
  const at = fin.result.finishOrder.indexOf(marble);
  if (at < 0 || at >= PLACE_SHARES.length) return 0;
  const shares = PLACE_SHARES.map((s, i) => fin.pools[fin.result.finishOrder[i]] > 0 ? s : 0);
  const live = shares.reduce((a, b) => a + b, 0);
  return (stake / fin.pools[marble]) * net * (shares[at] / live);
};
const near = (a, b) => Math.abs(a - b) < 1e-6;
check(near(sA.balance, balA0 - 50 + expect(0, 50)), `A settled right: ${balA0} -> ${sA.balance.toFixed(2)}`);
check(near(sB.balance, balB0 - 25 + expect(1, 25)), `B settled right: ${balB0} -> ${sB.balance.toFixed(2)}`);

const next = await A.wait(e => e.type === 'round' && e.data.id === id + 1, 30000);
check(next.data.phase === 'betting' && next.data.commitment !== ra.data.commitment, 'the next round opens with a new commitment');

A.close(); B.close(); C.close();
server.close();
console.log(`\n  ${failures ? failures + ' FAILED' : 'all passed'}\n`);
process.exit(failures ? 1 : 0);
