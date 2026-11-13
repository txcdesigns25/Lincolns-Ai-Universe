#!/bin/sh
# Single entrypoint for every Railway service. SERVICE_ROLE decides what runs:
#   SERVICE_ROLE=worker  -> background worker (agents, scheduler, Telegram)
#   anything else        -> web dashboard on $PORT (default 3000)
# Both run database migrations first (safe to run at the same time).
set -e
case "$SERVICE_ROLE" in
  worker) echo "[start] role=worker"; exec pnpm start:worker ;;
  *)      echo "[start] role=web port=${PORT:-3000}"; exec pnpm start:web ;;
esac
