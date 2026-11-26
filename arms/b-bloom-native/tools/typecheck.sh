#!/bin/sh
# Strict type-check of the game sources. Bloom's own engine sources are
# compiled by Perry (not tsc) and do not pass strict tsc, so only errors in
# src/ are reported.
cd "$(dirname "$0")/.."
out=$(npx tsc -p . 2>&1 | grep '^src/')
if [ -n "$out" ]; then echo "$out"; exit 1; fi
echo "typecheck OK (game sources, strict)"
