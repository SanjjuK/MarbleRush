// chain-bets-e2e.mjs: real tokens moving on REAL devnet.
//
//   node MarbleRush2D/tools/chain-bets-e2e.mjs
//
// Three throwaway wallets (kept in data/test-wallets.json, git-ignored, so the
// token-account rent is paid once). Each signs in, takes a faucet drop if short, and:
//   A, B  bet on different marbles with a signed, server-fee-paid transaction
//   C     prepares a bet, waits for betting to close, THEN submits: it must land,
//         be refused, and be refunded
// then checks every balance against the tote's arithmetic after the payouts.
// Also: a tampered transaction is refused, a second bet is refused, and the
// stake really leaves the wallet and enters the vault.
//
// Needs `chain-setup.mjs` to have run. Costs fees from the authority's SOL.
import { mkdtempSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, sign } from 'node:crypto';
import { Keypair, Transaction, SystemProgram } from '@solana/web3.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAIN_DIR = process.env.MR_CHAIN_DIR || join(HERE, '..', 'server', 'data');
process.env.MR_TABLES = join(HERE, 'timer-tables.json');
process.env.MR_LOBBY = '26'; process.env.MR_BLOCKS = '6';
process.env.MR_DATA = mkdtempSync(join(tmpdir(), 'mr-bets-e2e-'));
process.env.MR_CHAIN_DIR = CHAIN_DIR;

const { start } = await import('../server/server.mjs');
const { RAKE, PLACE_SHARES } = await import('../../js/betting.js');
const PORT = 8195, base = `http://localhost:${PORT}`;
let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- test wallets, reused between runs
const walletFile = join(CHAIN_DIR, 'test-wallets.json');
let saved = []; try { saved = JSON.parse(await readFile(walletFile, 'utf8')); } catch { /* first run */ }
while (saved.length < 3) saved.push(Array.from(Keypair.generate().secretKey));
await writeFile(walletFile, JSON.stringify(saved), { mode: 0o600 });
const kps = saved.slice(0, 3).map(k => Keypair.fromSecretKey(Uint8Array.from(k)));
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const signMsg = (kp, msg) => sign(null, Buffer.from(msg), createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(kp.secretKey.subarray(0, 32))]), format: 'der', type: 'pkcs8' })).toString('base64');

const server = await start(PORT);
const info = await (await fetch(`${base}/api/chain`)).json();
const SYM = info.default;
const tokMeta = info.tokens.find(t => t.symbol === SYM);

async function login(kp) {
  const address = kp.publicKey.toBase58();
  const post = async (p, body, cookie) => { const r = await fetch(`${base}/api/${p}`, { method: 'POST', body: JSON.stringify(body), headers: cookie ? { cookie } : {} }); return { code: r.status, body: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie') }; };
  const n = await post('auth/nonce', { address });
  const v = await post('auth/verify', { address, nonce: n.body.nonce, signature: signMsg(kp, n.body.message) });
  const cookie = v.cookie.split(';')[0];
  return { kp, address, cookie, post: (p, body) => post(p, body, cookie), get: async (p) => (await fetch(`${base}/api/${p}`, { headers: { cookie } })).json() };
}

// one SSE stream, everybody's events
const events = [], waiters = [];
(async () => {
  const res = await fetch(`${base}/api/events`);
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
const wait = (pred, ms = 180000) => {
  const hit = events.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((ok, no) => { waiters.push({ pred, ok }); setTimeout(() => no(new Error('timeout')), ms); });
};

console.log(`\n  signed bets and payouts on devnet (${SYM})\n`);
const [A, B, C] = await Promise.all(kps.map(login));
for (const w of [A, B, C]) {
  if ((await w.get(`balance?token=${SYM}`)).balance < 200) {
    const f = await w.post('faucet', { token: SYM });
    check(f.code === 200 || f.code === 429, `${w.address.slice(0, 4)}…: has ${SYM} to play with (${f.code === 200 ? 'faucet drop' : 'already had some'})`);
  }
}
const bal0 = {};
for (const w of [A, B, C]) bal0[w.address] = (await w.get(`balance?token=${SYM}`)).balance;
const vault0 = await (async () => { const { openChain } = await import('../server/chain.mjs'); const c = await openChain({ dataDir: CHAIN_DIR }); return { c, bal: await c.vaultBalance(SYM) }; })();

// a fresh round, with its commit landed
let open = await wait(e => e.type === 'round' && e.data.phase === 'betting' && e.data.closesAt - Date.now() > 18000);
const id = open.data.id;
await wait(e => e.type === 'chain' && e.data.id === id && e.data.commit.status !== 'pending');
check(open.data.token === SYM && open.data.minBet === tokMeta.minBet, `round ${id} is in ${SYM}, minimum ${open.data.minBet}`);

const signTx = (w, prep) => { const tx = Transaction.from(Buffer.from(prep.tx, 'base64')); tx.partialSign(w.kp); return tx.serialize({ requireAllSignatures: false }).toString('base64'); };
const STAKE = 10;

const pa = await A.post('bet/prepare', { marble: 0, amount: STAKE });
check(pa.code === 200 && !!pa.body.prepId, 'A: the server builds a bet to sign');
const sa = await A.post('bet/submit', { prepId: pa.body.prepId, tx: signTx(A, pa.body) });
check(sa.code === 200 && !!sa.body.signature, `A: the signed bet lands on chain (${(sa.body.signature || '').slice(0, 12)}…)`);
await sleep(1600);                                          // prepares are rate limited per player
check((await A.post('bet/prepare', { marble: 1, amount: STAKE })).code === 409, 'A: a second bet in the same round is refused');
check((await A.post('bet/submit', { prepId: pa.body.prepId, tx: signTx(A, pa.body) })).code === 410, 'A: the same signed bet cannot be submitted twice');

const pb = await B.post('bet/prepare', { marble: 1, amount: STAKE });
// tampered: a different amount, signed by the right wallet, under the prepared id
{
  const { createTransferCheckedInstruction, getAssociatedTokenAddressSync } = await import('@solana/spl-token');
  const { PublicKey } = await import('@solana/web3.js');
  const orig = Transaction.from(Buffer.from(pb.body.tx, 'base64'));
  const mint = new PublicKey(info.tokens.find(t => t.symbol === SYM).mint);
  const t2 = new Transaction({ feePayer: orig.feePayer, blockhash: orig.recentBlockhash, lastValidBlockHeight: orig.lastValidBlockHeight });
  t2.add(createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, B.kp.publicKey), mint, getAssociatedTokenAddressSync(mint, new PublicKey(info.vault)), B.kp.publicKey, 100_000_000n, 6));
  t2.partialSign(B.kp);
  const bad = await B.post('bet/submit', { prepId: pb.body.prepId, tx: t2.serialize({ requireAllSignatures: false }).toString('base64') });
  check(bad.code === 400, 'B: a transaction that differs from the one prepared is refused');
}
await sleep(1600);
const pb2 = await B.post('bet/prepare', { marble: 1, amount: STAKE });
const sb = await B.post('bet/submit', { prepId: pb2.body.prepId, tx: signTx(B, pb2.body) });
check(sb.code === 200, 'B: the honest bet lands');

const pool = await wait(e => e.type === 'pool' && e.data.id === id && e.data.bets.filter(b => b.human).length >= 2, 30000);
check(pool.data.bets.filter(b => b.human).length === 2, 'the pool shows the two real bets');
check(Math.abs((await A.get(`balance?token=${SYM}`)).balance - (bal0[A.address] - STAKE)) < 1e-6, `A: ${STAKE} ${SYM} left the wallet`);

// C prepares, then betting closes, then C submits
const pc = await C.post('bet/prepare', { marble: 2, amount: STAKE });
check(pc.code === 200, 'C: prepares a bet before the close');
await wait(e => e.type === 'round' && e.data.id === id && e.data.phase !== 'betting', 60000);
const sc = await C.post('bet/submit', { prepId: pc.body.prepId, tx: signTx(C, pc.body) });
check(sc.code === 409 && sc.body.refunded === true, 'C: a bet that lands after the close is refused and marked for refund');

// the race, the payouts
const done = await wait(e => e.type === 'round' && e.data.id === id && e.data.phase === 'results', 240000);
const fin = done.data;
const net = fin.pools.reduce((a, b) => a + b, 0) * (1 - RAKE);
const expect = (marble, stake) => {
  const at = fin.result.finishOrder.indexOf(marble);
  if (at < 0 || at >= PLACE_SHARES.length) return 0;
  const shares = PLACE_SHARES.map((s, i) => fin.pools[fin.result.finishOrder[i]] > 0 ? s : 0);
  const live = shares.reduce((a, b) => a + b, 0);
  return (stake / fin.pools[marble]) * net * (shares[at] / live);
};
const expA = Math.floor(expect(0, STAKE) * 1e6) / 1e6, expB = Math.floor(expect(1, STAKE) * 1e6) / 1e6;
const owed = expA + expB > 0;
if (process.env.DEBUG_E2E) console.log('   debug', JSON.stringify({ id, finId: fin.id, order: fin.result.finishOrder, pools: fin.pools, bets: fin.bets.filter(b => b.human), net, expA, expB }));
// wait for the payout jobs (and C's refund job) to confirm
const doneAt = events.indexOf(done);
const settle = async () => { for (let i = 0; i < 40; i++) { const p = events.slice(doneAt).find(e => e.type === 'payout' && e.data.id === id && e.data.status === 'confirmed'); if (p) return p; await sleep(2500); } return null; };
const payout = await settle();
check(!owed || !!payout, owed ? 'the payout transactions confirmed' : 'nobody backed a paid marble: no payout was due');
await sleep(4000);
const balA = (await A.get(`balance?token=${SYM}`)).balance, balB = (await B.get(`balance?token=${SYM}`)).balance, balC = (await C.get(`balance?token=${SYM}`)).balance;
check(Math.abs(balA - (bal0[A.address] - STAKE + expA)) < 1e-5, `A ends at ${balA} (stake ${STAKE}, paid ${expA.toFixed(4)})`);
check(Math.abs(balB - (bal0[B.address] - STAKE + expB)) < 1e-5, `B ends at ${balB} (stake ${STAKE}, paid ${expB.toFixed(4)})`);
check(Math.abs(balC - bal0[C.address]) < 1e-5, `C is whole again after the refund (${balC})`);
const vaultNow = await vault0.c.vaultBalance(SYM);
check(Math.abs((vaultNow - vault0.bal) - (STAKE * 2 - expA - expB)) < 1e-4, `the vault moved by exactly the stakes minus the payouts (${(vaultNow - vault0.bal).toFixed(4)})`);

server.close();
console.log(`\n  ${failures ? failures + ' FAILED' : 'all passed'}\n`);
process.exit(failures ? 1 : 0);
