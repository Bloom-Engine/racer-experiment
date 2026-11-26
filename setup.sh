#!/usr/bin/env bash
# Creates a clean run folder for one arm (all folders are siblings of this repo).
#   ./setup.sh assets                 -> ../race-assets            (step 0, prompt 0_assets.txt)
#   ./setup.sh A1 1                   -> ../race-A1-run1           (pure Three.js, NO docs)
#   ./setup.sh A2 1                   -> copies race-A1-run1 to race-A2-run1 + docs
#   ./setup.sh B 1 | C 1              -> ../race-B-run1 etc. + assets + docs
#   ./setup.sh D 1 <git-url> <commit> -> ../race-D-run1 (cloned game) + docs
#
# Docs: by default they are taken from the sibling checkouts
#   perry  <- ../perry/perry/docs/src                    (Perry book, markdown source)
#   bloom  <- ../bloom/engine  (README, docs/*.md, src/)  (no perf/evidence dumps)
#   bridge <- ../bloom/three   (README, src/, bin/) + ../bloom/web as bridge/web
# Override any of them with PERRY_DOCS / BLOOM_DOCS / BRIDGE_DOCS (a folder, copied whole
# minus .git, node_modules, target).
set -euo pipefail
EXP="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$EXP")"
ARM="${1:?usage: ./setup.sh <assets|A1|A2|B|C|D> [run] [git-url commit]}"
RUN="${2:-1}"
[[ "$RUN" =~ ^[0-9]+$ ]] || { echo "run must be a number, got '$RUN'"; exit 1; }

die() { echo "error: $*" >&2; exit 1; }

# Commit without depending on the user's git identity / signing config.
git_q() { git -c user.name="race-setup" -c user.email="race-setup@localhost" \
              -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }

fresh_dir() {  # refuse to reuse a folder: re-running would nest docs/ and mix runs
  [ ! -e "$1" ] || die "$1 already exists (remove it first: chmod -R u+w '$1' && rm -rf '$1')"
}

# rsync a folder, skipping VCS/build junk. $1 = src, $2 = dest, rest = extra rsync args
sync_tree() {
  local src="$1" dst="$2"; shift 2
  [ -d "$src" ] || die "docs source not found: $src"
  mkdir -p "$dst"
  rsync -a --exclude .git --exclude node_modules --exclude target --exclude .DS_Store "$@" "${src%/}/" "$dst/"
}

copy_docs() {
  local d="$1/docs"
  mkdir -p "$d"
  # perry
  sync_tree "${PERRY_DOCS:-$ROOT/perry/perry/docs/src}" "$d/perry"
  # bloom
  if [ -n "${BLOOM_DOCS:-}" ]; then
    sync_tree "$BLOOM_DOCS" "$d/bloom"
  else
    local B="$ROOT/bloom/engine"
    [ -d "$B" ] || die "bloom engine not found at $B (or set BLOOM_DOCS)"
    mkdir -p "$d/bloom"
    cp "$B/README.md" "$B/package.json" "$d/bloom/"
    sync_tree "$B/docs" "$d/bloom/docs" --exclude perf --exclude evidence
    sync_tree "$B/src"  "$d/bloom/src"
  fi
  # bridge
  if [ -n "${BRIDGE_DOCS:-}" ]; then
    sync_tree "$BRIDGE_DOCS" "$d/bridge"
  else
    local T="$ROOT/bloom/three" W="$ROOT/bloom/web"
    [ -d "$T" ] || die "bloom three bridge not found at $T (or set BRIDGE_DOCS)"
    mkdir -p "$d/bridge"
    cp "$T/README.md" "$T/package.json" "$d/bridge/"
    sync_tree "$T/src" "$d/bridge/src"
    sync_tree "$T/bin" "$d/bridge/bin"
    if [ -d "$W" ]; then
      mkdir -p "$d/bridge/web"
      cp "$W/README.md" "$W/package.json" "$d/bridge/web/"
      sync_tree "$W/src" "$d/bridge/web/src"
    fi
  fi
}

copy_assets() {
  [ -f "$ROOT/race-assets/assets/manifest.json" ] \
    || die "run step 0 first (race-assets/assets/manifest.json missing)"
  cp -R "$ROOT/race-assets/assets" "$1/assets"
  chmod -R a-w "$1/assets"
}

init_git() { (cd "$1" && git init -q && git_q add -A && git_q commit -qm "initial" --allow-empty); }

PROMPT=""
case "$ARM" in
  assets) D="$ROOT/race-assets"; fresh_dir "$D"; mkdir -p "$D"; init_git "$D"
          PROMPT="$EXP/prompts/0_assets.txt" ;;
  A1)     D="$ROOT/race-A1-run$RUN"; fresh_dir "$D"; mkdir -p "$D"; copy_assets "$D"; init_git "$D"
          PROMPT="$EXP/prompts/A1_threejs.txt" ;;
  A2)     S="$ROOT/race-A1-run$RUN"; D="$ROOT/race-A2-run$RUN"
          [ -d "$S/.git" ] || die "A1 run $RUN missing ($S)"
          fresh_dir "$D"
          cp -R "$S" "$D"
          # snapshot whatever A1 left uncommitted, so the port diff starts from the A1 result
          (cd "$D" && git_q add -A && { git_q diff --cached --quiet || git_q commit -qm "A1 final state"; })
          copy_docs "$D"
          (cd "$D" && git_q add -A docs && git_q commit -qm "add docs for port")
          PROMPT="$EXP/prompts/A2_port.txt" ;;
  B|C)    D="$ROOT/race-$ARM-run$RUN"; fresh_dir "$D"; mkdir -p "$D"; copy_assets "$D"; copy_docs "$D"; init_git "$D"
          [ "$ARM" = B ] && PROMPT="$EXP/prompts/B_bloom.txt" || PROMPT="$EXP/prompts/C_hybrid.txt" ;;
  D)      URL="${3:?D needs <git-url> <commit>}"; COMMIT="${4:?D needs <git-url> <commit>}"
          D="$ROOT/race-D-run$RUN"; fresh_dir "$D"
          git clone -q "$URL" "$D"
          (cd "$D" && git checkout -q "$COMMIT" && git checkout -q -b port)
          copy_docs "$D"
          (cd "$D" && git_q add -f -A docs && git_q commit -qm "add docs for port")
          SAFE="${COMMIT//\//_}"
          PROMPT="$EXP/prompts/D_realworld.$SAFE.txt"
          sed "s|{{COMMIT}}|$COMMIT|g" "$EXP/prompts/D_realworld.txt" > "$PROMPT" ;;
  *) die "unknown arm '$ARM' (assets|A1|A2|B|C|D)" ;;
esac

echo "ready: $D"
echo "prompt: $PROMPT"
echo "run:    cd '$D' && claude \"\$(cat '$PROMPT')\""
