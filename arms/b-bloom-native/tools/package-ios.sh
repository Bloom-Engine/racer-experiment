#!/bin/sh
# Build, package, sign and (optionally) install + launch the iOS app.
#
#   tools/package-ios.sh            build + sign -> dist/ios/BloomRacer.app
#   tools/package-ios.sh install [game args]   ... and install + launch on the connected iPhone
#
# Works around three Perry 0.5.1664 issues (see BLOOM_FRICTION.md):
#  - iOS builds link the host (macOS) stdlib unless PERRY_RUNTIME_DIR points at the iOS one
#  - `perry compile` does not sign; it also bundles ./resources as "resources/", which
#    collides with the reserved "Resources" dir and makes codesign reject the bundle
#  - perry.toml [ios] category is not written to Info.plist
set -e
cd "$(dirname "$0")/.."
PERRY_IOS_RT="${PERRY_IOS_RT:-$HOME/projects/perry/worktrees/perry-latest/target/aarch64-apple-ios/release}"
IDENTITY="${IOS_IDENTITY:?set IOS_IDENTITY to your Apple Development signing identity}"
PROFILE="${IOS_PROFILE:-$HOME/.perry/com_skelpo_bloomracer_dev.mobileprovision}"
DEVICE="${IOS_DEVICE:-6F220DD1-012C-5FF2-9EE7-BEC1CEA74497}"
APP=dist/ios/BloomRacer.app
TMP=$(mktemp -d)

rm -rf dist/ios && mkdir -p dist/ios
PERRY_RUNTIME_DIR="$PERRY_IOS_RT" perry compile src/main.ts -o dist/ios/BloomRacer --target ios --features ios-game-loop 2>&1 \
  | grep -E "Wrote|error" | grep -v "ld: warning" || true
test -d "$APP" || { echo "build failed"; exit 1; }

mv "$APP/resources" "$APP/gamedata"
plutil -replace LSApplicationCategoryType -string public.app-category.games "$APP/Info.plist"
plutil -replace GCSupportsControllerUserInteraction -bool YES "$APP/Info.plist"
cp "$PROFILE" "$APP/embedded.mobileprovision"
security cms -D -i "$APP/embedded.mobileprovision" > "$TMP/prof.plist"
plutil -extract Entitlements xml1 -o "$TMP/ent.plist" "$TMP/prof.plist"
xattr -cr "$APP"
codesign --force --sign "$IDENTITY" --entitlements "$TMP/ent.plist" --timestamp=none "$APP"
codesign --verify --deep "$APP" && echo "signed: $APP ($(du -sh "$APP" | cut -f1))"
rm -rf "$TMP"

if [ "$1" = "install" ]; then
  shift
  xcrun devicectl device install app --device "$DEVICE" "$APP"
  # extra arguments are passed to the game (e.g. --autopilot --autostart --bench)
  xcrun devicectl device process launch --terminate-existing --console --device "$DEVICE" com.skelpo.bloomracer "$@"
fi
