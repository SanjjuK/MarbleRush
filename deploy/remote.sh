#!/usr/bin/env bash
# remote.sh: runs ON the VM, as root, from deploy.sh. Safe to run again: it installs what is missing, unpacks the
# release it was given, and restarts the server. Usage: remote.sh RELEASE.tgz [--first]
set -euo pipefail
TGZ=${1:?release tarball}
NODE_VERSION=24.21.0
APP=/opt/marblerush DATA=/var/lib/marblerush ETC=/etc/marblerush
export DEBIAN_FRONTEND=noninteractive

id marblerush >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin marblerush
install -d -o marblerush -g marblerush -m 0750 "$DATA"
install -d -m 0755 "$APP/releases"
install -d -m 0750 "$ETC"

if [ ! -x /opt/node/bin/node ] || [ "$(/opt/node/bin/node -v)" != "v$NODE_VERSION" ]; then
  apt-get update -qq && apt-get install -y -qq ca-certificates curl >/dev/null
  cd "$(mktemp -d)"
  curl -fsSL -O "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.gz"
  curl -fsSL -O "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  grep " node-v$NODE_VERSION-linux-x64.tar.gz\$" SHASUMS256.txt | sha256sum -c -
  rm -rf /opt/node && mkdir -p /opt/node && tar -xzf "node-v$NODE_VERSION-linux-x64.tar.gz" -C /opt/node --strip-components=1
  cd /
fi

if ! command -v caddy >/dev/null; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gpg >/dev/null
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
dpkg -s unattended-upgrades >/dev/null 2>&1 || apt-get install -y -qq unattended-upgrades >/dev/null

if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

REL="$APP/releases/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$REL" && tar -xzf "$TGZ" -C "$REL"
( cd "$REL" && /opt/node/bin/node /opt/node/lib/node_modules/npm/bin/npm-cli.js ci --omit=dev --ignore-scripts --no-audit --no-fund )
chown -R root:root "$REL"
ln -sfn "$REL" "$APP/current"
ls -1dt "$APP"/releases/* | tail -n +4 | xargs -r rm -rf          # keep the last three releases

# secrets and chain.json arrive next to the tarball only when deploy.sh was run with --secrets
IN=$(dirname "$TGZ")
[ -f "$IN/env" ] && install -m 0600 -o root -g root "$IN/env" "$ETC/env" && rm -f "$IN/env"
[ -f "$IN/chain.json" ] && install -m 0640 -o marblerush -g marblerush "$IN/chain.json" "$DATA/chain.json" && rm -f "$IN/chain.json"
[ -f "$ETC/env" ] || { echo "no $ETC/env yet: run deploy.sh with --secrets"; exit 1; }
[ -f "$DATA/chain.json" ] || { echo "no $DATA/chain.json yet: run deploy.sh with --secrets"; exit 1; }

IP=$(curl -fsS -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip)
DOMAIN=${MR_DOMAIN:-$(echo "$IP" | tr . -).sslip.io}
sed "s/__DOMAIN__/$DOMAIN/" "$REL/deploy/Caddyfile" > /etc/caddy/Caddyfile
install -m 0644 "$REL/deploy/marblerush.service" /etc/systemd/system/marblerush.service
systemctl daemon-reload
systemctl enable --now marblerush >/dev/null 2>&1
systemctl restart marblerush
systemctl reload caddy 2>/dev/null || systemctl restart caddy
rm -f "$TGZ"
echo "deployed $(basename "$REL") -> https://$DOMAIN/MarbleRush2D/"
