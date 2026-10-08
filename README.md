# MarbleRush

Live parimutuel marble racing on Solana. Everyone watches the same race. You back a marble, stakes go into one pool, and the pool is paid out by finishing position. Every round is **sealed on-chain before betting opens and revealed after the race**, so nobody, including the operator, can pick the result after seeing the bets.

> **Status: devnet prototype.** Test tokens only. Built for the Colosseum Crypto World's Fair hackathon. Not audited, not for real money.

## How a round works

1. **Seal.** The server picks a secret race seed and writes a memo to Solana with `SHA-256(seed)`, the public course seed and a fingerprint of the game code. Betting stays shut until that transaction confirms.
2. **Bet.** You connect a wallet (Phantom, Solflare or Backpack) and sign in with a free message signature. A bet is a single token transfer into the vault that carries a memo naming the round and marble. **The server pays the network fee, so players never need SOL.** The server builds the transaction and only accepts back exactly the bytes it built, signed.
3. **Race.** The engine is deterministic. Every browser replays the same race from the two seeds; the server decides the result and sends a position check every second.
4. **Reveal and pay.** The seed, the finishing order and the pool go on-chain, then winners are paid from the vault. A bet that lands after betting closed is refunded.
5. **Verify.** `node MarbleRush2D/tools/verify-round.mjs <reveal signature>` reads both memos from the chain, checks the seed against the hash, checks the commit came first, and replays the race to confirm the published order. It trusts nothing but the cluster.

## Tables

A **table** is one independent race loop with its own pool, set in `MarbleRush2D/server/tables.json`:

| Setting | Meaning |
|---|---|
| `minPlayers` | wallets that must have bet for the race to run. Short of it the lobby waits one more round of the clock, then the round is **cancelled and every stake is returned** (a refund transaction, plus a `void` memo that reveals the seed). `0` = the race always runs |
| `maxPlayers` | seats per round (default 20). When a round has no seat left the bettor is told which table to move to, and the next table of the family (`live-2`, `live-3`, ...) opens, up to `maxTables` (default 8). Overflow tables have no house stakes and close when their room is empty. Spectators are not limited |
| `bots` | `house`: labelled house stakes so a lone visitor sees a live board, capped by `botBudget`. `none`: every unit in the pool is a player's |
| `token` | fixed token for the table; leave it out to use the default token or the current show |

The shipped config has **Practice** (RUSH, house bots, the race always runs) and **Live** (3 players needed, no bots). Without house stakes a pool can only pay out what players put in, minus the 5% rake, so a Live table cannot lose money on a round. Tables **sleep** when nobody is watching: no round is sealed for an empty room, and the next visitor wakes it. A table that nobody bets at backs off (3 s, 6 s ... 30 s) instead of opening a round a minute for a lone spectator.

On the page, a **table chip** next to the round tag (the ring caption on phones, a row in the sheet) names your table and opens a picker with seats left and what each table needs. House stakes carry a **HOUSE** tag in the live feed. A short-of-players lobby says how many more are needed, a cancelled round says stakes were returned, and a bettor turned away from a full table is moved to the next one. Your table is remembered; `?table=live` opens a specific one.

`GET /api/tables` lists every table (phase, seats left, bettors, viewers). `GET /api/events?table=live` seats you at the busiest Live table that has room; add `&pin=1` to mean exactly that table. Bets name their table in the request body.

**What one server handles** (`npm run test:load`, `npm run test:chain-load`): 100 players on separate addresses spread over 5 Practice tables of 20, with full-length courses, and the event loop never stalled for more than 30 ms. The race of every round is computed on worker threads (`server/racesim.mjs`, `MR_NO_WORKER=1` turns that off): a real course costs about half a second of CPU. On devnet, 20 players signing and submitting a bet at the same instant all landed within 4.4 s, and the pool paid out to the last unit. 20 is the validated seat count; the RPC provider's websocket limit (two of the 20 saw an HTTP 429 on confirmation and still confirmed) is what to watch before raising it.

## Any token

Which token a round is played in is configuration, not code. `MarbleRush2D/server/tokens.json` lists tokens (symbol, mint, decimals, stake sizes, how players get some):

- `"mint": "create"`: a test token the server owns. Setup creates the mint and the faucet can mint it (`RUSH`).
- `"mint": "<address>"`: any existing token, for example Circle's devnet USDC or a partner's test token. The server holds and pays it out but cannot mint it, so players get it from that token's own faucet.

Partner shows are time windows in `server/data/schedule.json`, read at the start of every round of a table that has no fixed `token` (Live, by default):

```json
{ "shows": [ { "token": "USDC", "from": "2026-10-10T15:00:00Z", "to": "2026-10-10T17:00:00Z" } ] }
```

## Run it

Requires Node 20+.

```bash
npm install
npm run chain:setup     # once: creates the server key, the RUSH mint and the vaults on devnet
npm start               # http://localhost:8090/MarbleRush2D/
```

`chain:setup` needs a little devnet SOL in the server key. It prints the address and tells you if it is short; faucets are listed in `SECURITY.md`. Without setup the game still runs on server demo money.

Configuration (all optional):

| Variable | Meaning |
|---|---|
| `MR_PORT` | listen port (default 8090) |
| `MR_RPC` | Solana RPC URL. Else the first line of `server/data/rpc-url.txt`, else the public devnet node |
| `MR_AUTHORITY_KEY` | the server key as a JSON byte array, instead of `server/data/authority.json` |
| `MR_NO_WORKER=1` | race on the main thread instead of worker threads |
| `MR_TABLES` | path to a tables file, instead of `server/tables.json` |
| `MR_CHAIN_DIR` | where the chain files live (default `server/data`) |
| `MR_FEE_PAYER=player` | players pay their own fee (fallback if a wallet refuses server-paid fees) |
| `MR_TRUST_PROXY=1` | behind a reverse proxy: take the client address from `X-Forwarded-For` |
| `MR_SECURE=1` | always set the Secure cookie flag (also automatic on `X-Forwarded-Proto: https`) |
| `MR_FAUCET_PER_IP`, `MR_FAUCET_PER_DAY` | faucet limits (default 3 per address, 150 per day) |

Serve it over HTTPS in public: the session cookie and wallet signatures depend on it.

## Changing the game while the server runs

Race rules live in a handful of files (`js/rng.js`, `racers.js`, `betting.js`, and `MarbleRush2D/js/{engine2d,track2d,sectionStats,detcheck}.js`). Each round's commit memo records a hash of exactly those files and the git revision (`+dirty` if uncommitted). So:

- `npm run dev` restarts the server whenever a file changes. A restart refunds the bets of the unfinished round and continues the round numbering; nothing is lost.
- If the files change under a *running* server, open pages warn "the game was updated, reload", because the server would otherwise race with older code than the pages load.
- `verify-round` tells you when a round was raced by a different version of the code, and which revision to check out to replay it.

## Tests

```bash
npm run test:e2e     # round server, wallet sign-in, security checks, table rules: minimum, cancel, seats, sleep (no chain needed)
npm run test:load    # 100 simulated players over several tables (a few minutes, no chain)
npm run test:chain   # real devnet: a sealed and verified round, signed bets, refunds, payouts, a server killed mid-round, a live round cancelled for too few players (needs chain:setup and a little SOL)
```

`MarbleRush2D/tools/` also holds the race fairness and drama harnesses (`fairness2d.js`, `drama2d.js`) used to tune the game.

## Layout

```
MarbleRush2D/
  index.html, css/, js/       the game page (canvas) and its client modules
  js/engine2d.js              the deterministic race engine, no DOM
  js/wallet2d.js, net2d.js    wallet sign-in; the live round mirror and signed bets
  js/vendor/solana-web3.js    the one web3.js class the page needs, bundled (npm run build:vendor)
  server/server.mjs           rounds, pool, SSE, API, payouts
  server/auth.mjs             wallet sign-in and sessions
  server/chain.mjs            tokens, faucet, bets, payouts, memos
  server/tokens.json          the token list
  tools/                      verify-round, chain setup, end-to-end tests, QA harnesses
js/                           rng.js, racers.js, betting.js shared with the engine
```

## Roadmap

- An on-chain escrow program (Anchor) so payouts follow program rules instead of the server key.
- A 3D renderer for the same engine (an earlier 3D build exists; the 2D build is the product for now).
- One-time token approval so bets need no wallet popup.

## License

No license has been chosen yet, so all rights are reserved for now.
