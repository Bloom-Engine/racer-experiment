#!/bin/sh
# Build folio-2025 for iPhone with Perry and Bloom (Metal), after ~/projects/chess/web3d/bloom/build-ios.sh.
#
#   sh bloom/build-ios.sh device   device build, signed for development, installed and launched on the connected iPhone
#   sh bloom/build-ios.sh sim      simulator build, installed and launched on the booted simulator
#
# Settings (environment):
#   PERRY_DIR      Perry checkout built from main (default ~/projects/perry/worktrees/perry-main-latest)
#   IOS_DEVICE     devicectl device id (default: the first connected iPhone)
#   DEV_PROFILE    development .mobileprovision (default: the team's profile for the bundle id, or its * profile)
#   DEV_IDENTITY   signing identity (default: the keychain identity whose certificate is in the profile)
#   TEAM_ID        Apple team (default: [apple] team_id in ~/.perry/config.toml)
#   SKIP_BUILD=1   sign and install the last build again
set -e
cd "$(dirname "$0")"
MODE="${1:-device}"
BUNDLE_ID=$(sed -n 's/^bundle_id = "\(.*\)"/\1/p' perry.toml | head -1)
NAME=folio
PERRY_DIR="${PERRY_DIR:-$HOME/projects/perry/worktrees/perry-main-latest}"
case "$MODE" in
  sim) TARGET=ios-simulator; TRIPLE=aarch64-apple-ios-sim; OUT=dist/ios-sim; OS=iOS ;;
  device) TARGET=ios; TRIPLE=aarch64-apple-ios; OUT=dist/ios; OS=iOS ;;
  *) echo "usage: build-ios.sh device|sim" >&2; exit 2 ;;
esac
# Perry's runtime, stdlib and UI libraries built for the target (README.md)
export PERRY_RUNTIME_DIR="$PERRY_DIR/target/$TRIPLE/release"
# --features ios-game-loop: UIKit gets the main thread, the game its own. Device code is compiled
# for the A12 (Perry otherwise emits RCpc loads that its stack-map assembly rejects).
case "$TARGET" in ios) CPU="--march apple-a12" ;; *) CPU="" ;; esac
if [ "$SKIP_BUILD" != 1 ]; then
  rm -rf "$OUT/$NAME.app"
  OUT="$OUT/$NAME" sh build.sh --target "$TARGET" --features ios-game-loop $CPU
fi
APP="$OUT/$NAME.app"
[ -d "$APP" ] || { echo "no app bundle at $APP" >&2; exit 1; }

/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$APP/Info.plist"
/usr/libexec/PlistBuddy -c "Add :UIStatusBarHidden bool true" "$APP/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :UIRequiresFullScreen bool true" "$APP/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :NSCameraUsageDescription" "$APP/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :NSMicrophoneUsageDescription" "$APP/Info.plist" 2>/dev/null || true

profile_plist() { security cms -D -i "$1"; }
TEAM_ID="${TEAM_ID:-$(sed -n 's/^team_id = "\(.*\)"/\1/p' "$HOME/.perry/config.toml" 2>/dev/null | head -1)}"
identity_for() {   # the keychain identity (SHA-1) whose certificate the profile lists
  ids=$(security find-identity -v -p codesigning | awk '{print $2}')
  i=0
  while profile_plist "$1" | plutil -extract "DeveloperCertificates.$i" raw - > "$OUT/cert.b64" 2>/dev/null; do
    sha=$(base64 -d -i "$OUT/cert.b64" | shasum -a 1 | awk '{print toupper($1)}')
    if echo "$ids" | grep -q "^$sha$"; then echo "$sha"; return; fi
    i=$((i + 1))
  done
}
find_profile() {   # the first valid development profile covering the bundle id (exact, then wildcard)
  best=""
  for f in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"/*.mobileprovision "$HOME/Library/MobileDevice/Provisioning Profiles"/*.mobileprovision "$HOME"/.perry/*.mobileprovision; do
    [ -f "$f" ] || continue
    p=$(profile_plist "$f" 2>/dev/null) || continue
    app=$(echo "$p" | plutil -extract Entitlements.application-identifier raw - 2>/dev/null) || continue
    case "$app" in "$TEAM_ID".*) ;; *) continue ;; esac
    echo "$p" | plutil -extract Platform json -o - - 2>/dev/null | grep -q "\"$OS\"" || continue
    exp=$(echo "$p" | plutil -extract ExpirationDate raw - 2>/dev/null)
    [ "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \< "$exp" ] || continue
    echo "$p" | plutil -extract ProvisionedDevices raw - >/dev/null 2>&1 || continue
    case "$app" in
      *."$BUNDLE_ID") echo "$f"; return ;;
      *.\*) [ -z "$best" ] && best="$f" ;;
    esac
  done
  echo "$best"
}

case "$MODE" in
  sim)
    xcrun simctl install booted "$APP"
    xcrun simctl launch booted "$BUNDLE_ID"
    ;;
  device)
    PROFILE="${DEV_PROFILE:-$(find_profile)}"
    [ -n "$PROFILE" ] || { echo "no development profile for $BUNDLE_ID (set DEV_PROFILE)" >&2; exit 1; }
    IDENTITY="${DEV_IDENTITY:-$(identity_for "$PROFILE")}"
    [ -n "$IDENTITY" ] || { echo "no keychain identity for a certificate in $PROFILE (set DEV_IDENTITY)" >&2; exit 1; }
    echo "signing with $IDENTITY, profile $PROFILE"
    cp "$PROFILE" "$APP/embedded.mobileprovision"
    TEAM=$(profile_plist "$PROFILE" | plutil -extract TeamIdentifier.0 raw -)
    cat > "$OUT/entitlements.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>application-identifier</key><string>$TEAM.$BUNDLE_ID</string>
  <key>com.apple.developer.team-identifier</key><string>$TEAM</string>
  <key>get-task-allow</key><true/>
</dict></plist>
EOF
    codesign --force --sign "$IDENTITY" --entitlements "$OUT/entitlements.plist" --timestamp=none --generate-entitlement-der "$APP"
    codesign --verify --strict "$APP"
    DEVICE="${IOS_DEVICE:-$(xcrun devicectl list devices 2>/dev/null | grep "available (paired)" | grep -i iphone | head -1 | awk '{for (i=1;i<=NF;i++) if ($i ~ /^[0-9A-F]{8}-/) {print $i; exit}}')}"
    [ -n "$DEVICE" ] || { echo "no connected iPhone (set IOS_DEVICE)" >&2; exit 1; }
    xcrun devicectl device install app --device "$DEVICE" "$APP"
    xcrun devicectl device process launch --device "$DEVICE" "$BUNDLE_ID"
    ;;
esac
