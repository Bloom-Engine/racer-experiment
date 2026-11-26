#!/bin/sh
# Build the Mac app (Apple silicon), after ~/projects/chess/web3d/bloom/build-macos.sh:
#   sh bloom/build-macos.sh   -> bloom/dist/macos/Bruno.app (signed ad hoc, runs here)
# SKIP_BUILD=1 bundles the last build again.
set -e
cd "$(dirname "$0")"
BUNDLE_ID=$(sed -n 's/^bundle_id = "\(.*\)"/\1/p' perry.toml | head -1)
NAME=$(sed -n 's/^display_name = "\(.*\)"/\1/p' perry.toml | head -1)
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' perry.toml | head -1)
EXE=folio
OUT=dist/macos
APP="$OUT/$NAME.app"
MIN_MACOS="${MIN_MACOS:-13.0}"
if [ "$SKIP_BUILD" != 1 ]; then MACOSX_DEPLOYMENT_TARGET="$MIN_MACOS" OUT="$OUT/$EXE" sh build.sh; else node stage.mjs; fi
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/assets"
cp "$OUT/$EXE" "$APP/Contents/MacOS/$EXE"
# @bloomengine/web finds the site in Contents/Resources/assets/folio
cp -R assets/folio "$APP/Contents/Resources/assets/"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleExecutable</key><string>$EXE</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>$MIN_MACOS</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.adventure-games</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP"
echo "$APP"
