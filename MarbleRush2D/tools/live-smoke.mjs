// live-smoke.mjs: one real round against a RUNNING server, the way a player does it, with a devnet test wallet.
//
//   node MarbleRush2D/tools/live-smoke.mjs https://34-29-110-88.sslip.io
//
// Signs in a test wallet (from data/test-wallets.json), waits for a Practice round, places a signed bet, watches the
// race, checks the payout lands on chain and then runs verify-round.mjs on the reveal, which replays the race on THIS
// machine and compares it with what the server published. Costs a few devnet fees and 10 RUSH of test tokens.
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, sign } from 'node:crypto';
import { Keypair, Transaction } from '@solana/web3.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const base = (process.argv[2] || 'http://localhost:8090').replace(/\/$/, '');
const DATA = process.env.MR_CHAIN_DIR || join(HERE, '..', 'server', 'data');
let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(join(DATA, 'test-wallets.json'), 'utf8'))[0]));
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const signMsg = (msg) => sign(null, Buffer.from(msg), createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(kp.secretKey.subarray(0, 32))]), format: 'der', type: 'pkcs8' })).toString('base64');
const address = kp.publicKey.toBase58();

const call = async (p, body, cookie) => { const r = await fetch(`${base}/api/${p}`, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, headers: cookie ? { cookie } : {} }); return { code: r.status, body: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie') }; };

console.log(`\n  one real round on ${base}\n`);
const chain = await call('chain');
check(chain.code === 200 && chain.body.cluster === 'devnet', 'the server is on devnet (never mainnet)');
const n = await call('auth/nonce', { address });
const v = await call('auth/verify', { address, nonce: n.body.nonce, signature: signMsg(n.body.message) });
check(v.code === 200 && !!v.cookie, `the test wallet ${address.slice(0, 4)}… signs in`);
const cookie = v.cookie.split(';')[0];
check(/Secure/i.test(v.cookie) && /HttpOnly/i.test(v.cookie), 'the session cookie is Secure and HttpOnly');
const bal = async () => (await call('balance?token=RUSH', null, cookie)).body.balance;
let before = await bal();
if (!(before >= 20)) { const f = await call('faucet', { token: 'RUSH' }, cookie); check(f.code === 200, `faucet drop (${f.code})`); before = await bal(); }
console.log(`   RUSH before: ${before}`);

// the live stream, as this player
const events = [], waiters = [];
(async () => {
  const res = await fetch(`${base}/api/events?table=practice`, { headers: { cookie } });
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /^event: (.*)$/m.exec(block), data = /^data: (.*)$/m.exec(block);
      if (!ev || !data) continue;
      const e = { type: ev[1], data: JSON.parse(data[1]), at: Date.now() };
      events.push(e);
      for (const w of waiters.slice()) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); w.ok(e); }
    }
  }
})().catch(() => {});
const wait = (pred, ms = 400000) => { const hit = events.find(pred); return hit ? Promise.resolve(hit) : new Promise((ok, no) => { waiters.push({ pred, ok }); setTimeout(() => no(new Error('timeout')), ms); }); };

// a round that is open for bets, with its commit sealed
let open;
for (;;) {
  open = await wait(e => e.type === 'round' && e.data.phase === 'betting' && !events.slice(events.indexOf(e) + 1).some(x => x.type === 'round' && x.data.id === e.data.id && x.data.phase !== 'betting'));
  if (open.data.closesAt - Date.now() > 12000) break;
  await sleep(1500); events.length = 0;                      // too late in this lobby: take the next round
  open = null; await wait(e => e.type === 'round' && e.data.phase === 'betting' && e.data.id > 0, 120000).then(() => {}).catch(() => {});
}
const id = open.data.id;
console.log(`   round ${id}`);
await wait(e => e.type === 'chain' && e.data.id === id && e.data.commit.status === 'confirmed', 60000);
check(true, `round ${id} is sealed on Solana before betting`);

const marble = 0, stake = 10;
const p = await call('bet/prepare', { table: 'practice', marble, amount: stake }, cookie);
check(p.code === 200, `bet prepared (${p.code}${p.body.error ? ': ' + p.body.error : ''})`);
const tx = Transaction.from(Buffer.from(p.body.tx, 'base64')); tx.partialSign(kp);
const s = await call('bet/submit', { table: 'practice', prepId: p.body.prepId, tx: tx.serialize({ requireAllSignatures: false }).toString('base64') }, cookie);
check(s.code === 200, `signed bet landed on chain (${(s.body.signature || s.body.error || '').slice(0, 12)}…)`);
check(Math.abs((await bal()) - (before - stake)) < 1e-6, `the stake left the wallet (${before} -> ${await bal()})`);

const racing = await wait(e => e.type === 'round' && e.data.id === id && e.data.phase === 'racing', 120000);
check(racing.data.bets.some(b => b.human) && racing.data.bets.some(b => !b.human), 'the pool has the player and the labelled house stakes');
const results = await wait(e => e.type === 'round' && e.data.id === id && e.data.phase === 'results', 400000);
const order = results.data.result.finishOrder;
console.log(`   finishing order ${order.join(' ')}   (we backed ${marble})`);
const settled = await wait(e => e.type === 'settled' && e.data.id === id, 30000);
const won = settled.data.you && settled.data.you.payout > 0;
console.log(`   settled: ${JSON.stringify(settled.data.you)}`);
const chainEv = await wait(e => e.type === 'chain' && e.data.id === id && e.data.reveal && e.data.reveal.status === 'confirmed', 90000);
check(!!chainEv.data.reveal.sig, `the result is revealed on Solana (${chainEv.data.reveal.sig.slice(0, 12)}…)`);
if (won) {
  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) { await sleep(3000); ok = Math.abs((await bal()) - (before - stake + settled.data.you.payout)) < 1e-4; }
  check(ok, `the payout of ${settled.data.you.payout} RUSH reached the wallet on chain`);
} else check(true, 'this marble lost: nothing to pay (the loss is final)');

const ver = spawnSync('node', [join(HERE, 'verify-round.mjs'), chainEv.data.reveal.sig], { encoding: 'utf8', env: { ...process.env, MR_CHAIN_DIR: DATA }, timeout: 120000 });
console.log(ver.stdout.split('\n').filter(l => l.trim()).map(l => '   ' + l).join('\n'));
check(ver.status === 0, 'verify-round replayed the race on this computer and it matches what the server published');

const st = await call('stats');
check(st.code === 200 && JSON.stringify(st.body).includes(String(id)), 'the round shows on the public stats');
console.log(`\n  ${failures ? failures + ' FAILED' : 'all passed'}\n`);
process.exit(failures ? 1 : 0);
