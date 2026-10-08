# Deploying MarbleRush on Fly.io

One small machine (1 shared CPU, 1 GB) and a 1 GB volume: about **$6 a month while it runs**, a few cents a month for the disk while it is stopped (check [fly.io/docs/pricing](https://fly.io/docs/pricing/) when you sign up). Nothing here is free except what you stop: see "Spend as little as possible".

The server is **one process with its state in memory**, so it must be exactly one machine. Never scale it past 1.

## What you need

- A Fly.io account with a card (Fly has no free plan for new accounts).
- `flyctl`: `brew install flyctl`, then `fly auth login`.
- This repo, with `MarbleRush2D/server/data/` holding your `authority.json` (the house key), `rpc-url.txt` (your RPC address) and `chain.json` (token addresses). Those stay on your computer: the image never contains the key or the RPC address.

## First deploy

Run these from the repo root.

```bash
# 1. Pick the app name (it must be unique on Fly) and keep this repo's fly.toml.
fly launch --no-deploy --copy-config --name YOUR-APP-NAME

# 2. The volume that holds payout jobs, sessions, stats and the round record. Same region as fly.toml.
fly volumes create mr_data --size 1 --region iad

# 3. The two secrets. Nothing is typed into the shell history: the values are read from your local files.
{ printf 'MR_AUTHORITY_KEY=%s\n' "$(cat MarbleRush2D/server/data/authority.json)"; printf 'MR_RPC=%s\n' "$(head -n1 MarbleRush2D/server/data/rpc-url.txt)"; } | fly secrets import

# 4. Build and start it.
fly deploy
```

Then open `https://YOUR-APP-NAME.fly.dev/MarbleRush2D/` and check:

1. The page loads and shows **Practice** in the top bar. Sign in with Phantom; the faucet should give you RUSH.
2. `fly logs` shows `[chain] devnet, tokens RUSH, USDC` and your house wallet balance. If it instead says `MR_REQUIRE_CHAIN=1 but the chain did not open`, step 3 did not take: `fly secrets list` should show `MR_AUTHORITY_KEY` and `MR_RPC`.
3. `https://YOUR-APP-NAME.fly.dev/MarbleRush2D/stats.html` loads.
4. Place a bet in Practice and watch it settle. That proves sealing, signing, payout and the volume.

`fly.toml` sets `MR_TRUST_PROXY=fly`: the visitor's address is Fly's `Fly-Client-IP` header. **Never set that on a host that is not behind Fly**, where a visitor could send the header themselves. Without a correct client address, every visitor shares one sign-in limit (12 sign-ins a minute for the whole site).

## The house wallet

The server prints the house address at start (`authority 7enD...`). It pays network fees and token-account rent, and holds the vaults. Keep a few tenths of SOL in it: the faucet, new bets and round memos pause when it runs low, so payouts are the last thing to stop. Top up from a devnet faucet (see `SECURITY.md`).

## Spend as little as possible

Fly bills by the second for a running machine. A stopped machine costs only its disk.

```bash
fly machines list                 # shows the machine id
fly machine stop MACHINE_ID       # pause: the link goes down, the volume keeps your data
fly machine start MACHINE_ID      # resume
```

`fly.toml` has `auto_start_machines = false`, so a stopped machine stays stopped until you start it. Stop it when nobody needs the live link, and start it before judging windows and before recording your demo video. Stopping in the middle of a round refunds that round's bets on the next start.

## Updating

```bash
fly deploy
```

A deploy replaces the machine. A round in progress is refunded when the new machine starts (stakes are never kept for an unfinished round), so deploy between rounds when you can. `fly releases` lists versions; `fly deploy --image <previous image>` rolls back.

## Useful commands

```bash
fly logs                          # live server log (no keys, no RPC address)
fly status
fly ssh console                   # a shell on the machine; the data is in /data
fly ssh sftp get /data/stats.json # copy a file off the volume
fly secrets list                  # names only
```

## Before you tell people the link

- Pick the region nearest your players (`fly platform regions`); the volume and `primary_region` must match.
- The link preview image (`og:image`) fills in the right address by itself.
- **The image has not been built on the machine that wrote this guide** (no Docker there). The server, its files and its environment were tested from a folder laid out exactly like the image (`node MarbleRush2D/tools/deploy-check.mjs` and `npm run test:deploy`), but the first `fly deploy` is the first real build. If it fails, the error will name the Dockerfile line; send it to me.
- This is a devnet prototype. Do not point it at mainnet. See `SECURITY.md`.
