#!/bin/sh
# Runs as root only long enough to prepare the volume, then drops to the unprivileged "node" user.
set -e
mkdir -p /data
# First start on a fresh volume: the public token addresses. Never overwrites a file already on the volume.
[ -f /data/chain.json ] || { [ -f /app/MarbleRush2D/server/data/chain.json ] && cp /app/MarbleRush2D/server/data/chain.json /data/chain.json; } || true
chown -R node:node /data
exec setpriv --reuid=node --regid=node --init-groups "$@"
