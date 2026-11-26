#!/bin/sh
# Browser build: game → WASM (perry --target wasm), Bloom engine → WASM
# (wasm-pack, WebGPU/WebGL2 via wgpu), physics → JoltPhysics.js.
#
#   tools/build-web.sh                 # → dist/web/
#   tools/build-web.sh --engine        # also rebuild Bloom's bloom_web.wasm first
#   tools/build-web.sh --serve         # build, then serve on http://localhost:8080
#
# Unlike Bloom's generic `bloom-web` script this ships only the files the game
# loads, embeds track.glb's external textures (the web loader gets bytes only,
# no base directory), vendors JoltPhysics.js (no CDN at runtime) and writes
# assets_manifest.json so the engine prefetches everything with a progress
# readout before the game starts.
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
BLOOM_WEB="$(cd node_modules/bloom/native/web && pwd)"
OUT="$ROOT/dist/web"
ENGINE=0
SERVE=0
for a in "$@"; do
  case "$a" in
    --engine) ENGINE=1 ;;
    --serve) SERVE=1 ;;
    *) echo "unknown option: $a"; exit 2 ;;
  esac
done

# Bloom's web crate must attach glTF primitives with their node placement
# (tools/bloom-web-attach-model.patch); without it the car wheels render in
# the wrong place in the browser.
if ! grep -q "attach_model_mesh(node_handle, mesh, source_transform" "$BLOOM_WEB/src/lib.rs"; then
  echo "WARNING: Bloom's native/web/src/lib.rs lacks the attach-model fix."
  echo "         Apply it and rebuild the engine:"
  echo "         (cd node_modules/bloom && git apply \"$ROOT/tools/bloom-web-attach-model.patch\") && tools/build-web.sh --engine"
fi

if [ "$ENGINE" = 1 ] || [ ! -f "$BLOOM_WEB/pkg/bloom_web_bg.wasm" ]; then
  echo "[engine] wasm-pack build (Bloom web crate)"
  (cd "$BLOOM_WEB" && wasm-pack build --target web --out-dir pkg --no-typescript)
fi

echo "[game] perry compile --target wasm"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
perry compile src/main.ts --target wasm -o "$TMP/game.html"

echo "[assemble] $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"
python3 "$BLOOM_WEB/splice_game.py" "$TMP/game.html" "$OUT/index.html"
# Page polish: title, no scrollbars, keep keyboard focus on the game.
python3 - "$OUT/index.html" <<'EOF'
import sys, re
p = sys.argv[1]
s = open(p).read()
s = re.sub(r'<title>.*?</title>', '<title>Bloom Racer</title>', s, count=1, flags=re.S)
s = s.replace('</head>', '<link rel="icon" href="data:,">\n<style>html,body{margin:0;height:100%;overflow:hidden;background:#000;touch-action:none}</style>\n</head>', 1)
# Game flags from the URL (?autopilot&frames=600 → "--autopilot --frames 600"),
# handed over through Bloom's localStorage-backed file store (src/main.ts webArgs).
FLAGS = """<script>
try {
  const a = [];
  for (const [k, v] of new URLSearchParams(location.search)) { a.push('--' + k); if (v) a.push(v); }
  if (a.length) localStorage.setItem('bloom_fs:flags', a.join(' '));
  else localStorage.removeItem('bloom_fs:flags');
} catch (e) {}
</script>
"""
s = s.replace('</head>', FLAGS + '</head>', 1)
# Perry wasm runtime (0.5.1664): allocHandle() registers a NEW handle every time
# an object crosses into JS, even one it already knows, and handles are never
# freed. This game re-boxes ~100k objects/s, so the Map hits V8's size limit
# (~16.7M) after ~160 s ("RangeError: Map maximum size exceeded"). Reuse the
# existing handle for an already-registered object; entries are never
# re-pointed, so the mapping stays valid.
DEDUPE_OLD_A = """function allocHandle(obj) {
  const id = nextHandleId++;
  handleStore.set(id, obj);
  return id;
}"""
DEDUPE_NEW_A = """const __handleIds = new WeakMap();
function allocHandle(obj) {
  const keyed = obj !== null && (typeof obj === 'object' || typeof obj === 'function');
  if (keyed) { const known = __handleIds.get(obj); if (known !== undefined) return known; }
  const id = nextHandleId++;
  handleStore.set(id, obj);
  if (keyed) __handleIds.set(obj, id);
  return id;
}"""
DEDUPE_OLD_B = "function allocHandle(obj) { const id = nextHandleId++; handleStore.set(id, obj); return id; }"
DEDUPE_NEW_B = ("const __handleIds2 = new WeakMap();\n"
  "function allocHandle(obj) { const keyed = obj !== null && (typeof obj === 'object' || typeof obj === 'function'); "
  "if (keyed) { const known = __handleIds2.get(obj); if (known !== undefined) return known; } "
  "const id = nextHandleId++; handleStore.set(id, obj); if (keyed) __handleIds2.set(obj, id); return id; }")
for old, new in ((DEDUPE_OLD_A, DEDUPE_NEW_A), (DEDUPE_OLD_B, DEDUPE_NEW_B)):
    if s.count(old) != 1:
        raise SystemExit('build-web: Perry allocHandle shape changed; re-check the handle dedupe patch')
    s = s.replace(old, new)
open(p, 'w').write(s)
EOF
cp -r "$BLOOM_WEB/pkg" "$OUT/pkg"
rm -f "$OUT/pkg/.gitignore" "$OUT/pkg/package.json"
cp "$BLOOM_WEB/bloom_glue.js" "$BLOOM_WEB/jolt_bridge.js" "$OUT/"
# Bloom's web physics bridge needs fixes for the JoltPhysics.js API; patch the
# copies we ship (wasm-bindgen bundles its own copy under pkg/snippets/).
python3 tools/patch-jolt-bridge.py "$OUT/jolt_bridge.js" "$OUT"/pkg/snippets/*/jolt_bridge.js
cp node_modules/jolt-physics/dist/jolt-physics.wasm-compat.js "$OUT/jolt-physics.mjs"

# Every "assets/…" literal in the game sources, plus the generated data.
FILES="$(grep -rohE '"assets/[^"]+"' src | tr -d '"' | sort -u)
$(cd "$ROOT" && find resources -type f ! -name '.*' | sort)"
for f in $FILES; do
  mkdir -p "$OUT/$(dirname "$f")"
  cp "$f" "$OUT/$f"
done
node --no-warnings tools/embed-glb.ts assets/track/track.glb "$OUT/assets/track/track.glb"

printf '%s\n' $FILES | python3 -c '
import json, sys
files = [l.strip() for l in sys.stdin if l.strip()]
json.dump({"files": files}, open(sys.argv[1], "w"), indent=1)
' "$OUT/assets_manifest.json"

echo ""
echo "dist/web: $(du -sh "$OUT" | cut -f1)  (engine wasm $(($(wc -c < "$OUT/pkg/bloom_web_bg.wasm") / 1024)) KB, game html $(($(wc -c < "$OUT/index.html") / 1024)) KB)"
if [ "$SERVE" = 1 ]; then
  echo "serving http://localhost:8080  (Ctrl-C to stop)"
  cd "$OUT" && exec python3 -m http.server 8080
fi
echo "serve: (cd dist/web && python3 -m http.server 8080) → http://localhost:8080"
