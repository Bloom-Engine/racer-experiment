#!/usr/bin/env node
// Stage the site @bloomengine/web serves, as Vite's dev server and build would serve it:
//   bloom/assets/folio/            <- static/ (Vite's publicDir: the site root)
//   bloom/assets/folio/index.html  <- sources/index.html (Vite's root)
//   bloom/assets/folio/style/index.styl  <- the Stylus sheets compiled to CSS (Vite compiles them on the fly;
//                                           the page's <link href="./style/index.styl"> is kept as is)
// and two asset steps the browser does at run time with WASM in a worker, which Perry can't run:
//   - Draco-compressed .glb files are decoded once here (gltf-transform + draco3dgltf)
//   - nothing KTX2/Basis: VITE_COMPRESSED is off, so the PNG and plain .glb variants are used
// Incremental: a file is copied or converted again only when its source is newer.
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import stylus from "stylus";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const out = join(here, "assets", "folio");
const skip = (rel) =>
  /-compressed\.glb$/.test(rel) || /\.ktx$/.test(rel) || /^(basis|draco|favicons|social)\//.test(rel) ||
  /\.(md|blend|psd|wav\.asd)$/.test(rel) || rel.endsWith(".DS_Store");

const newer = (src, dst) => !existsSync(dst) || statSync(src).mtimeMs > statSync(dst).mtimeMs;

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "draco3d.decoder": await draco3d.createDecoderModule() });

function isDraco(file) {
  const b = readFileSync(file);
  const len = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + len).toString());
  return (json.extensionsUsed ?? []).includes("KHR_draco_mesh_compression");
}

let copied = 0, decoded = 0;
const static_ = join(repo, "static");
for (const src of walk(static_)) {
  const rel = relative(static_, src);
  if (skip(rel)) continue;
  const dst = join(out, rel);
  if (!newer(src, dst)) continue;
  mkdirSync(dirname(dst), { recursive: true });
  if (rel.endsWith(".glb") && isDraco(src)) {
    const doc = await io.read(src);
    for (const ext of doc.getRoot().listExtensionsUsed()) if (ext.extensionName === "KHR_draco_mesh_compression") ext.dispose();
    await io.write(dst, doc);
    decoded++;
  } else { copyFileSync(src, dst); copied++; }
}

// the ground's colours, baked from the terrain data the floor shader reads (bake-terrain.mjs, folio.ts)
{
  const src = join(static_, "terrain", "terrain.png"), dst = join(out, "terrain", "terrainColor.png");
  if (newer(src, dst) || newer(join(here, "bake-terrain.mjs"), dst)) {
    const { execFileSync } = await import("node:child_process");
    execFileSync(process.execPath, [join(here, "bake-terrain.mjs"), src, dst], { stdio: "inherit" });
  }
}

// the page
copyFileSync(join(repo, "sources", "index.html"), join(out, "index.html"));

// the stylesheet: index.styl only @imports the others (passed through as CSS @import by Stylus, inlined by Vite)
const styleDir = join(repo, "sources", "style");
const index = readFileSync(join(styleDir, "index.styl"), "utf8");
let css = "";
const rest = index.replace(/^\s*@import url\('\.\/([^']+)'\)\s*$/gm, (_m, file) => {
  css += stylus(readFileSync(join(styleDir, file), "utf8")).set("filename", join(styleDir, file)).render() + "\n";
  return "";
});
css += stylus(rest).set("filename", join(styleDir, "index.styl")).render();
mkdirSync(join(out, "style"), { recursive: true });
writeFileSync(join(out, "style", "index.styl"), css);

console.log(`${out}: ${copied} copied, ${decoded} Draco models decoded, ${css.length} bytes of CSS`);

// The game's JavaScript, with `import.meta.env.VITE_*` replaced by their values as `vite build` does
// (Perry has no import.meta.env, and its --define takes identifiers only). Values come from .env, or
// from .env.example when there is none (the README's setup step), into bloom/.build/sources.
const envFile = existsSync(join(repo, ".env")) ? join(repo, ".env") : join(repo, ".env.example");
const env = {};
for (const line of readFileSync(envFile, "utf8").split("\n")) {
  const m = /^\s*(VITE_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
}
const sources = join(repo, "sources"), built = join(here, ".build", "sources");
let rewritten = 0;
for (const src of walk(sources)) {
  const rel = relative(sources, src);
  if (!rel.endsWith(".js")) continue;
  const dst = join(built, rel);
  mkdirSync(dirname(dst), { recursive: true });
  const code = readFileSync(src, "utf8");
  const next = code.replace(/import\.meta\.env\.(VITE_[A-Z0-9_]+)/g, (_m, key) => {
    rewritten++;
    // Vite: a set variable is its string; an empty or missing one is "" / undefined
    return key in env ? JSON.stringify(env[key]) : "undefined";
  });
  if (!existsSync(dst) || readFileSync(dst, "utf8") !== next) writeFileSync(dst, next);
}
console.log(`${built}: import.meta.env from ${relative(repo, envFile)}, ${rewritten} uses replaced`);

// GSAP's ticker is an immediately invoked function expression that keeps `Date.now` in a local
// (`var _getTime = Date.now, _startTime = _getTime()`). Perry miscompiles calls to a builtin held in
// an IIFE's local ("TypeError: value is not a function", PORT_LOG.md): a copy of GSAP's ES modules
// with that one alias wrapped in a plain function, which build.sh maps `gsap` to.
const gsapSrc = join(repo, "node_modules", "gsap"), gsapOut = join(here, ".build", "gsap");
mkdirSync(gsapOut, { recursive: true });
let patched = 0;
for (const e of readdirSync(gsapSrc)) {
  if (!e.endsWith(".js")) continue;
  let code = readFileSync(join(gsapSrc, e), "utf8");
  if (e === "gsap-core.js") {
    const before = code;
    code = code.replace("var _getTime = Date.now,", "var _getTime = function () { return Date.now(); },");
    if (code !== before) patched++;
  }
  const dst = join(gsapOut, e);
  if (!existsSync(dst) || readFileSync(dst, "utf8") !== code) writeFileSync(dst, code);
}
if (patched !== 1) throw new Error("stage.mjs: GSAP's ticker alias wasn't found (GSAP version changed?)");
console.log(`${gsapOut}: GSAP with the ticker's Date.now alias wrapped`);

// three.js's TSL builds constant values with `new Color( ...params )` (and Vector2/3/4, Matrix2/3/4).
// Perry miscompiles `new ImportedClass(...array)`: the array arrives as the first argument, so every
// color('#383039') is white and vec3(1, 2, 3) is NaN (PORT_LOG.md). Copies of three.tsl.js and
// three.webgpu.js (which imports it) with those calls as Reflect.construct; their other imports point
// back at the real three.core.js, so there is still one three.js. build.sh maps three/tsl and the
// WebGPU build to them.
{
  const build = join(repo, "node_modules", "three", "build"), dst = join(here, ".build", "three");
  mkdirSync(dst, { recursive: true });
  const core = JSON.stringify(join(build, "three.core.js").replace(/\\/g, "/")).slice(1, -1);
  let tsl = readFileSync(join(build, "three.tsl.js"), "utf8");
  let fixed = 0;
  tsl = tsl.replace(/new (Color|Vector2|Vector3|Vector4|Matrix2|Matrix3|Matrix4)\( \.\.\.params \)/g, (_m, cls) => { fixed++; return `Reflect.construct( ${cls}, params )`; });
  if (fixed !== 7) throw new Error(`stage.mjs: expected 7 spread constructions in three.tsl.js, found ${fixed} (three.js version changed?)`);
  tsl = tsl.replaceAll("from './three.core.js'", `from '${core}'`);
  let gpu = readFileSync(join(build, "three.webgpu.js"), "utf8");
  gpu = gpu.replaceAll("from './three.core.js'", `from '${core}'`);   // ./three.tsl.js: the copy next to it
  for (const [name, code] of [["three.tsl.js", tsl], ["three.webgpu.js", gpu]]) {
    const file = join(dst, name);
    if (!existsSync(file) || readFileSync(file, "utf8") !== code) writeFileSync(file, code);
  }
  console.log(`${dst}: three.tsl.js with ${fixed} spread constructions as Reflect.construct, three.webgpu.js on it`);
}

// Howler's spatial plugin (its second IIFE) reads Howl, HowlerGlobal and Sound as globals the first
// IIFE publishes (`global.Howl = Howl`). In Perry's CommonJS module those free names resolve to the
// module's exports in their TDZ: "ReferenceError: Cannot access 'Howl' before initialization"
// (PORT_LOG.md). The copy reads them from globalThis explicitly.
{
  const src = readFileSync(join(repo, "node_modules", "howler", "dist", "howler.js"), "utf8");
  const marker = "\n(function() {\n\n  'use strict';\n\n  // Setup default properties.\n  HowlerGlobal.prototype._pos";
  if (!src.includes(marker)) throw new Error("stage.mjs: Howler's spatial plugin wasn't found (Howler version changed?)");
  const code = src.replace(marker, marker.replace("(function() {\n", "(function() {\n  var HowlerGlobal = globalThis.HowlerGlobal, Howler = globalThis.Howler, Howl = globalThis.Howl, Sound = globalThis.Sound;\n"));
  const dst = join(here, ".build", "howler", "howler.js");
  mkdirSync(dirname(dst), { recursive: true });
  if (!existsSync(dst) || readFileSync(dst, "utf8") !== code) writeFileSync(dst, code);
  console.log(`${dst}: Howler with its spatial plugin's globals bound`);
}
