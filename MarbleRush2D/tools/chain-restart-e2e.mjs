// chain-restart-e2e.mjs: a server that dies mid-round must not keep anyone's stake.
//
//   node MarbleRush2D/tools/chain-restart-e2e.mjs
//
// A real devnet bet is placed, the server is killed with SIGKILL while the round is open, and a new
// server is started on the same data. The new one must refund the stake, and its round numbers must
// continue from where the old one stopped. Costs a few thousand lamports of fees.
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
import { Keypair, Transaction } from '@solana/web3.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAIN_DIR = process.env.MR_CHAIN_DIR || join(HERE, '..', 'server', 'data');
const DATA = mkdtempSync(join(tmpdir(), 'mr-restart-e2e-'));
const PORT = 8197, base = `http://localhost:${PORT}`;
let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const saved = JSON.parse(await readFile(join(CHAIN_DIR, 'test-wallets.json'), 'utf8'));
const kp = Keypair.fromSecretKey(Uint8Array.from(saved[0]));
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const signMsg = (msg) => sign(null, Buffer.from(msg), createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(kp.secretKey.subarray(0, 32))]), format: 'der', type: 'pkcs8' })).toString('base64');

let child = null;
const startServer = () => new Promise((ok, no) => {
  child = spawn('node', [join(HERE, '..', 'server', 'server.mjs')], {
    env: { ...process.env, MR_PORT: String(PORT), MR_DATA: DATA, MR_CHAIN_DIR: CHAIN_DIR, MR_LOBBY: '40', MR_BLOCKS: '6' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const onData = (d) => { log += d; if (/MarbleRush server on/.test(log)) ok(() => log); };
  child.stdout.on('data', onData); child.stderr.on('data', (d) => { log += d; });
  child.on('exit', () => no(new Error('server exited')));
  setTimeout(() => no(new Error('server did not start')), 40000);
});
const j = async (p, body, cookie) => { const r = await fetch(`${base}/api/${p}`, { method: body ? 'POST' : 'GET', body: body && JSON.stringify(body), headers: cookie ? { cookie } : {} }); return { code: r.status, body: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie') }; };
async function login() {
  const address = kp.publicKey.toBase58();
  const n = await j('auth/nonce', { address });
  const v = await j('auth/verify', { address, nonce: n.body.nonce, signature: signMsg(n.body.message) });
  return v.cookie.split(';')[0];
}
const roundNow = async () => {
  const res = await fetch(`${base}/api/events`, { signal: AbortSignal.timeout(2500) }).catch(() => null);
  return res;
};
async function currentRound() {   // read the first 'round' event, then hang up
  const ctrl = new AbortController();
  let found = null;
  try {
    const res = await fetch(`${base}/api/events`, { signal: ctrl.signal });
    const dec = new TextDecoder(); let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      const m = /event: round\ndata: (.*)\n\n/.exec(buf);
      if (m) { found = JSON.parse(m[1]); ctrl.abort(); }
    }
  } catch (e) { if (!found) throw e; }
  return found;
}

console.log('\n  restart in the middle of a round (devnet)\n');
await startServer();
const cookie = await login();
const bal = async () => (await j('balance?token=RUSH', null, cookie)).body.balance;
const before = await bal();
check(before >= 50, `the test wallet holds RUSH (${before})`);

// wait until the round has been sealed, then bet
let round;
for (let i = 0; i < 40; i++) { round = await currentRound(); if (round.phase === 'betting') break; await sleep(1000); }
await sleep(3000);                                        // the commit memo lands in a second or two
const prep = await j('bet/prepare', { marble: 1, amount: 10 }, cookie);
check(prep.code === 200, 'a bet is prepared');
const tx = Transaction.from(Buffer.from(prep.body.tx, 'base64')); tx.partialSign(kp);
const sent = await j('bet/submit', { prepId: prep.body.prepId, tx: tx.serialize({ requireAllSignatures: false }).toString('base64') }, cookie);
check(sent.code === 200, 'the bet lands on chain');
const during = await bal();
check(Math.abs(during - (before - 10)) < 1e-6, `10 RUSH left the wallet (${during})`);
const idBefore = round.id;

// die without warning, mid-round
child.removeAllListeners('exit'); child.kill('SIGKILL'); await sleep(1500);
const log = await startServer();
check(/unfinished: refunding 1 bet/.test(log()), 'the new server notices the unfinished round and refunds it');

let back = during;
for (let i = 0; i < 40 && Math.abs(back - before) > 1e-6; i++) { await sleep(2000); back = await bal(); }   // the old session cookie still works: sessions are saved to disk
check(Math.abs(back - before) < 1e-6, `the stake is back in the wallet (${back})`);
const r2 = await currentRound();
check(r2.id > idBefore, `round numbers continue across the restart (${idBefore} then ${r2.id})`);

child.removeAllListeners('exit'); child.kill('SIGKILL');
console.log(`\n  ${failures ? failures + ' FAILED' : 'all passed'}\n`);
process.exit(failures ? 1 : 0);
