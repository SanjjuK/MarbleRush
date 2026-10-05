// chain-e2e.mjs: a round on REAL devnet. Needs `chain-setup.mjs` to have run
// and costs a few thousand lamports. The game state goes in a temp folder; only
// the chain files (authority key, chain.json, RPC url) are read from the real one.
//
//   node MarbleRush2D/tools/chain-e2e.mjs
//
//   1. a round opens; its COMMIT memo confirms on devnet, names this round's
//      course seed and hash, and betting is refused until it has landed
//   2. the round runs; its REVEAL memo confirms
//   3. verify-round.mjs, which trusts nothing, passes on that reveal
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection } from '@solana/web3.js';

const HERE = dirname(fileURLToPath(import.meta.url));
process.env.MR_LOBBY = '5';
process.env.MR_BLOCKS = '6';
process.env.MR_DATA = mkdtempSync(join(tmpdir(), 'mr-chain-e2e-'));
process.env.MR_CHAIN_DIR = process.env.MR_CHAIN_DIR || join(HERE, '..', 'server', 'data');

const { start } = await import('../server/server.mjs');
const { rpcUrl } = await import('../server/chain.mjs');
const { verifyReveal } = await import('./verify-round.mjs');

const PORT = 8194;
let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };

const server = await start(PORT);
const events = [], waiters = [];
const ctrl = new AbortController();
(async () => {
  const res = await fetch(`http://localhost:${PORT}/api/events`, { signal: ctrl.signal });
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
const wait = (pred, ms = 120000) => {
  const hit = events.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((ok, no) => { waiters.push({ pred, ok }); setTimeout(() => no(new Error('timeout')), ms); });
};

console.log('\n  round on devnet\n');
const first = await wait(e => e.type === 'chain');
const id = first.data.id;
check(first.data.cluster === 'devnet' && !!first.data.token, `round ${id} is played in ${first.data.token} on devnet`);
const commit = await wait(e => e.type === 'chain' && e.data.id === id && e.data.commit.status !== 'pending');
check(commit.data.commit.status === 'confirmed' && !!commit.data.commit.sig, `the commit memo confirmed (${(commit.data.commit.sig || '').slice(0, 12)}…)`);

const reveal = await wait(e => e.type === 'chain' && e.data.id === id && ['confirmed', 'failed'].includes(e.data.reveal.status), 300000);
check(reveal.data.reveal.status === 'confirmed', `the reveal memo confirmed (${(reveal.data.reveal.sig || '').slice(0, 12)}…)`);

const connection = new Connection(await rpcUrl('devnet', process.env.MR_CHAIN_DIR), 'confirmed');
const v = await verifyReveal(connection, reveal.data.reveal.sig);
for (const c of v.checks) check(c.ok, `verify-round: ${c.what}`);

ctrl.abort(); server.close();
console.log(`\n  ${failures ? failures + ' FAILED' : 'all passed'}\n`);
process.exit(failures ? 1 : 0);
