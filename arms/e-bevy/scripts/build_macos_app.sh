#!/usr/bin/env bash
# Package the release build as target/macos/ApexRush.app
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --release --bin racer
APP=target/macos/ApexRush.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp target/release/racer "$APP/Contents/MacOS/racer"
rsync -a --exclude previews --exclude reports --exclude manifest.schema.json assets/ "$APP/Contents/Resources/assets/"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>racer</string>
  <key>CFBundleIdentifier</key><string>com.skelpo.apexrush</string>
  <key>CFBundleName</key><string>Apex Rush</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
codesign --force --sign - "$APP"
echo "built $APP ($(du -sh "$APP" | cut -f1))"
