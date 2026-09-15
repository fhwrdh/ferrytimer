#!/usr/bin/env bash
# Archive WSDOT car deck space and vessel positions for later fill-rate and
# delay modeling. Free API, no Google calls. Each fetch is one JSON line,
# appended to a gzipped file per UTC day; past car deck readings can't be
# recovered later, so this runs all day, every day.
# Cron: */5 * * * * /home/fhwrdh/ferrytimer/server/wsdot-archive.sh >> /home/fhwrdh/ferrytimer/data/wsdot-archive.log 2>&1
set -euo pipefail
cd "$(dirname "$0")"
set -a
. ./ferrytimer.env
set +a

OUT_DIR="${DATA_DIR:-/home/fhwrdh/ferrytimer/data}/wsdot"
mkdir -p "$OUT_DIR"

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
FILE="$OUT_DIR/$(date -u +%Y-%m-%d).jsonl.gz"
BASE="https://www.wsdot.wa.gov/ferries/api"

# Prints the response body only on success; curl's error text never includes the URL
fetch() {
  curl -sS --max-time 30 --fail "$BASE/$1?apiaccesscode=$WSDOT_API_KEY" | tr -d '\n'
}

record() {
  printf '{"fetchedAt":"%s","kind":"%s","data":%s}\n' "$NOW" "$1" "$2" | gzip >> "$FILE"
}

archived=0
if body=$(fetch terminals/rest/terminalsailingspace) && [ -n "$body" ]; then
  record sailingspace "$body"
  archived=$((archived + 1))
else
  echo "$NOW sailingspace fetch failed"
fi
if body=$(fetch vessels/rest/vessellocations) && [ -n "$body" ]; then
  record vessellocations "$body"
  archived=$((archived + 1))
else
  echo "$NOW vessellocations fetch failed"
fi

echo "$NOW archived $archived/2"
