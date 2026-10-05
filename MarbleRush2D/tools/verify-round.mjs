// verify-round.mjs: check a finished round against the chain, trusting nobody.
//
//   node MarbleRush2D/tools/verify-round.mjs <reveal transaction signature>
//
// A round leaves two memos on Solana: a COMMIT before betting (the SHA-256 of
// the secret race seed, the public course seed, the code fingerprint) and a
// REVEAL after the race (the seed, the finishing order, the pool, and the
// commit's signature). This reads both from the cluster and checks:
//
//   1. the revealed seed hashes to the committed hash
//   2. the commit landed on chain before the reveal (so before the race)
//   3. both memos are about the same round and token, signed by the same key
//   4. REPLAYING the race from the two seeds, with this machine's copy of the
//      engine, gives the finishing order that was published
//
// If all four hold, the operator could not have picked the result after seeing
// the bets.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Connection } from '@solana/web3.js';
import { rpcUrl, MEMO_PROGRAM } from '../server/chain.mjs';
import { makeRng } from '../../js/rng.js';
import { MARBLE_DATA } from '../../js/racers.js';
import { buildTrack } from '../js/track2d.js';
import { Engine2D, SIM_DT } from '../js/engine2d.js';
import { buildPrint } from '../js/detcheck.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** The memo a transaction carries, who signed it, and when it landed. */
async function readMemo(connection, signature) {
  const tx = await connection.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if (!tx) throw new Error(`transaction not found: ${signature}`);
  const ix = tx.transaction.message.instructions.find(i => i.programId.equals(MEMO_PROGRAM));
  if (!ix) throw new Error('no memo in that transaction');
  return { text: ix.parsed, signer: tx.transaction.message.accountKeys.find(k => k.signer).pubkey.toBase58(), slot: tx.slot, time: tx.blockTime };
}

/** Race it again from the two seeds, the way every browser does. */
export function replayRace(courseSeed, raceSeed, blocks) {
  const track = buildTrack(makeRng(courseSeed), blocks ? { count: blocks } : {});
  const eng = new Engine2D({ track, rng: makeRng(raceSeed), racers: MARBLE_DATA });
  eng.settle(); eng.openGate();
  const order = [];
  let guard = Math.ceil(480 / SIM_DT);
  while (guard-- > 0 && !eng.allFinished) {
    eng.step(true);
    for (const m of eng.marbles) if (m.finished && !order.includes(m.index)) order.push(m.index);
  }
  const out = eng.marbles.filter(m => m.out).sort((a, b) => b.outTime - a.outTime).map(m => m.index);
  return order.concat(out);
}

export async function verifyReveal(connection, revealSig) {
  const checks = [];
  const check = (ok, what) => checks.push({ ok, what });
  const rev = await readMemo(connection, revealSig);
  const [tag, kind, id, token, raceSeed, order, pool, commitSig] = rev.text.split('|');
  if (tag !== 'mr1' || kind !== 'reveal') throw new Error('that is not a MarbleRush reveal memo');
  const com = await readMemo(connection, commitSig);
  const [ctag, ckind, cid, ctoken, courseSeed, commitment, print, blocks] = com.text.split('|');

  check(ctag === 'mr1' && ckind === 'commit', 'the referenced transaction is a MarbleRush commit');
  check(sha256(raceSeed) === commitment, `the revealed seed hashes to the committed hash (${commitment.slice(0, 16)}…)`);
  check(com.slot < rev.slot || (com.slot === rev.slot && com.time <= rev.time), `the commit landed first: slot ${com.slot} before slot ${rev.slot}`);
  check(cid === id && ctoken === token, `both memos are round ${id}, token ${token}`);
  check(com.signer === rev.signer, `both signed by ${rev.signer.slice(0, 4)}…${rev.signer.slice(-4)}`);
  const mine = replayRace(courseSeed, raceSeed, +blocks || 0);
  check(mine.join(',') === order, `replaying the race gives the published order (${mine.map(i => MARBLE_DATA[i].name).join(' > ')})`);
  check(print === buildPrint(), `this machine's engine matches the one that raced (build ${print})`);
  return { id, token, pool: +pool, order: order.split(',').map(Number), commitSig, revealSig, checks, ok: checks.every(c => c.ok) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const sig = process.argv[2];
  if (!sig) { console.log('usage: node MarbleRush2D/tools/verify-round.mjs <reveal transaction signature>'); process.exit(2); }
  const dataDir = process.env.MR_CHAIN_DIR || process.env.MR_DATA || path.join(HERE, '..', 'server', 'data');
  const connection = new Connection(await rpcUrl('devnet', dataDir), 'confirmed');
  const r = await verifyReveal(connection, sig);
  console.log(`\n  round ${r.id} (${r.token}), pool ${r.pool}\n`);
  for (const c of r.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.what}`);
  console.log(`\n  ${r.ok ? 'verified' : 'NOT VERIFIED'}\n`);
  process.exit(r.ok ? 0 : 1);
}
