// chain-cancel-e2e.mjs: a live round that does not reach its minimum gives the money back, on REAL devnet.
//
//   node MarbleRush2D/tools/chain-cancel-e2e.mjs
//
// A table that needs 3 wallets, a lobby of 14 seconds and two players: both sign a real bet, the
// lobby ends short, the round is cancelled, and the two stakes must come back on chain. Needs
// `chain-setup.mjs` to have run and the test wallets from chain-bets-e2e. Costs a few fees.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, sign } from 'node:crypto';
import { Keypair, Transaction } from '@solana/web3.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAIN_DIR = process.env.MR_CHAIN_DIR || join(HERE, '..', 'server', 'data');
const tmp = mkdtempSync(join(tmpdir(), 'mr-cancel-e2e-'));
writeFileSync(join(tmp, 'tables.json'), JSON.stringify({ tables: [{ id: 'live', name: 'Live', token: 'RUSH', minPlayers: 3, maxPlayers: 20, bots: 'none', lobbyExtends: 0 }] }));
process.env.MR_TABLES = join(tmp, 'tables.json');
process.env.MR_LOBBY = '14'; process.env.MR_BLOCKS = '6';
process.env.MR_DATA = join(tmp, 'data');
process.env.MR_CHAIN_DIR = CHAIN_DIR;

const logs = [];
const realLog = console.log;
console.log = (...a) => { logs.push(a.join(' ')); realLog(...a); };
const { start } = await import('../server/server.mjs');
const PORT = 8196, base = `http://localhost:${PORT}`;
let failures = 0;
const check = (ok, what) => { realLog(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const saved = JSON.parse(await readFile(join(CHAIN_DIR, 'test-wallets.json'), 'utf8'));
const kps = saved.slice(0, 2).map(k => Keypair.fromSecretKey(Uint8Array.from(k)));
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const signMsg = (kp, msg) => sign(null, Buffer.from(msg), createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(kp.secretKey.subarray(0, 32))]), format: 'der', type: 'pkcs8' })).toString('base64');
const server = await start(PORT);

async function login(kp) {
  const address = kp.publicKey.toBase58();
  const post = async (p, body, cookie) => { const r = await fetch(`${base}/api/${p}`, { method: 'POST', body: JSON.stringify(body), headers: cookie ? { cookie } : {} }); return { code: r.status, body: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie') }; };
  const n = await post('auth/nonce', { address });
  const v = await post('auth/verify', { address, nonce: n.body.nonce, signature: signMsg(kp, n.body.message) });
  const cookie = v.cookie.split(';')[0];
  return { kp, address, post: (p, body) => post(p, body, cookie), balance: async () => (await (await fetch(`${base}/api/balance?token=RUSH`, { headers: { cookie } })).json()).balance };
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
const wait = (pred, ms = 120000) => { const hit = events.find(pred); return hit ? Promise.resolve(hit) : new Promise((ok, no) => { waiters.push({ pred, ok }); setTimeout(() => no(new Error('timeout')), ms); }); };

realLog('\n  a live round that falls short, on devnet\n');
const [A, B] = await Promise.all(kps.map(login));
const before = [await A.balance(), await B.balance()];
check(before.every(x => x >= 20), `the test wallets hold RUSH (${before.map(x => x.toFixed(1)).join(', ')})`);

const open = await wait(e => e.type === 'round' && e.data.phase === 'betting');
const id = open.data.id;
check(open.data.table.minPlayers === 3 && open.data.bets.length === 0, `round ${id}: live table, 3 needed, no house stakes`);
await wait(e => e.type === 'chain' && e.data.id === id && e.data.commit.status === 'confirmed');

const signTx = (w, prep) => { const tx = Transaction.from(Buffer.from(prep.tx, 'base64')); tx.partialSign(w.kp); return tx.serialize({ requireAllSignatures: false }).toString('base64'); };
for (const [w, marble] of [[A, 0], [B, 1]]) {
  const p = await w.post('bet/prepare', { table: 'live', marble, amount: 10 });
  const s = await w.post('bet/submit', { table: 'live', prepId: p.body.prepId, tx: signTx(w, p.body) });
  check(p.code === 200 && s.code === 200, `${w.address.slice(0, 4)}…: a signed 10 RUSH bet lands (${(s.body.signature || '').slice(0, 10)}…)`);
  await sleep(1600);
}
check(Math.abs(await A.balance() - (before[0] - 10)) < 1e-6, 'the stakes have left the wallets');

const cancelled = await wait(e => e.type === 'notice' && e.data.kind === 'cancelled' && e.data.id === id, 60000);
check(/needed 3 players, had 2/.test(cancelled.data.message), 'the lobby ended short: the round is cancelled');
let back = false;
for (let i = 0; i < 40 && !back; i++) { await sleep(2000); back = Math.abs(await A.balance() - before[0]) < 1e-6 && Math.abs(await B.balance() - before[1]) < 1e-6; }
check(back, 'both stakes are back in the wallets, on chain');
check(logs.some(l => l.startsWith(`[refund] round ${id}: sent`)), 'by refund transactions from the vault');
check(!logs.some(l => l.startsWith(`[payout] round ${id}`)), 'and nothing was paid out as winnings');
const next = await wait(e => e.type === 'round' && e.data.id > id && e.data.phase === 'betting', 30000);
check(!!next, `the next round opens (${next.data.id})`);

realLog(`\n  ${failures ? failures + ' FAILED' : 'all passed'}\n`);
server.close();
process.exit(failures ? 1 : 0);
