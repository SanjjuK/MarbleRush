#!/usr/bin/env bash
# vm.sh: run a command on the VM, or: vm.sh status | logs
set -euo pipefail
GCLOUD=${GCLOUD:-gcloud} VM=${MR_VM:-marblerush} ZONE=${MR_ZONE:-us-central1-a}
case "${1:-status}" in
  status) CMD='systemctl is-active marblerush caddy; systemctl status marblerush --no-pager -n 5 | tail -n 8' ;;
  logs)   CMD='sudo journalctl -u marblerush -f -n 80 --no-pager' ;;
  *)      CMD="$*" ;;
esac
exec $GCLOUD compute ssh "$VM" --zone "$ZONE" --quiet --command "$CMD"
