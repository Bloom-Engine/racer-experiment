#!/bin/sh
# Compile folio-2025 (../sources) into a native Bloom app with Perry.
#   sh bloom/build.sh          -> bloom/dist/folio
# Needs Perry built from main ($PERRY_DIR/target/release) and the Bloom repos (engine, web, three) at $BLOOM.
set -e
cd "$(dirname "$0")"
BLOOM="${BLOOM:-$HOME/projects/bloom}"
mkdir -p node_modules/@bloomengine
for p in engine web three; do
  [ -e "node_modules/@bloomengine/$p" ] || ln -s "$BLOOM/$p" "node_modules/@bloomengine/$p"
done
OUT="${OUT:-dist/folio}"
PERRY_DIR="${PERRY_DIR:-$HOME/projects/perry/worktrees/perry-main-latest}"
export PERRY_RUNTIME_DIR="${PERRY_RUNTIME_DIR:-$PERRY_DIR/target/release}"
PERRY="${PERRY:-$PERRY_DIR/target/release/perry}"
[ "$SKIP_STAGE" = 1 ] || node stage.mjs
mkdir -p "$(dirname "$OUT")"
THREE=$(cd .. && pwd)/node_modules/three
HERE=$(pwd)
# the bridge's aliases, except three/webgpu (three-webgpu.ts: the real WebGPU build with the Bloom renderer)
ALIASES=$(cd .. && node "$BLOOM/three/bin/bloom-three.mjs" aliases | grep -v '^--module-alias=three/webgpu=')
# shellcheck disable=SC2086
"$PERRY" compile main.ts -o "$OUT" $ALIASES \
  --module-alias=three/webgpu="$HERE/three-webgpu.ts" \
  --module-alias=folio-bloom/real/three-webgpu="$HERE/.build/three/three.webgpu.js" \
  --module-alias=three/tsl="$HERE/.build/three/three.tsl.js" \
  --module-alias=@dimforge/rapier3d="$HERE/rapier.ts" \
  --module-alias=three/addons/loaders/DRACOLoader.js="$HERE/alias/wasm-loaders.ts" \
  --module-alias=three/addons/loaders/KTX2Loader.js="$HERE/alias/wasm-loaders.ts" \
  --module-alias=gsap="$HERE/.build/gsap/index.js" \
  --module-alias=howler="$HERE/.build/howler/howler.js" \
  --module-alias=seedrandom="$HERE/alias/seedrandom.ts" \
  --module-alias=folio-bloom/real/seedrandom="$(cd .. && pwd)/node_modules/seedrandom/index.js" \
  --module-alias=three/src/math/MathUtils.js="$HERE/alias/three-src.ts" \
  --module-alias=three/src/renderers/common/CubeRenderTarget.js="$HERE/alias/three-src.ts" \
  "$@"
