# Security

MarbleRush is a **devnet prototype**. It has not been audited. Do not point it at mainnet or real funds.

## Reporting

Please report vulnerabilities privately to the maintainers (open a private security advisory on the GitHub repository) instead of a public issue.

## Model

- **Identity.** A player is a Solana address. Sign-in is an ed25519 signature over a server-built message with a one-time nonce (5 minutes), checked server-side. The session is a random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` on HTTPS); only its SHA-256 is stored. Sessions last 14 days, are capped in number, and die on logout. The server never sees a private key.
- **Bets.** The server builds every transaction and only accepts back those exact bytes with the wallet's signature. A signed bet is single-use and its blockhash expires in about a minute. Bets that land after betting closes are refunded.
- **The house key.** One server key owns the vaults, pays fees and is mint authority of the demo token. It is a hot key on a devnet server: `server/data/authority.json` (mode 600, git-ignored) or `MR_AUTHORITY_KEY`. If it leaks, an attacker can drain the vaults; on devnet that is play money. Mainnet would need an escrow program or a multisig and a signing service.
- **Fairness.** Each round's seed hash goes on-chain before betting; verify with `tools/verify-round.mjs`.

## Hardening in place

- Strict `Content-Security-Policy` (scripts from our own origin only), `nosniff`, no framing, no referrer, HSTS on HTTPS.
- The server serves only the page, its CSS and scripts, and three shared modules; server code, tools, data and the README are not reachable.
- POSTs must come from our own origin; no CORS headers are sent.
- Rate limits: API calls per address, sign-in nonces per address, bet builds per player, open streams per address, faucet per address and per day.
- The faucet and the round memos stop before the house wallet runs out of SOL, so payouts are the last thing to run dry.
- A server restart mid-round refunds that round's bets (they are saved as they land) and continues the round numbering. A round's commit memo carries a hash of the race code and the git revision.
- Payouts are written to disk with their signature before being sent, and are checked against the cluster after a crash, so they are neither lost nor paid twice.
- Log lines never contain the RPC URL or its API key. Secrets live only in `server/data/` (git-ignored), never in the repo.
- Text from the network is escaped before it reaches the page.

## Known limits

- Dependencies: `npm audit` reports advisories in transitive packages of `@solana/web3.js` 1.x (`bigint-buffer`, `jayson`, `uuid`, `stream-json`). They matter only if the RPC endpoint is malicious; there is no non-breaking fix yet. Migrating to `@solana/kit` is on the list.
- The house vault is custodial and pays the house bots' share of winnings from its float.
- A player who signs a bet and sends the transaction to the network themselves, instead of through us, would lose the stake into the vault without a bet being recorded.
- No alerting: a failed payout (after six retries) is only visible in the server log.
- Single process, in-memory state with periodic saves; not built for horizontal scaling.

## Getting devnet SOL for the server key

The key needs a little SOL for fees and token-account rent (about 0.002 SOL per new player). Faucets that need no login: <https://faucet.solana.com>, <https://faucet.quicknode.com/solana/devnet>, and community faucets. The server logs the house balance on start and warns when it is low.
