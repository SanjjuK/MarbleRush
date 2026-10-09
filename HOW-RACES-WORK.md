# How races, tables and the house's money work

MarbleRush is a live parimutuel game: everyone at a table watches the same race and shares one pool. This note answers four questions a reviewer should ask: **when does a race happen, who is in it, can the house lose money, and does it hold up under load.** Every number below was measured by a test in this repo, and the tests are named so you can re-run them.

## A round, start to finish

1. **Seal.** The server picks a secret race seed and writes `SHA-256(seed)` to Solana (a memo transaction). Betting is shut until that confirms.
2. **Bet.** A player signs one transaction that moves their stake into the vault. The server builds it and pays the network fee, so players never need SOL. One bet per wallet per round.
3. **Race.** The race is deterministic: every browser replays the same race from the public course seed and the revealed race seed. It lasts about 3.5 minutes; a whole round is about 4 to 5 minutes.
4. **Reveal and pay.** The seed, the finishing order and the pool go on Solana, then winners are paid from the vault. First place shares 75% of the pool after rake, second shares 25%.
5. **Verify.** `node MarbleRush2D/tools/verify-round.mjs <reveal signature>` trusts only the chain: it checks the seed against the hash, that the commit came first, and replays the race.

## When a race happens: tables

A **table** is one race loop with its own pool (`MarbleRush2D/server/tables.json`).

| Table | Needs | House stakes | Why |
|---|---|---|---|
| **Practice** (RUSH test token) | nobody, but it starts only when a signed-in wallet is on the table | yes, labelled **HOUSE**, capped at 600 RUSH a round | a lone visitor, a judge, sees a live board |
| **Live** (default or show token) | 3 wallets that have bet | none | every unit in the pool is a player's |

- **Minimum players.** If a table is short when the 60 s lobby ends, it waits one more lobby ("Waiting for 1 more player"). Still short: the round is **cancelled and every stake is returned** (a refund transaction, plus a `void` memo that reveals the seed so a round that never raced cannot be quietly re-rolled).
- **Maximum players.** 20 seats a round. When a round is full the bettor is told where to go and the next table opens (`live-2`, `live-3`, ... up to 8). Overflow tables have no house stakes and close when their room is empty. Newcomers are placed at the busiest table with a seat, so people are not scattered. Spectators are not limited.
- **No empty rooms.** A table with nobody watching sleeps: no race is computed and no round is sealed on chain. The next visitor wakes it, and the round then waits (no clock, no house stakes) until a signed-in wallet is on a Practice table, or until the first bet on a Live table (`startOn` in `tables.json`). When everyone leaves, the table stops again.
- **A round never keeps a stake it did not race.** A bet that lands after betting closed, a round cancelled for too few players, and a server that dies mid-round are all refunded; payouts and refunds are crash-safe jobs written to disk with their signature before they are sent.

## Can the house lose money?

**On a table with no house stakes, no.** The pool is the players' stakes. Winners are paid the pool minus the 5% rake, so payouts can never exceed what came in. If nobody backed first or second place, everyone is refunded.

- Tested: `npm run test:e2e` pays four players 104.50 out of a 110 pool; `npm run test:chain-load` has 20 wallets sign real devnet bets at once and checks that together they end **exactly the rake poorer** (-10.0000 of a 200 pool, to four decimals).
- The stats page shows it live: "Kept by house" is stakes minus payouts, which on Live is exactly the rake.

**On Practice, the house is the counterparty to its own labelled stakes.** Those stakes only enlarge the pool; when a real player wins, the vault pays out money the house "put in". The expected result is still +5% of the players' stakes, but one round can lose up to the cap (600 RUSH plus a few minimum-size fallback bets). It runs on the worthless test token only, the stakes are labelled, and the cap is a config value. A player who studies which marbles are truly strongest could win against those stakes; we have not measured that edge, which is one more reason Practice is not for real money.

**What the house pays.**

| Cost | Size | Covered by |
|---|---|---|
| network fee per bet, payout transaction (4 winners each) and memo (2 a round) | about 5,000 lamports each | the 5% rake: a stake worth about 0.0001 SOL covers that bet's own fee |
| one-time token-account rent for a new player | about 0.002 SOL | recouped once that player's stakes reach 40 times the rent (0.002 / 5%) |
| the faucet (test tokens only) | rent plus a fee per new wallet | capped per address and per day; pauses before the wallet runs dry |

The house wallet pauses the faucet, new bets and round memos when its SOL is low, so payouts are the last thing to stop.

## Does it hold up?

| Question | Measured | How to re-run |
|---|---|---|
| 100 players at once, 5 tables of 20, full-length courses | every player seated, longest event-loop stall 29 ms, 76 MB | `npm run test:load` |
| 20 signed bets at the same instant on devnet | all landed in 4.4 s, 36 s before the lobby closed; pool paid out to the unit | `npm run test:chain-load` |
| a live round that falls short | both stakes back on chain, nothing paid as winnings | `npm run test:chain` |
| a server killed mid-round | the stake is refunded, round numbers continue | `npm run test:chain` |

Races are computed on worker threads: a real course costs about half a second of CPU, which used to freeze every table whenever a round opened. 20 seats is the validated figure. The RPC provider's websocket limit is the first thing to watch before raising it: two of the 20 simultaneous bets saw an HTTP 429 on the confirmation socket and still confirmed.

## What is not solved

- **Liquidity at launch.** Live needs three people at once. Today the answer is Practice (always on) plus the picker showing where people are. Scheduled "race nights" with a countdown on the home page are the plan; they are not built.
- **Sybils.** One person with three wallets can meet a Live minimum; the only cost to them is the rake, and nobody else is harmed.
- **Custody.** The vault is a hot server key. Mainnet needs an escrow program (Anchor) or a multisig so payouts follow program rules, not a key. See `SECURITY.md`.
- **Devnet only.** Test tokens, no audit, no real money.
