#!/bin/sh
# Compile Apex Rush (../src) into a native Bloom app with Perry.
#   sh bloom/build.sh          -> bloom/dist/apexrush
# Needs Perry built from latest main ($PERRY_DIR/target/release) and the Bloom repos (engine, web, three) at $BLOOM.
set -e
cd "$(dirname "$0")"
BLOOM="${BLOOM:-$HOME/projects/bloom}"
mkdir -p node_modules/@bloomengine
for p in engine web three; do
  [ -e "node_modules/@bloomengine/$p" ] || ln -s "$BLOOM/$p" "node_modules/@bloomengine/$p"
done
OUT="${OUT:-dist/apexrush}"
PERRY_DIR="${PERRY_DIR:-$HOME/projects/perry/worktrees/perry-main-latest}"
export PERRY_RUNTIME_DIR="${PERRY_RUNTIME_DIR:-$PERRY_DIR/target/release}"
PERRY="${PERRY:-$PERRY_DIR/target/release/perry}"
sh stage-assets.sh
mkdir -p "$(dirname "$OUT")"
ALIASES=$(cd .. && node "$BLOOM/three/bin/bloom-three.mjs" aliases)
# shellcheck disable=SC2086
"$PERRY" compile main.ts -o "$OUT" $ALIASES "$@"
