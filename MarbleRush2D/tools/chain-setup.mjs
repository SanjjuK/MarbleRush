// chain-setup.mjs: one-time devnet setup. Safe to run again: it only fills in
// what is missing.
//
//   node MarbleRush2D/tools/chain-setup.mjs
//
//   1. makes the server's authority key (data/authority.json) if there is none
//   2. asks the devnet faucet for SOL if the authority is short (fees + rent)
//   3. creates the mint of every "create" token in server/tokens.json
//   4. opens the vault (the authority's token account) for every token and
//      fills a "create" token's vault with its houseFloat
//
// It prints addresses, never the secret key.
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Connection, PublicKey, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  createMint, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction,
} from '@solana/spl-token';
import { loadAuthority, makeAuthority, readJson, toBase, rpcUrl } from '../server/chain.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.MR_DATA || path.join(HERE, '..', 'server', 'data');
const config = await readJson(path.join(HERE, '..', 'server', 'tokens.json'));

let authority = await loadAuthority(DATA);
if (authority) console.log('authority key found:', authority.publicKey.toBase58());
else { authority = await makeAuthority(DATA); console.log('authority key made:', authority.publicKey.toBase58(), '(saved to data/authority.json, mode 600)'); }

const connection = new Connection(await rpcUrl(config.cluster, DATA), 'confirmed');
const sol = async () => (await connection.getBalance(authority.publicKey)) / LAMPORTS_PER_SOL;

if (await sol() < 0.5) {
  for (const n of [1, 1]) {
    try {
      const sig = await connection.requestAirdrop(authority.publicKey, n * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
      console.log(`airdrop of ${n} SOL ok`);
    } catch (e) { console.log('airdrop failed:', String(e.message).slice(0, 120)); break; }
  }
}
console.log('authority SOL:', (await sol()).toFixed(3));
if (await sol() < 0.015) {
  console.log(`\nNot enough SOL to continue. Send devnet SOL to ${authority.publicKey.toBase58()} (faucet.solana.com), then run this again.`);
  process.exit(1);
}

const stateFile = path.join(DATA, 'chain.json');
const state = (await readJson(stateFile, { mints: {} })) || { mints: {} };
state.mints ||= {};

for (const [symbol, t] of Object.entries(config.tokens)) {
  let mint;
  if (t.mint === 'create') {
    if (!state.mints[symbol]) {
      mint = await createMint(connection, authority, authority.publicKey, null, t.decimals);
      state.mints[symbol] = mint.toBase58();
      console.log(`${symbol}: mint created ${mint.toBase58()}`);
    } else console.log(`${symbol}: mint exists ${state.mints[symbol]}`);
    mint = new PublicKey(state.mints[symbol]);
  } else {
    mint = new PublicKey(t.mint);
    console.log(`${symbol}: external mint ${mint.toBase58()}`);
  }
  const vault = getAssociatedTokenAddressSync(mint, authority.publicKey);
  const tx = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, vault, authority.publicKey, mint));
  if (t.mint === 'create' && t.houseFloat) {
    const have = await connection.getTokenAccountBalance(vault).then(b => BigInt(b.value.amount)).catch(() => 0n);
    const want = toBase(t.houseFloat, t.decimals);
    if (have < want) tx.add(createMintToInstruction(mint, vault, authority.publicKey, want - have));
  }
  await sendAndConfirmTransaction(connection, tx, [authority], { commitment: 'confirmed' });
  const bal = await connection.getTokenAccountBalance(vault).then(b => b.value.uiAmountString).catch(() => '0');
  console.log(`${symbol}: vault ${vault.toBase58()} holds ${bal}`);
}

await mkdir(DATA, { recursive: true });
await writeFile(stateFile, JSON.stringify(state, null, 2));
console.log('\nsetup done: data/chain.json written');
