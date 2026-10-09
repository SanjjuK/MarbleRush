#!/usr/bin/env bash
# deploy.sh: run on YOUR computer. Sends the committed code (git archive: nothing untracked, no keys) to the VM and
# restarts the server. Add --secrets the first time, or when the key or RPC address changes: the house key and RPC
# address are read from your local data folder and copied straight to the VM (root-only file), never printed.
#
#   deploy/deploy.sh [--secrets] [--force]
#
# A deploy restarts the server, and a round in progress with real bets is refunded. So it refuses while anyone has a bet
# in a running round (a bet signed in a wallet at that moment could be left unrecorded); --force deploys anyway.
#
# Needs gcloud signed in and a VM named $MR_VM (default marblerush) in $MR_ZONE (default us-central1-a).
set -euo pipefail
cd "$(dirname "$0")/.."
GCLOUD=${GCLOUD:-gcloud} VM=${MR_VM:-marblerush} ZONE=${MR_ZONE:-us-central1-a}
DATA=${MR_CHAIN_DIR:-MarbleRush2D/server/data}
WITH_SECRETS=0 FORCE=0
for a in "$@"; do case "$a" in --secrets) WITH_SECRETS=1 ;; --force) FORCE=1 ;; *) echo "unknown option $a"; exit 2 ;; esac; done

[ -z "$(git status --porcelain --untracked-files=no)" ] || echo "note: uncommitted changes are NOT deployed (only HEAD is)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; umask 077
git archive --format=tar.gz -o "$T/release.tgz" HEAD
FILES=("$T/release.tgz")
if [ $WITH_SECRETS = 1 ]; then
  node -e '
    const fs = require("fs"), d = process.argv[1];
    const key = JSON.stringify(JSON.parse(fs.readFileSync(d + "/authority.json", "utf8")));
    const rpcFile = d + "/rpc-url.txt";
    const rpc = fs.existsSync(rpcFile) ? fs.readFileSync(rpcFile, "utf8").split("\n")[0].trim() : "";
    fs.writeFileSync(process.argv[2], "MR_AUTHORITY_KEY=" + key + "\n" + (rpc ? "MR_RPC=" + rpc + "\n" : ""));
  ' "$DATA" "$T/env"
  cp "$DATA/chain.json" "$T/chain.json"
  FILES+=("$T/env" "$T/chain.json")
fi

if [ $FORCE = 0 ]; then
  BUSY=$($GCLOUD compute ssh "$VM" --zone "$ZONE" --quiet --command "curl -fsS localhost:8080/api/tables 2>/dev/null | python3 -c 'import sys,json; print(sum(t.get(\"bettors\",0) for t in json.load(sys.stdin)[\"tables\"] if t.get(\"phase\") in (\"betting\",\"countdown\",\"racing\")))' 2>/dev/null || echo 0" | tail -n1)
  if [ "${BUSY:-0}" != "0" ]; then echo "not deploying: $BUSY player(s) have a bet in a running round. Wait for the result, or use --force."; exit 3; fi
fi
$GCLOUD compute ssh "$VM" --zone "$ZONE" --quiet --command 'mkdir -p ~/mr-in && chmod 700 ~/mr-in'
$GCLOUD compute scp --zone "$ZONE" --quiet "${FILES[@]}" "$VM":mr-in/
$GCLOUD compute ssh "$VM" --zone "$ZONE" --quiet --command \
  'cd ~/mr-in && mkdir -p x && tar -xzf release.tgz -C x deploy/remote.sh && sudo bash x/deploy/remote.sh "$PWD/release.tgz" && rm -rf x'
