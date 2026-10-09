# Deploying MarbleRush on Google Cloud

One small virtual machine (Compute Engine, e2-small: 2 vCPU shared, 2 GB) runs everything:

- **Caddy** takes the HTTPS traffic (a free certificate that renews itself) and passes it on.
- **The game server** (Node, run by systemd) listens only on `127.0.0.1`, so the only way in is through Caddy.
- **`/var/lib/marblerush`** on the VM's disk holds payout jobs, sessions, stats and the round record.
- The address is `https://IP-WITH-DASHES.sslip.io/MarbleRush2D/` (for example `34-29-110-88.sslip.io`): a free name that points at the VM's fixed IP, so no domain is needed. Set `MR_DOMAIN` to use your own.

The server keeps its state **in one process**, so there must be exactly one VM. Never run two.

## Cost

The e2-small is about $13 a month plus about $2 for the disk and fixed IP. On a free-trial account the $300 credit pays for it, and the trial **stops instead of charging your card** unless you press "Upgrade" in the console. Check the Billing page for the credit left.

## First deploy (once)

From the repo root, with `gcloud` signed in and the project chosen (`gcloud config set project ...`):

```bash
gcloud services enable compute.googleapis.com
gcloud compute addresses create marblerush-ip --region us-central1
gcloud compute firewall-rules create marblerush-web --allow tcp:80,tcp:443 --target-tags marblerush
gcloud compute instances create marblerush --zone us-central1-a --machine-type e2-small \
  --image-family debian-12 --image-project debian-cloud --boot-disk-size 20GB \
  --address marblerush-ip --tags marblerush --metadata enable-oslogin=TRUE
```

Commit your changes (only committed code is deployed), then:

```bash
deploy/deploy.sh --secrets
```

`--secrets` reads `authority.json` (the house key), `rpc-url.txt` and `chain.json` from `MarbleRush2D/server/data/` and copies them to the VM: the key and RPC address go into a root-only file (`/etc/marblerush/env`), never into the code, the log or this repo. The first run also installs Node and Caddy on the VM, which takes a few minutes.

Then check `https://IP-WITH-DASHES.sslip.io/MarbleRush2D/`:

1. The page loads and shows **Practice**. Sign in with Phantom; the faucet gives you RUSH.
2. `deploy/vm.sh logs` shows `[chain] devnet, tokens RUSH, USDC` and the house wallet balance. If it says `MR_REQUIRE_CHAIN=1 but the chain did not open`, the key or RPC address did not arrive: run `deploy/deploy.sh --secrets` again.
3. `/MarbleRush2D/stats.html` loads.
4. Place a bet in Practice and watch it settle. That proves sealing, signing, payout and the disk.

## Every later deploy

```bash
git commit ...
deploy/deploy.sh
```

A deploy restarts the server. A round in progress is refunded when it comes back (stakes are never kept for an unfinished round), so deploy between rounds when you can. Each deploy is a new folder under `/opt/marblerush/releases`; the last three are kept. To roll back, point the `current` link at an older one and restart:

```bash
deploy/vm.sh 'sudo ln -sfn /opt/marblerush/releases/OLDER /opt/marblerush/current && sudo systemctl restart marblerush'
```

## Daily use

```bash
deploy/vm.sh status      # is it running
deploy/vm.sh logs        # live server log (no keys, no RPC address)
deploy/vm.sh 'COMMAND'   # any command on the VM
```

Stop the VM when nobody needs the link (the disk and IP still cost a little, the computer does not):

```bash
gcloud compute instances stop marblerush --zone us-central1-a
gcloud compute instances start marblerush --zone us-central1-a
```

Stopping mid-round refunds that round on the next start. The IP is reserved, so the address stays the same.

## Backups

The round record and payout jobs matter if the server dies mid-round. A daily snapshot of the disk, kept for 3 days:

```bash
gcloud compute resource-policies create snapshot-schedule marblerush-daily --region us-central1 \
  --max-retention-days 3 --daily-schedule --start-time 08:00
gcloud compute disks add-resource-policies marblerush --zone us-central1-a --resource-policies marblerush-daily
```

## The house wallet

The server prints the house address at start (`authority 7enD...`). It pays network fees and token-account rent, and holds the vaults. Keep a few tenths of SOL in it: the faucet, new bets and round memos pause when it runs low, so payouts are the last thing to stop. Top up from a devnet faucet (see `SECURITY.md`).

## Security notes

- Only ports 80 and 443 are open to the internet. The game server is not reachable directly, which is why `MR_TRUST_PROXY=1` (take the visitor's address from the proxy) is safe here. Do not set it on a server that is reachable without the proxy.
- The server runs as its own user with a read-only file system except its data folder (see `deploy/marblerush.service`).
- Logins to the VM use your Google account (OS Login); no password or key is shared.
- This is a devnet prototype. Do not point it at mainnet. See `SECURITY.md`.
