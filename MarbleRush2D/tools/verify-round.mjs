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
//
// The game changes; old rounds still verify. The commit memo carries a hash of
// the race code that raced. When that is not the code in this copy, the exact
// version is looked up in this repository's git history by that hash and the
// race is replayed with it, so every round verifies with the code it ran on.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { Connection } from '@solana/web3.js';
import { rpcUrl, MEMO_PROGRAM } from '../server/chain.mjs';
import { makeRng } from '../../js/rng.js';
import { MARBLE_DATA } from '../../js/racers.js';
import { buildTrack } from '../js/track2d.js';
import { Engine2D, SIM_DT } from '../js/engine2d.js';
import { buildPrint } from '../js/detcheck.js';
import { codeHash, CODE_FILES } from '../server/codeversion.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 << 20 });
const THIS_CODE = { makeRng, MARBLE_DATA, buildTrack, Engine2D, SIM_DT, buildPrint };

/** The commit in this clone's history whose race files hash to `want` (what a commit memo carries), or null. */
export function findRaceCommit(want) {
  let revs;
  try { revs = git('rev-list', '--all', '--', ...CODE_FILES).toString().split('\n').filter(Boolean); } catch { return null; }
  for (const rev of revs) {
    const h = createHash('sha256');
    try { for (const f of CODE_FILES) { h.update(f + '\0'); h.update(git('show', `${rev}:${f}`)); h.update('\0'); } } catch { continue; }
    if (h.digest('hex').slice(0, 16) === want) return rev;
  }
  return null;
}

/** The race code exactly as it was at `rev`, unpacked to a temporary folder and loaded next to (not over) this copy's. */
async function raceCodeAt(rev) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'marblerush-race-'));
  execFileSync('tar', ['-x', '-C', dir], { input: git('archive', '--format=tar', rev, 'js', 'MarbleRush2D/js') });
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  const load = (f) => import(pathToFileURL(path.join(dir, f)).href);
  const [{ makeRng }, { MARBLE_DATA }, { buildTrack }, { Engine2D, SIM_DT }, { buildPrint }] = await Promise.all(
    ['js/rng.js', 'js/racers.js', 'MarbleRush2D/js/track2d.js', 'MarbleRush2D/js/engine2d.js', 'MarbleRush2D/js/detcheck.js'].map(load));
  return { code: { makeRng, MARBLE_DATA, buildTrack, Engine2D, SIM_DT, buildPrint }, hash: await codeHash(dir), done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The memo a transaction carries, who signed it, and when it landed. */
async function readMemo(connection, signature) {
  const tx = await connection.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if (!tx) throw new Error(`transaction not found: ${signature}`);
  const ix = tx.transaction.message.instructions.find(i => i.programId.equals(MEMO_PROGRAM));
  if (!ix) throw new Error('no memo in that transaction');
  return { text: ix.parsed, signer: tx.transaction.message.accountKeys.find(k => k.signer).pubkey.toBase58(), slot: tx.slot, time: tx.blockTime };
}

/** Race it again from the two seeds, the way every browser does (with this copy's race code unless given another). */
export function replayRace(courseSeed, raceSeed, blocks, code = THIS_CODE) {
  const { makeRng, MARBLE_DATA, buildTrack, Engine2D, SIM_DT } = code;
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
  const check = (ok, what, warn = false) => checks.push({ ok, what, warn });
  const rev = await readMemo(connection, revealSig);
  const [tag, kind, id, token, raceSeed, order, pool, commitSig] = rev.text.split('|');
  if (tag !== 'mr1' || kind !== 'reveal') throw new Error('that is not a MarbleRush reveal memo');
  const com = await readMemo(connection, commitSig);
  const [ctag, ckind, cid, ctoken, courseSeed, commitment, print, blocks, memoCode, memoRev] = com.text.split('|');

  check(ctag === 'mr1' && ckind === 'commit', 'the referenced transaction is a MarbleRush commit');
  check(sha256(raceSeed) === commitment, `the revealed seed hashes to the committed hash (${commitment.slice(0, 16)}…)`);
  check(com.slot < rev.slot || (com.slot === rev.slot && com.time <= rev.time), `the commit landed first: slot ${com.slot} before slot ${rev.slot}`);
  check(cid === id && ctoken === token, `both memos are round ${id}, token ${token}`);
  check(com.signer === rev.signer, `both signed by ${rev.signer.slice(0, 4)}…${rev.signer.slice(-4)}`);
  // Replay with the code that raced: this copy's when the hashes agree, otherwise that version from git history.
  const localCode = await codeHash(ROOT);
  let code = THIS_CODE, used = null;
  if (memoCode && memoCode !== localCode) {
    const rev = findRaceCommit(memoCode);
    if (rev) { used = await raceCodeAt(rev); used.rev = rev; code = used.code; }
  }
  try {
    const mine = replayRace(courseSeed, raceSeed, +blocks || 0, code);
    const replayOk = mine.join(',') === order;
    const sameCode = !memoCode || memoCode === localCode || (used && used.hash === memoCode);
    check(replayOk, replayOk ? `replaying the race gives the published order (${mine.map(i => MARBLE_DATA[i].name).join(' > ')})`
      : `replaying the race does NOT give the published order${sameCode ? '' : ': the version that raced was not found in this copy\'s git history (clone the full repository and run again)'}`);
    check(print === code.buildPrint(), `${used ? 'the engine used here' : 'this machine\'s engine'} matches the one that raced (build ${print})`);
    if (memoCode) check(sameCode, used && sameCode ? `replayed with the exact race code that raced (${memoCode}, commit ${used.rev.slice(0, 8)} in this repository's history)`
      : sameCode ? `the race code is identical to the version that raced (${memoCode}, ${memoRev})`
      : `the race code differs from the version that raced (memo ${memoCode}, here ${localCode}), and that version is not in this copy's git history${replayOk ? ': the replay still matched' : ''}`, replayOk);
  } finally { if (used) used.done(); }
  return { id, token, pool: +pool, order: order.split(',').map(Number), commitSig, revealSig, checks, ok: checks.every(c => c.ok || c.warn) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const sig = process.argv[2];
  if (!sig) { console.log('usage: node MarbleRush2D/tools/verify-round.mjs <reveal transaction signature>'); process.exit(2); }
  const dataDir = process.env.MR_CHAIN_DIR || process.env.MR_DATA || path.join(HERE, '..', 'server', 'data');
  const connection = new Connection(await rpcUrl('devnet', dataDir), 'confirmed');
  const r = await verifyReveal(connection, sig);
  console.log(`\n  round ${r.id} (${r.token}), pool ${r.pool}\n`);
  for (const c of r.checks) console.log(`  ${c.ok ? 'PASS' : c.warn ? 'WARN' : 'FAIL'}  ${c.what}`);
  console.log(`\n  ${r.ok ? 'verified' : 'NOT VERIFIED'}\n`);
  process.exit(r.ok ? 0 : 1);
}
