/**
 * Settings for Apex Rush on Bloom, set before @bloomengine/web installs the
 * browser (this module imports nothing that starts it).
 */
import { configure } from "@bloomengine/web/config";
import { isMobile } from "@bloomengine/engine/core";

// Frame rate (PORT_LOG.md, "frame rate"): the page is restyled every 2nd frame (the HUD updates at
// 30 Hz; every frame still draws). Phones also get Bloom's Low preset instead of Medium and a HUD
// without the decoration @bloomengine/web draws as thousands of rects (rounded corners, gradients,
// blurred shadows). APEX_FULL=1 turns all of it off; each variable can also be set on its own.
const env = process.env as Record<string, string | undefined>;
if (env["APEX_FULL"] !== "1") {
  if (env["APEX_PAGE_EVERY"] === undefined) env["APEX_PAGE_EVERY"] = "2";
  if (isMobile()) {
    if (env["BLOOM_QUALITY"] === undefined) env["BLOOM_QUALITY"] = "low";
    if (env["APEX_FLAT_HUD"] === undefined) env["APEX_FLAT_HUD"] = "1";
  }
}

const size = (name: string, fallback: number): number => Number(process.env[name] ?? "") || fallback;
configure({
  app: "apexrush",
  title: "Apex Rush",
  width: size("BLOOM_WIDTH", 1280),
  height: size("BLOOM_HEIGHT", 720),
  root: new URL("./assets/apexrush/", import.meta.url).pathname,   // the staged site (stage-assets.sh)
  bundle: "apexrush",                                 // assets/apexrush/ in an app bundle (stage-assets.sh)
  served: "assets/",                                  // Vite's publicDir is the site root
  canvas: "#game",
  storageName: "storage.json",
  // the game loads its font with the FontFace API, which isn't there: name the file instead
  fonts: { "Russo One": "assets/ui/fonts/RussoOne-Regular.ttf" },
});
