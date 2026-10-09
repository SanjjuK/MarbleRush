# FAQ for judges

Straight answers, including the uncomfortable ones.

## Is this gambling?

It has the mechanics of one: players stake tokens on an uncertain outcome and a pool is paid out. **In this submission nothing of value is at stake.** It runs on Solana **devnet** with RUSH, a test token the project mints for free; there is no way to buy it, sell it or cash it out. Real-money wagering is regulated in most places and would need a licence, geo-blocking and KYC, or a different structure such as free-to-play seasons with sponsor-funded prizes. The plan is to settle the legal route with counsel before any real money. Nothing here is legal advice.

## Why devnet?

Because it is a prototype and an unaudited one. Devnet gives real Solana transactions (you can see them on the Explorer, you can replay them) without risking anyone's money. Mainnet comes after an escrow program and an audit.

## How is the result fair if the operator can see it?

Precisely: what this proves, and what it does not.

- **It proves the result was not changed after the bets.** The hash of the race seed is on-chain before betting opens, and the revealed seed must match it. The race is a pure function of the seed, so the result is fixed at that moment. Anyone can replay it (`tools/verify-round.mjs`).
- **It does not hide the result from the operator.** The server picks the seed and runs the race before betting, so the operator could know the winner while bets are open and could bet on it from another wallet. We do not do this: the house key never bets and the only house stakes are the labelled "HOUSE" ones on the test-token Practice table. But on-chain you can only *check* the operator's behaviour, not prevent it.
- **The fix, which is on the roadmap:** mix in randomness the operator cannot know when committing, for example a Solana blockhash from a slot after betting closes, or a verifiable random function, so the winner is unknowable to everyone until betting is shut. The verifier already replays from seeds, so only the seed derivation changes.

## Why is the vault custodial? Could you run off with the money?

In this build, yes in principle: stakes go to a vault whose key sits on one server, and that server decides payouts. The mitigations today are that it is devnet with worthless tokens, payouts are crash-safe and recorded with their signatures, and every round's result can be verified. The real fix is an **on-chain escrow program** that holds stakes, accepts the revealed seed and pays winners by its own rules, so the server key cannot take the money. That is the first thing funding would pay for, together with an audit.

## Why a Memo transaction and not a program?

A memo is the cheapest way to put a hash and a seed on a public ledger with a trusted timestamp, and it let us ship a verifiable fairness protocol in the hackathon. A program would additionally enforce who gets paid; that is the escrow program above.

## What happens if the server crashes or restarts mid-round?

The round's bets are refunded when it comes back (they are saved as they land), the round numbering continues, and payouts are written to disk with their signature before being sent, then checked against the cluster after a crash, so they are neither lost nor paid twice. Deployments are blocked while someone has a bet in a running round.

## What if too few people join?

A table can require a minimum number of players. Short of it, the round is cancelled and every stake is refunded on-chain, with a `void` memo that reveals the seed so a cancelled round cannot be quietly re-rolled. The Practice table needs nobody: it starts when a wallet is connected and adds labelled house stakes so a lone visitor sees a live board. The Live table exists in the code and the tests but is switched off for the submission ("coming soon").

## Can the house lose money?

On a table without house stakes, never: payouts are at most stakes minus the 5% rake. Tested in a 4-player round (110 staked, 104.50 paid, 5.50 kept) and with 20 real signed devnet bets. On Practice the house takes the other side of its own capped, labelled stakes with test tokens, so the stats page shows a negative "kept by house" there. That is expected and costs nothing real.

## Is the race really the same everywhere?

It is a fixed-timestep, seeded simulation with no JavaScript math functions whose last bit differs between engines. A bug where Chrome and Node disagreed by one bit was found and fixed during the hackathon. A round raced on a Google Cloud server in the US was replayed on a Mac and matched; the verifier also compares a hash of the race code, and tells you if you are running a different version.

## What is the token? Is there an airdrop or a coin?

No token sale, no airdrop, no coin. RUSH is a test token, minted by the project's own key for free on devnet. Other tokens (for example devnet USDC) are configuration, and a table can play a sponsor's token for a branded "show".

## Who built it? Is the voice in the video real?

One developer, alias **SanjjuK**, with AI coding assistance (Claude Code), disclosed in the submission. The video voice-over is generated with text-to-speech and says so in the description.

## How do I run it myself?

See the [README](README.md). `npm install`, `npm start`, open the page; it also works with no server at all in an offline practice mode. `DEPLOY.md` covers the Google Cloud setup, and `npm run test:e2e` runs the main suite with no chain.
