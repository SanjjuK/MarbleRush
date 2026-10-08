// load-e2e.mjs: 100 players at once, demo money, full-length courses.
//
//   node MarbleRush2D/tools/load-e2e.mjs [players]
//
// Every player is its own wallet and its own network address (X-Forwarded-For). They all ask for
// the Practice table at the same moment. Checks that the room never holds more than its seats,
// that overflow tables take the rest, that every bet is in exactly one pool, that every table
// settles, and reports how long the server's event loop stalled while the races were computed
// and the results fanned out. It does not touch Solana: that limit is measured by chain-load-e2e.
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
const N = +(process.argv[2] || 100), SEATS = 20;
const dir = mkdtempSync(join(tmpdir(), 'mr-load-e2e-'));
writeFileSync(join(dir, 'tables.json'), JSON.stringify({ tables: [{ id: 'practice', name: 'Practice', minPlayers: 0, maxPlayers: SEATS, bots: 'house', maxTables: 12 }] }));
process.env.MR_TABLES = join(dir, 'tables.json');
process.env.MR_DATA = join(dir, 'data');
process.env.MR_LOBBY = '14';
process.env.MR_TRUST_PROXY = '1';

const { start } = await import('../server/server.mjs');
const { b58encode } = await import('../server/auth.mjs');
const PORT = 8193, base = `http://localhost:${PORT}`;
let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const server = await start(PORT);
const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();

function newWallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { address: b58encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)), sign: (m) => sign(null, Buffer.from(m), privateKey).toString('base64') };
}
async function player(i) {
  const ip = `10.${i >> 8}.${i & 255}.7`, w = newWallet();
  const call = async (p, body, cookie) => { const r = await fetch(`${base}/api/${p}`, { method: 'POST', body: JSON.stringify(body), headers: { 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}) } }); return { code: r.status, body: await r.json(), cookie: r.headers.get('set-cookie') }; };
  const n = await call('auth/nonce', { address: w.address });
  const v = await call('auth/verify', { address: w.address, nonce: n.body.nonce, signature: w.sign(n.body.message) });
  const cookie = v.cookie.split(';')[0];
  const p = { i, table: null, bet: null, settled: null, hops: 0, error: null, close: () => {} };
  const connect = async (table, pin) => {
    const ctrl = new AbortController(); p.close = () => ctrl.abort();
    const res = await fetch(`${base}/api/events?table=${table}${pin ? '&pin=1' : ''}`, { signal: ctrl.signal, headers: { 'x-forwarded-for': ip, cookie } });
    (async () => {
      const dec = new TextDecoder(); let buf = '';
      try {
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let k;
          while ((k = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, k); buf = buf.slice(k + 2);
            const ev = /^event: (.*)$/m.exec(block), data = /^data: (.*)$/m.exec(block);
            if (!ev || !data) continue;
            const d = JSON.parse(data[1]);
            if (ev[1] === 'hello') p.table = d.table;
            if (ev[1] === 'round' && d.phase === 'betting' && !p.bet && !p.moving) await place(d);
            if (ev[1] === 'settled') p.settled = d;
          }
        }
      } catch { /* closed */ }
    })();
  };
  const place = async (d) => {
    p.moving = true;
    const r = await call('bet', { table: p.table, marble: p.i % 5, amount: 5 }, cookie);
    if (r.code === 200) { p.bet = { table: p.table, round: d.id }; p.moving = false; return; }
    if (r.body.full && r.body.move && p.hops < 4) { p.hops++; p.close(); p.table = r.body.move; await connect(r.body.move, true); p.moving = false; return; }
    p.error = `${r.code} ${r.body.error}`; p.moving = false;
  };
  await connect('practice', false);
  return p;
}

console.log(`\n  ${N} players, ${SEATS} seats a table\n`);
const t0 = Date.now();
const players = [];
for (let i = 0; i < N; i += 25) players.push(...await Promise.all(Array.from({ length: Math.min(25, N - i) }, (_, k) => player(i + k))));   // sign-ins in batches of 25
check(players.length === N, `${N} wallets signed in (${Date.now() - t0} ms)`);

await sleep(12000);
const seated = players.filter(p => p.bet), failed = players.filter(p => p.error);
const byTable = {};
for (const p of seated) byTable[p.bet.table] = (byTable[p.bet.table] || 0) + 1;
const counts = Object.values(byTable);
console.log(`     seated per table: ${JSON.stringify(byTable)}`);
check(seated.length === N && !failed.length, `every player got a seat (${seated.length}/${N}${failed.length ? '; first error: ' + failed[0].error : ''})`);
check(counts.length === Math.ceil(N / SEATS) && counts.every(c => c <= SEATS), `${counts.length} tables, none over ${SEATS} (largest ${Math.max(...counts)})`);

const list = (await (await fetch(`${base}/api/tables`)).json()).tables;
check(list.length === counts.length && list.every(t => t.bettors <= SEATS), 'the table list agrees with where the bets went');

// every table settles
const deadline = Date.now() + 300000;
while (Date.now() < deadline && !Object.keys(byTable).every(t => players.some(p => p.bet && p.bet.table === t && p.settled))) await sleep(2000);
const settledTables = Object.keys(byTable).filter(t => players.some(p => p.bet && p.bet.table === t && p.settled));
check(settledTables.length === Object.keys(byTable).length, `all ${Object.keys(byTable).length} tables raced and settled`);
const pools = Object.keys(byTable).map(t => players.find(p => p.bet && p.bet.table === t && p.settled).settled.totalPool);
check(pools.every((x, k) => x >= byTable[Object.keys(byTable)[k]] * 5), `each pool holds at least its players' stakes (${pools.map(x => x.toFixed(0)).join(', ')})`);

const ms = (ns) => (ns / 1e6).toFixed(0);
console.log(`\n     event loop delay: mean ${ms(lag.mean)} ms, p99 ${ms(lag.percentile(99))} ms, max ${ms(lag.max)} ms`);
console.log(`     memory: ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB resident`);
check(lag.max / 1e6 < 1500, 'the server never stalled for more than 1.5 s');

for (const p of players) p.close();
console.log(`\n  ${failures ? failures + ' FAILED' : 'all passed'}\n`);
server.close();
process.exit(failures ? 1 : 0);
