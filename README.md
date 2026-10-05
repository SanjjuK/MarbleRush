# MarbleRush

Live parimutuel marble racing on Solana. Everyone watches the same race. You back a marble, stakes go into one pool, and the pool is paid out by finishing position. Every round is **sealed on-chain before betting opens and revealed after the race**, so nobody, including the operator, can pick the result after seeing the bets.

> **Status: devnet prototype.** Test tokens only. Built for the Colosseum Crypto World's Fair hackathon. Not audited, not for real money.

## How a round works

1. **Seal.** The server picks a secret race seed and writes a memo to Solana with `SHA-256(seed)`, the public course seed and a fingerprint of the game code. Betting stays shut until that transaction confirms.
2. **Bet.** You connect a wallet (Phantom, Solflare or Backpack) and sign in with a free message signature. A bet is a single token transfer into the vault that carries a memo naming the round and marble. **The server pays the network fee, so players never need SOL.** The server builds the transaction and only accepts back exactly the bytes it built, signed.
3. **Race.** The engine is deterministic. Every browser replays the same race from the two seeds; the server decides the result and sends a position check every second.
4. **Reveal and pay.** The seed, the finishing order and the pool go on-chain, then winners are paid from the vault. A bet that lands after betting closed is refunded.
5. **Verify.** `node MarbleRush2D/tools/verify-round.mjs <reveal signature>` reads both memos from the chain, checks the seed against the hash, checks the commit came first, and replays the race to confirm the published order. It trusts nothing but the cluster.

## Any token

Which token a round is played in is configuration, not code. `MarbleRush2D/server/tokens.json` lists tokens (symbol, mint, decimals, stake sizes, how players get some):

- `"mint": "create"`: a test token the server owns. Setup creates the mint and the faucet can mint it (`RUSH`).
- `"mint": "<address>"`: any existing token, for example Circle's devnet USDC or a partner's test token. The server holds and pays it out but cannot mint it, so players get it from that token's own faucet.

Partner shows are time windows in `server/data/schedule.json`, read at the start of every round:

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
npm run test:e2e     # round server, wallet sign-in, security checks (no chain needed)
npm run test:chain   # real devnet: a sealed and verified round, signed bets, refunds, payouts, a server killed mid-round (needs chain:setup and a little SOL)
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
