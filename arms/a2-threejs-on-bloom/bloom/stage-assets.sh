#!/bin/sh
# Stage the web app's files in bloom/assets/apexrush, mirroring the repo layout
# (index.html next to the served asset folder assets/, as Vite serves them). Perry copies ./assets
# next to the binary (and into an .app), where @bloomengine/web finds them.
# Like the Vite build, it leaves out what the game never loads (previews, reports, .ogg).
set -e
cd "$(dirname "$0")"
D=assets/apexrush
rm -rf "$D"
mkdir -p "$D/assets/src"
cp ../index.html "$D/"
# index.html links ./src/style.css: Vite serves the project root and publicDir (assets/) as one site,
# @bloomengine/web serves one folder, so the stylesheet goes where the page's URL resolves it
cp ../src/style.css "$D/assets/src/"
(cd ../assets && tar cf - --exclude previews --exclude reports --exclude '*.ogg' --exclude manifest.schema.json .) | (cd "$D/assets" && tar xf -)
echo "$D: $(du -sh "$D" | cut -f1)"
