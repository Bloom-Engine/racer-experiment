#!/bin/sh
# Build the native app: bloom-three wraps `perry compile` with the three.js aliases.
#   sh scripts/build.sh                     -> dist/racer            (macOS)
#   sh scripts/build-ios.sh                 -> dist/ios/racer.app    (iPhone, see that script)
# PERRY_DIR picks the Perry build (perry-latest 0.5.1664 miscompiles three.js; see HYBRID_FRICTION.md).
set -e
cd "$(dirname "$0")/.."
PERRY_DIR="${PERRY_DIR:-$HOME/projects/perry/worktrees/perry-main-latest/target}"
export PERRY="${PERRY:-$PERRY_DIR/release/perry}"
# the runtime/stdlib archives must match the target: host ones for macOS, aarch64-apple-ios for iOS
case " $* " in
  *" --target ios "*) export PERRY_RUNTIME_DIR="${PERRY_RUNTIME_DIR:-$PERRY_DIR/aarch64-apple-ios/release}" ;;
  *) export PERRY_RUNTIME_DIR="${PERRY_RUNTIME_DIR:-$PERRY_DIR/release}" ;;
esac
mkdir -p "$(dirname "${OUT:-dist/racer}")"
npx bloom-three build bloom/main.ts -o "${OUT:-dist/racer}" "$@"
