#!/usr/bin/env bash
# Cron wrapper for the Ferry Timer sampler. Loads the same env file pm2 uses,
# so the API keys still live in exactly one place on the droplet.
# Cron: */20 * * * * /home/fhwrdh/ferrytimer/server/run-sampler.sh >> /home/fhwrdh/ferrytimer/data/sampler.log 2>&1
set -euo pipefail
cd "$(dirname "$0")"
set -a
. ./ferrytimer.env
set +a
exec /usr/bin/node dist/sampler.mjs "$@"
