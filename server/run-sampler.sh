#!/usr/bin/env bash
# Cron wrapper for the Ferry Timer sampler. Loads the same env file pm2 uses,
# so the API keys still live in exactly one place on the droplet.
set -euo pipefail
cd "$(dirname "$0")"
set -a
. ./ferrytimer.env
set +a
exec /usr/bin/node dist/sampler.mjs "$@"
