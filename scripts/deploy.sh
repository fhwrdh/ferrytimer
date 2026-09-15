#!/usr/bin/env bash
# Build locally and ship to the DO droplet (ferry.fhwrdh.net).
#
# The droplet can't run the Vite build (too little RAM, arm64/amd64 esbuild),
# so we build on the Mac and rsync the artifacts. Secrets live only in
# server/ferrytimer.env on the droplet and are never touched by this script.
set -euo pipefail

HOST="fhwrdh@159.223.202.42"
REMOTE="~/ferrytimer"

echo "==> building"
npm run build
npm run build:sampler

echo "==> syncing dist/"
rsync -az --delete dist/ "$HOST:$REMOTE/dist/"

echo "==> syncing server code"
rsync -az server/server.mjs server/ecosystem.config.cjs server/run-sampler.sh server/wsdot-archive.sh "$HOST:$REMOTE/server/"
rsync -az --delete server/dist/ "$HOST:$REMOTE/server/dist/"

echo "==> reloading pm2"
ssh "$HOST" 'cd ~/ferrytimer/server && pm2 reload ferrytimer --update-env && pm2 save'

echo "==> done: https://ferry.fhwrdh.net"
