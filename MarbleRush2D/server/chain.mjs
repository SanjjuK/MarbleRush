// chain.mjs: the Solana side of the server.
//
// Money is a SPL token, and WHICH token is configuration, not code: every
// token a round can be played in is an entry in tokens.json (symbol, mint,
// decimals, stake sizes, how a player gets some). Adding a partner's token
// means adding an entry; nothing else in the game knows a token's name.
//
//   mint: "create"      a test token this server owns: setup creates the mint
//                       (tools/chain-setup.mjs) and the faucet can mint it
//   mint: "<address>"   a token somebody else owns (Circle's devnet USDC, a
//                       partner's test token): we can hold it and pay it out,
//                       but not mint it, so players get it from its own faucet
//
// The server's AUTHORITY key owns the vault (one token account per mint), pays
// every fee so players never need SOL, and is the mint authority of "create"
// tokens. It is a hot key on a devnet server: it lives in data/authority.json
// (mode 600, git-ignored) or in MR_AUTHORITY_KEY, never in the repo.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { b58encode } from './auth.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction,
  createTransferCheckedInstruction, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RPC_URLS = { devnet: 'https://api.devnet.solana.com', 'mainnet-beta': 'https://api.mainnet-beta.solana.com' };

export const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

export const readJson = async (file, fallback = null) => {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
};

/** The RPC to talk to: MR_RPC, else the first line of data/rpc-url.txt (git-ignored, so a provider key never reaches the repo), else the public node. */
export async function rpcUrl(cluster, dataDir) {
  if (process.env.MR_RPC) return process.env.MR_RPC;
  try { const t = (await readFile(path.join(dataDir, 'rpc-url.txt'), 'utf8')).split('\n')[0].trim(); if (t) return t; } catch { /* none */ }
  return RPC_URLS[cluster];
}

/** Whole tokens (a float) to base units (a bigint), rounding down: dust stays in the vault. */
export const toBase = (amount, decimals) => BigInt(Math.floor(amount * 10 ** decimals + 1e-9));
export const fromBase = (units, decimals) => Number(units) / 10 ** decimals;

export async function loadAuthority(dataDir) {
  const env = process.env.MR_AUTHORITY_KEY;
  const raw = env ? JSON.parse(env) : await readJson(path.join(dataDir, 'authority.json'));
  return raw ? Keypair.fromSecretKey(Uint8Array.from(raw)) : null;
}

export async function makeAuthority(dataDir) {
  const kp = Keypair.generate();
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, 'authority.json'), JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

/**
 * Open the chain, or return null when this server has not been set up (no
 * authority key, no chain.json). The game still runs without it, on server
 * demo money, which is what the end-to-end test and a fresh checkout get.
 */
export async function openChain({ dataDir, configFile = path.join(HERE, 'tokens.json') }) {
  const config = await readJson(configFile);
  const state = await readJson(path.join(dataDir, 'chain.json'));
  const authority = await loadAuthority(dataDir);
  if (!config || !state || !authority) return null;

  const connection = new Connection(await rpcUrl(config.cluster, dataDir), 'confirmed');
  const tokens = new Map();
  for (const [symbol, t] of Object.entries(config.tokens)) {
    const mintAddr = t.mint === 'create' ? state.mints?.[symbol] : t.mint;
    if (!mintAddr) continue;                                  // a "create" token that setup has not made yet
    const mint = new PublicKey(mintAddr);
    tokens.set(symbol, {
      symbol, name: t.name, decimals: t.decimals, mint, owned: t.mint === 'create',
      minBet: t.minBet, stakes: t.stakes, faucet: t.faucet || { mode: 'none' },
      vault: getAssociatedTokenAddressSync(mint, authority.publicKey),
    });
  }

  const faucetFile = path.join(dataDir, 'faucet.json');
  const claims = (await readJson(faucetFile, {})) || {};

  // Who pays the network fee on a bet. 'server' (default): players never need SOL. 'player': the
  // wallet pays, in case a wallet refuses to sign a transaction another account pays for.
  const feeMode = process.env.MR_FEE_PAYER === 'player' ? 'player' : 'server';
  const prepared = new Map();                               // prepId -> the bet the server built and will accept back
  const memoIx = (text, signer) => new TransactionInstruction({
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }], programId: MEMO_PROGRAM, data: Buffer.from(text, 'utf8'),
  });

  const chain = {
    cluster: config.cluster, feeMode, connection, authority, tokens,
    defaultToken: tokens.has(config.default) ? config.default : [...tokens.keys()][0],

    token(symbol) {
      const t = tokens.get(symbol);
      if (!t) throw new Error(`unknown token ${symbol}`);
      return t;
    },

    /** What a browser may know about the setup. */
    publicInfo() {
      return {
        cluster: config.cluster, vault: authority.publicKey.toBase58(), default: this.defaultToken,
        tokens: [...tokens.values()].map(t => ({
          symbol: t.symbol, name: t.name, decimals: t.decimals, mint: t.mint.toBase58(),
          minBet: t.minBet, stakes: t.stakes, faucet: t.faucet,
        })),
      };
    },

    /** A wallet's balance of one token, in whole tokens. A wallet with no token account holds 0. */
    async balanceOf(address, symbol) {
      const t = this.token(symbol);
      const ata = getAssociatedTokenAddressSync(t.mint, new PublicKey(address));
      try {
        const b = await connection.getTokenAccountBalance(ata, 'confirmed');
        return fromBase(BigInt(b.value.amount), t.decimals);
      } catch (e) {
        if (/could not find account|Invalid param: could not find/i.test(String(e.message))) return 0;
        throw e;
      }
    },

    /** Mint a faucet drop of a server-owned token. One per wallet per cooldown. */
    async claimFaucet(address, symbol) {
      const t = this.token(symbol);
      if (t.faucet.mode !== 'mint' || !t.owned) return { error: `${symbol} has no server faucet`, status: 400 };
      const key = `${symbol}:${address}`;
      const wait = (claims[key] || 0) + t.faucet.cooldownHours * 3600_000 - Date.now();
      if (wait > 0) return { error: 'faucet cooldown', status: 429, retryInMs: wait };
      claims[key] = Date.now();                              // reserve first, so a double click cannot double mint
      try {
        const owner = new PublicKey(address);
        const ata = getAssociatedTokenAddressSync(t.mint, owner);
        const tx = new Transaction().add(
          createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, ata, owner, t.mint),
          createMintToInstruction(t.mint, ata, authority.publicKey, toBase(t.faucet.amount, t.decimals)),
        );
        const signature = await sendAndConfirmTransaction(connection, tx, [authority], { commitment: 'confirmed' });
        await writeFile(faucetFile, JSON.stringify(claims));
        return { signature, amount: t.faucet.amount, symbol };
      } catch (e) {
        delete claims[key];                                  // the drop did not happen: give the claim back
        throw e;
      }
    },

    /**
     * Write a line of text to the chain (the Memo program), signed by the
     * authority. This is how a round is sealed before betting and revealed
     * after: a memo is public, permanent and time-stamped by the cluster.
     */
    async postMemo(text) {
      const data = Buffer.from(text, 'utf8');
      if (data.length > 500) throw new Error('memo too long');
      const tx = new Transaction().add(new TransactionInstruction({
        keys: [{ pubkey: authority.publicKey, isSigner: true, isWritable: false }], programId: MEMO_PROGRAM, data,
      }));
      const signature = await sendAndConfirmTransaction(connection, tx, [authority], { commitment: 'confirmed' });
      return { signature };
    },

    /**
     * Build a bet for a wallet to sign: ONE transaction that moves the stake from the player's
     * token account into the vault and carries a memo naming the round and marble. The server
     * builds every byte, so on the way back it only has to check that the wallet signed those
     * same bytes; it never parses a transaction a stranger wrote.
     */
    async prepareBet({ owner, symbol, amount, memo, roundId, marble }) {
      const t = this.token(symbol);
      const ownerPk = new PublicKey(owner);
      const src = getAssociatedTokenAddressSync(t.mint, ownerPk);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: feeMode === 'server' ? authority.publicKey : ownerPk, blockhash, lastValidBlockHeight });
      tx.add(createTransferCheckedInstruction(src, t.mint, t.vault, ownerPk, toBase(amount, t.decimals), t.decimals));
      tx.add(memoIx(memo, ownerPk));
      if (feeMode === 'server') tx.partialSign(authority);
      const prepId = randomBytes(12).toString('hex');
      prepared.set(prepId, { owner, symbol, amount, roundId, marble, message: tx.serializeMessage().toString('base64'), lastValidBlockHeight, used: false });
      if (prepared.size > 500) for (const k of prepared.keys()) { prepared.delete(k); if (prepared.size <= 400) break; }
      return { prepId, tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), blockhash, lastValidBlockHeight };
    },

    /** What a prepared bet was for, or null if unknown, used, or somebody else's. */
    preparedBet(prepId, owner) {
      const p = prepared.get(prepId);
      return p && p.owner === owner && !p.used ? p : null;
    },

    /** Take the wallet's signed transaction back, check it is the one we built, send it, wait for it to land. */
    async submitBet(prepId, owner, signedB64) {
      const p = this.preparedBet(prepId, owner);
      if (!p) return { error: 'that bet expired, try again', status: 410 };
      p.used = true;                                         // one try: a second submit of the same bet is refused
      const tx = Transaction.from(Buffer.from(signedB64, 'base64'));
      if (tx.serializeMessage().toString('base64') !== p.message) return { error: 'the signed transaction is not the one we built', status: 400 };
      if (feeMode === 'server') tx.partialSign(authority);
      if (!tx.verifySignatures()) return { error: 'signature missing or wrong', status: 400 };
      const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
      const res = await connection.confirmTransaction({ signature, blockhash: tx.recentBlockhash, lastValidBlockHeight: p.lastValidBlockHeight }, 'confirmed');
      if (res.value.err) return { error: 'the transaction failed on chain: ' + JSON.stringify(res.value.err).slice(0, 80), status: 502 };
      return { signature, roundId: p.roundId, symbol: p.symbol, amount: p.amount, marble: p.marble };
    },

    /**
     * Pay out of the vault: one transaction, up to a few winners, plus a memo. The signed bytes
     * are returned BEFORE sending, so the caller can write down the signature and, after a crash,
     * ask the cluster whether it landed instead of paying twice.
     */
    async buildPayout(symbol, items, memo) {
      const t = this.token(symbol);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: authority.publicKey, blockhash, lastValidBlockHeight });
      for (const { owner, amount } of items) {
        const ownerPk = new PublicKey(owner);
        const dest = getAssociatedTokenAddressSync(t.mint, ownerPk);
        tx.add(createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, dest, ownerPk, t.mint));
        tx.add(createTransferCheckedInstruction(t.vault, t.mint, dest, authority.publicKey, toBase(amount, t.decimals), t.decimals));
      }
      tx.add(memoIx(memo, authority.publicKey));
      tx.sign(authority);
      return { raw: tx.serialize().toString('base64'), signature: b58encode(tx.signature), lastValidBlockHeight, blockhash };
    },

    /** Send an already-signed transaction and wait for it. Safe to call again for the same bytes. */
    async sendRaw(raw, signature, blockhash, lastValidBlockHeight) {
      await connection.sendRawTransaction(Buffer.from(raw, 'base64'), { maxRetries: 3 });
      const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
      if (res.value.err) throw new Error('payout failed on chain: ' + JSON.stringify(res.value.err).slice(0, 80));
      return signature;
    },

    /** 'confirmed' | 'failed' | 'unknown' (not seen) for a signature, and whether its blockhash has expired. */
    async txState(signature, lastValidBlockHeight) {
      const st = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (st) return st.err ? 'failed' : (st.confirmationStatus === 'processed' ? 'unknown' : 'confirmed');
      return (await connection.getBlockHeight('confirmed')) > lastValidBlockHeight ? 'expired' : 'unknown';
    },

    async vaultBalance(symbol) { return this.balanceOf(authority.publicKey.toBase58(), symbol); },

    async authoritySol() { return (await connection.getBalance(authority.publicKey)) / LAMPORTS_PER_SOL; },
  };
  return chain;
}

export { TOKEN_PROGRAM_ID };
