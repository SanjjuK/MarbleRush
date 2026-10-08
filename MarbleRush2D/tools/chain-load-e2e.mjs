// chain-load-e2e.mjs: can one table's worth of players bet at the same moment on REAL devnet?
//
//   node MarbleRush2D/tools/chain-load-e2e.mjs [players]      (default 20)
//
// Every player is a throwaway wallet (kept in data/test-wallets.json, git-ignored; the first run
// funds the new ones from the faucet, about 0.002 SOL of rent each, paid by the house wallet).
// All of them prepare, sign and submit a real bet in the same few seconds, on a Live table with no
// house stakes. Reports how long a bet takes from prepare to confirmed, whether every bet landed
// before the lobby closed, and checks the money: the players together must end exactly the rake
// poorer, because the pool is paid out in full.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, sign } from 'node:crypto';
import { Keypair, Transaction } from '@solana/web3.js';

const N = +(process.argv[2] || 20), STAKE = 10;
const HERE = dirname(fileURLToPath(import.meta.url));
const CHAIN_DIR = process.env.MR_CHAIN_DIR || join(HERE, '..', 'server', 'data');
const tmp = mkdtempSync(join(tmpdir(), 'mr-chain-load-'));
writeFileSync(join(tmp, 'tables.json'), JSON.stringify({ tables: [{ id: 'live', name: 'Live', token: 'RUSH', minPlayers: 3, maxPlayers: Math.max(20, N), bots: 'none' }] }));
Object.assign(process.env, { MR_TABLES: join(tmp, 'tables.json'), MR_DATA: join(tmp, 'data'), MR_CHAIN_DIR: CHAIN_DIR, MR_LOBBY: '40', MR_BLOCKS: '6',
  MR_TRUST_PROXY: '1', MR_FAUCET_PER_IP: '50', MR_FAUCET_PER_DAY: '500' });

const { start } = await import('../server/server.mjs');
const { RAKE } = await import('../../js/betting.js');
const PORT = 8198, base = `http://localhost:${PORT}`;
let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

const walletFile = join(CHAIN_DIR, 'test-wallets.json');
let saved = []; try { saved = JSON.parse(await readFile(walletFile, 'utf8')); } catch { /* first run */ }
const created = Math.max(0, N - saved.length);
while (saved.length < N) saved.push(Array.from(Keypair.generate().secretKey));
await writeFile(walletFile, JSON.stringify(saved), { mode: 0o600 });
const kps = saved.slice(0, N).map(k => Keypair.fromSecretKey(Uint8Array.from(k)));
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const signMsg = (kp, msg) => sign(null, Buffer.from(msg), createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(kp.secretKey.subarray(0, 32))]), format: 'der', type: 'pkcs8' })).toString('base64');
const server = await start(PORT);

async function login(kp, i) {
  const address = kp.publicKey.toBase58(), ip = `10.9.${i >> 8}.${i & 255}`;
  const post = async (p, body, cookie) => { const r = await fetch(`${base}/api/${p}`, { method: 'POST', body: JSON.stringify(body), headers: { 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}) } }); return { code: r.status, body: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie') }; };
  const n = await post('auth/nonce', { address });
  const v = await post('auth/verify', { address, nonce: n.body.nonce, signature: signMsg(kp, n.body.message) });
  const cookie = v.cookie.split(';')[0];
  return { kp, address, post: (p, body) => post(p, body, cookie), balance: async () => (await (await fetch(`${base}/api/balance?token=RUSH`, { headers: { cookie, 'x-forwarded-for': ip } })).json()).balance };
}
const events = [], waiters = [];
(async () => {
  const res = await fetch(`${base}/api/events?table=live`);
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
const wait = (pred, ms = 240000) => { const hit = events.find(pred); return hit ? Promise.resolve(hit) : new Promise((ok, no) => { waiters.push({ pred, ok }); setTimeout(() => no(new Error('timeout')), ms); }); };

console.log(`\n  ${N} players betting at once on devnet\n`);
const players = [];
for (let i = 0; i < N; i += 5) players.push(...await Promise.all(kps.slice(i, i + 5).map((kp, k) => login(kp, i + k))));
console.log(`     (${created} new wallets; funding any that are short of RUSH)`);
let funded = 0;
for (let i = 0; i < N; i += 4) {
  await Promise.all(players.slice(i, i + 4).map(async (w) => {
    if ((await w.balance()) >= 3 * STAKE) return;
    const f = await w.post('faucet', { token: 'RUSH' });
    if (f.code === 200) funded++; else console.log('     faucet:', f.code, f.body.error);
  }));
}
const start0 = await Promise.all(players.map(w => w.balance()));
check(start0.every(b => b >= STAKE), `all ${N} wallets hold RUSH (${funded} just funded)`);

const open = await wait(e => e.type === 'round' && e.data.phase === 'betting' && e.data.closesAt - Date.now() > 30000);
const id = open.data.id;
await wait(e => e.type === 'chain' && e.data.id === id && e.data.commit.status === 'confirmed');
const closesAt = open.data.closesAt;

const signTx = (w, prep) => { const tx = Transaction.from(Buffer.from(prep.tx, 'base64')); tx.partialSign(w.kp); return tx.serialize({ requireAllSignatures: false }).toString('base64'); };
const t0 = Date.now();
const results = await Promise.all(players.map(async (w, i) => {
  const a = Date.now();
  const p = await w.post('bet/prepare', { table: 'live', marble: i % 5, amount: STAKE });
  if (p.code !== 200) return { ok: false, why: `prepare ${p.code} ${p.body.error}` };
  const b = Date.now();
  const s = await w.post('bet/submit', { table: 'live', prepId: p.body.prepId, tx: signTx(w, p.body) });
  return { ok: s.code === 200, why: s.code === 200 ? '' : `submit ${s.code} ${s.body.error}`, prepare: b - a, submit: Date.now() - b, total: Date.now() - a, doneAt: Date.now() };
}));
const landed = results.filter(r => r.ok);
const lat = (k) => landed.map(r => r[k]);
console.log(`     prepare: median ${pct(lat('prepare'), 0.5)} ms, p95 ${pct(lat('prepare'), 0.95)} ms`);
console.log(`     submit (send + confirm): median ${pct(lat('submit'), 0.5)} ms, p95 ${pct(lat('submit'), 0.95)} ms, slowest ${Math.max(...lat('submit'))} ms`);
console.log(`     all ${N} bets done ${((Math.max(...landed.map(r => r.doneAt)) - t0) / 1000).toFixed(1)} s after the first request; lobby had ${((closesAt - t0) / 1000).toFixed(0)} s left`);
for (const r of results.filter(r => !r.ok)) console.log('     failed:', r.why);
check(landed.length === N, `all ${N} signed bets landed (${landed.length})`);
check(Math.max(...landed.map(r => r.doneAt)) < closesAt - 4000, 'and all of them before bets closed');

await wait(e => e.type === 'round' && e.data.id === id && e.data.phase === 'results', 240000);
const pay = await wait(e => e.type === 'payout' && e.data.id === id && e.data.status === 'confirmed', 180000).catch(() => null);
check(!!pay, `payouts confirmed (${pay ? pay.data.sigs.length : 0} transaction(s) for the winners)`);
await sleep(3000);
const end = await Promise.all(players.map(w => w.balance()));
const net = end.reduce((a, x, i) => a + x - start0[i], 0);
const pool = N * STAKE;
check(Math.abs(net + pool * RAKE) < 1e-4, `the players together are exactly the rake poorer: ${net.toFixed(4)} (expected ${(-pool * RAKE).toFixed(4)}) on a pool of ${pool}`);

console.log(`\n  ${failures ? failures + ' FAILED' : 'all passed'}\n`);
server.close();
process.exit(failures ? 1 : 0);
