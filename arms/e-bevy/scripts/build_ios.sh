#!/usr/bin/env bash
# Build Apex Rush as an iOS .app bundle without an Xcode project.
#
#   scripts/build_ios.sh            # simulator (aarch64-apple-ios-sim), ad-hoc signed
#   scripts/build_ios.sh --device   # iPhone (aarch64-apple-ios); needs
#        IOS_SIGN_IDENTITY="Apple Development: Name (TEAMID)" and
#        IOS_PROFILE=/path/to/profile.mobileprovision (with matching bundle id)
#
# Then (simulator):  xcrun simctl install booted target/ios/sim/ApexRush.app
#                    xcrun simctl launch --console booted com.skelpo.apexrush
# or (device):       xcrun devicectl device install app --device <UDID> target/ios/device/ApexRush.app
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET=aarch64-apple-ios-sim
KIND=sim
if [[ "${1:-}" == "--device" ]]; then
  TARGET=aarch64-apple-ios
  KIND=device
fi
export IPHONEOS_DEPLOYMENT_TARGET=15.0

cargo build --release --target "$TARGET" --bin racer

APP="target/ios/$KIND/ApexRush.app"
rm -rf "$APP"
mkdir -p "$APP"
cp "target/$TARGET/release/racer" "$APP/racer"
cp ios/Info.plist "$APP/Info.plist"
# Runtime assets only (previews/reports/schema are documentation).
rsync -a --exclude previews --exclude reports --exclude manifest.schema.json assets/ "$APP/assets/"

if [[ "$KIND" == "device" && -z "${IOS_SIGN_IDENTITY:-}" ]]; then
  echo "warning: IOS_SIGN_IDENTITY not set - device bundle left unsigned (cannot be installed)"
elif [[ "$KIND" == "device" ]]; then
  : "${IOS_PROFILE:?set IOS_PROFILE to a .mobileprovision for com.skelpo.apexrush}"
  cp "$IOS_PROFILE" "$APP/embedded.mobileprovision"
  security cms -D -i "$IOS_PROFILE" > target/ios/profile.plist
  /usr/libexec/PlistBuddy -x -c 'Print :Entitlements' target/ios/profile.plist > target/ios/entitlements.plist
  codesign --force --sign "$IOS_SIGN_IDENTITY" --entitlements target/ios/entitlements.plist "$APP"
else
  codesign --force --sign - "$APP"
fi
echo "built $APP ($(du -sh "$APP" | cut -f1))"
