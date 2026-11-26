#!/bin/sh
# iPhone build (arm64 device). A14 baseline = iPhone 12 class (Perry emits RCPC loads, which the
# generic arm64 baseline rejects). --features ios-game-loop is mandatory for a Bloom game loop.
set -e
cd "$(dirname "$0")/.."
OUT=dist/ios/racer sh scripts/build.sh --target ios --features ios-game-loop --march apple-a14 "$@"
