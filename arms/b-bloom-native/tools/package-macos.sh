#!/bin/sh
# Build a proper macOS .app bundle (Perry only bundles perry/ui apps).
#   tools/package-macos.sh  ->  dist/macos/Bloom Racer.app
set -e
cd "$(dirname "$0")/.."
OUT="dist/macos/Bloom Racer.app"
rm -rf dist/macos && mkdir -p dist/macos
perry compile src/main.ts -o dist/macos/BloomRacer 2>&1 | grep -E "Wrote|error" | grep -v "ld: warning" || true
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
mv dist/macos/BloomRacer "$OUT/Contents/MacOS/BloomRacer"
cp -R assets resources "$OUT/Contents/Resources/"
rm -rf dist/macos/assets dist/macos/resources
cat > "$OUT/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Bloom Racer</string>
  <key>CFBundleDisplayName</key><string>Bloom Racer</string>
  <key>CFBundleIdentifier</key><string>com.skelpo.bloomracer</string>
  <key>CFBundleExecutable</key><string>BloomRacer</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.games</string>
  <key>GCSupportsControllerUserInteraction</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
xattr -cr "$OUT"
codesign --force --sign - "$OUT" >/dev/null 2>&1 || true   # ad-hoc signature for local runs
echo "built: $OUT ($(du -sh "$OUT" | cut -f1))"
