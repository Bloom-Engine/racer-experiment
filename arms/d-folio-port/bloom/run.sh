#!/bin/sh
# Run the dev build with a BLOOM_SCRIPT; screenshots go to $SHOTS (default: the scratchpad).
#   sh run.sh <name> "<script>"   -> run-<name>.log, $SHOTS/<name>-*.png
cd "$(dirname "$0")"
NAME="$1"; shift
SHOTS="${SHOTS:-./shots}"
SCRIPT=$(echo "$1" | sed "s|@|$SHOTS/$NAME-|g")
BLOOM_SCRIPT="$SCRIPT" timeout "${TIMEOUT:-240}" ./dist/folio > "run-$NAME.log" 2>&1
echo "exit=$?"
