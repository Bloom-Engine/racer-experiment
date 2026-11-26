/**
 * Apex Rush, natively on Bloom. Sets the app's settings, installs a browser
 * over Bloom (@bloomengine/web), then runs the game's own entry. `three` is
 * the real three.js with a Bloom renderer (mapped at compile time by bloom-three).
 */
import "./config.ts";
import "@bloomengine/web";
import "./shims.ts";
import "../src/main.ts";
