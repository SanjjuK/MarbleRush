# The blockchain layer

**In one sentence:** Solana is MarbleRush's public notary and its bank. It records, in public and in order, what the race was before anyone bet, and it moves the tokens.

Everything here runs on Solana **devnet** with a worthless test token (RUSH). Code: `MarbleRush2D/server/chain.mjs` (transactions), `MarbleRush2D/server/server.mjs` (rounds), `MarbleRush2D/tools/verify-round.mjs` (the verifier).

## What goes on Solana

| What | Solana mechanism | When | What it does |
|---|---|---|---|
| **Commit** | Memo transaction | Before betting opens | Records the SHA-256 hash of the race's secret seed, the public course seed and a fingerprint of the game code. A sealed envelope with a timestamp. |
| **Bet** | SPL token transfer plus a memo | When a player bets | Moves the player's stake into the vault. The player's wallet signs it. |
| **Reveal** | Memo transaction | After the race | Records the seed, the finishing order, the pool size and the commit's transaction signature. |
| **Payout** | SPL token transfer | After the result | Pays the winners: 75% of the pool (after a 5% rake) to backers of first place, 25% to second. |
| **Refund and void** | SPL token transfer, and a Memo | A cancelled round, or a bet that lands after betting closed | Gives the stake back. The void memo reveals the seed, so a cancelled round cannot be quietly re-rolled. |

Memo formats (all start with `mr1`):

```
commit  mr1|commit|<round>|<token>|<courseSeed>|<sha256(raceSeed)>|<print>|<blocks>|<codeHash>|<rev>
bet     mr1|bet|<round>|<marble>|<amount>
reveal  mr1|reveal|<round>|<token>|<raceSeed>|<finishOrder>|<pool>|<commitSignature>
void    mr1|void|<round>|<token>|<reason>|<raceSeed>|<commitSignature>
payout  mr1|payout|<round>|<recipients in this transaction>      (refunds: mr1|refund|<round>|<recipients>)
```

## Who does what

- **The player's wallet** (Phantom, Solflare or Backpack) proves who you are with a free signed message (no transaction, no cost) and signs each bet. It never needs SOL.
- **The server** picks the seed, builds every transaction and **pays the network fee**, so playing needs no SOL. It also holds the vault key. The server only accepts back the exact bytes it built, signed by the player.
- **Solana** stores the memos and the token transfers permanently, in an order nobody can edit (the commit's slot comes before the reveal's slot).

## What Solana proves

The commit is on-chain before the first bet, and the race is a deterministic simulation: the same seed always gives the same race. So after the reveal anyone can:

1. check that the revealed seed hashes to the commit,
2. check that the commit came before the reveal,
3. replay the whole race and see the same finishing order:

```bash
node MarbleRush2D/tools/verify-round.mjs <reveal transaction signature>
```

That proves **the result was fixed before the bets and was not changed afterwards.** Every round on the [stats page](https://34-29-110-88.sslip.io/MarbleRush2D/stats.html) links to its commit, reveal and payout transactions.

## What stays off-chain

The race itself (it runs in your browser and on the server), the live odds and pool display, sound, and the table logic. Putting a physics simulation on-chain would be slow and expensive, and it is not needed: the on-chain hash is enough to make the race checkable by anyone.

## Cost

About 0.00001 SOL for the commit and reveal of a round. A new player's first token account costs about 0.002 SOL of rent, paid by the server. Everything is devnet, so none of it is real money.

## Safety of the money flow

- Payouts and refunds are written to disk **with their signature before they are sent**, and checked against the cluster after a crash, so they are neither lost nor paid twice.
- A bet that confirms after betting closed is refunded.
- A server restart mid-round refunds that round's bets.
- A table without house stakes can only pay out what players put in, minus the rake.

## What it does not do yet

- **The vault is custodial.** One server key holds the stakes and decides payouts. The fix is an on-chain escrow program that holds stakes, takes the revealed seed and pays winners by its own rules.
- **The operator can see the result before bets close.** The hash proves the result was not changed; it does not hide it. The fix is to mix in randomness nobody knows early, for example a Solana blockhash from a slot after betting closes, or a verifiable random function. The verifier already replays from seeds, so only the seed derivation would change.
- **Devnet only, not audited.** See [SECURITY.md](SECURITY.md) and the [FAQ](FAQ.md).

## Token configuration

Tokens are configuration (`MarbleRush2D/server/tokens.json`), not code: RUSH is a test token the project mints for free on devnet; any other mint (for example devnet USDC) can be added, and a schedule file can switch a table to a partner's token for a branded race.
