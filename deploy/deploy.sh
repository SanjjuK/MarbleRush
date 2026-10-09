#!/usr/bin/env bash
# deploy.sh: run on YOUR computer. Sends the committed code (git archive: nothing untracked, no keys) to the VM and
# restarts the server. Add --secrets the first time, or when the key or RPC address changes: the house key and RPC
# address are read from your local data folder and copied straight to the VM (root-only file), never printed.
#
#   deploy/deploy.sh [--secrets]
#
# Needs gcloud signed in and a VM named $MR_VM (default marblerush) in $MR_ZONE (default us-central1-a).
set -euo pipefail
cd "$(dirname "$0")/.."
GCLOUD=${GCLOUD:-gcloud} VM=${MR_VM:-marblerush} ZONE=${MR_ZONE:-us-central1-a}
DATA=${MR_CHAIN_DIR:-MarbleRush2D/server/data}
WITH_SECRETS=0; [ "${1:-}" = "--secrets" ] && WITH_SECRETS=1

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

$GCLOUD compute ssh "$VM" --zone "$ZONE" --quiet --command 'mkdir -p ~/mr-in && chmod 700 ~/mr-in'
$GCLOUD compute scp --zone "$ZONE" --quiet "${FILES[@]}" "$VM":mr-in/
$GCLOUD compute ssh "$VM" --zone "$ZONE" --quiet --command \
  'cd ~/mr-in && mkdir -p x && tar -xzf release.tgz -C x deploy/remote.sh && sudo bash x/deploy/remote.sh "$PWD/release.tgz" && rm -rf x'
