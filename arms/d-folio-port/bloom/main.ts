/**
 * folio-2025, natively on Bloom. Settings, then a browser over Bloom (@bloomengine/web),
 * the adapters, then the game's own entry (../sources/index.js), unchanged.
 */
import "./config.ts";
import "@bloomengine/web";
import "./shims.ts";
import "./folio.ts";   // game-specific adapters (shader effects Bloom draws differently)
import "./probe.ts";   // BLOOM_SCRIPT diagnostics
import "./.build/sources/index.js";   // ../sources with import.meta.env substituted (stage.mjs)
