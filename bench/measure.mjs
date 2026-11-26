#!/usr/bin/env node
// Measures every finished build of the racer the same way:
//   size    : executable, macOS .app, iOS .app, web dist (and its gzip'd JS)
//   startup : launch -> start screen ready (median of N launches; run 1 reported separately as "cold")
//   idle    : RSS / phys_footprint while sitting on the start screen (20 s, after the screen is ready + 5 s)
//   race    : max RSS / peak phys_footprint over a full 3-lap autopilot race
//
//   node bench/measure.mjs                    # all targets, everything
//   node bench/measure.mjs --only B,E --runs 3 --skip race
//
// Run it on an idle machine (no builds or other agents running): startup times are CPU-bound.
// Native games open real windows; keep the display awake and the windows visible (macOS throttles
// occluded windows). Results go to bench/results/<timestamp>/ (results.json, results.md, logs/).
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const arg = (name, def) => { const i = process.argv.indexOf("--" + name); return i > 0 ? process.argv[i + 1] : def; };
const RUNS = Number(arg("runs", "5"));
const ONLY = arg("only", "A1,A2,B,E").split(",");
const SKIP = arg("skip", "").split(",");
const RACE_CAP_S = Number(arg("race-cap", "300"));
const IDLE_S = 20;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = path.join(ROOT, "bench", "results", STAMP);
const LOGS = path.join(OUT, "logs");
fs.mkdirSync(LOGS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

// ------------------------------------------------------------------ targets
const A2 = path.join(ROOT, "race-A2-run1/bloom/dist");
const T = {
  A1: {
    name: "A1 Three.js (web, Chrome)", kind: "web", dir: path.join(ROOT, "race-A1-run1"),
    sizes: { "web dist": path.join(ROOT, "race-A1-run1/dist") },
  },
  A2: {
    name: "A2 Three.js → Perry/Bloom bridge", kind: "native",
    exe: path.join(A2, "macos/Apex Rush.app/Contents/MacOS/apexrush"),
    sizes: { exe: path.join(A2, "macos/Apex Rush.app/Contents/MacOS/apexrush"), "macOS .app": path.join(A2, "macos/Apex Rush.app"), "iOS .app": path.join(A2, "ios/apexrush.app") },
    // @bloomengine/web's BLOOM_SCRIPT: "click" logs "ok" only once the element is shown, i.e. the start screen is up.
    // #start-best is a text span on the start screen, so clicking it does nothing.
    idle: { env: { BLOOM_SCRIPT: clicks("#start-best") } },
    ready: /click #start-best ok/,
    race: { env: { BLOOM_QUERY: "?autopilot", BLOOM_SCRIPT: clicks("#btn-start") } },
    raceReady: /click #btn-start ok/,
  },
  B: {
    name: "B Bloom native (TS, Perry)", kind: "native",
    exe: path.join(ROOT, "B_bloom/dist/macos/Bloom Racer.app/Contents/MacOS/BloomRacer"),
    sizes: { exe: path.join(ROOT, "B_bloom/dist/macos/Bloom Racer.app/Contents/MacOS/BloomRacer"), "macOS .app": path.join(ROOT, "B_bloom/dist/macos/Bloom Racer.app"), "iOS .app": path.join(ROOT, "B_bloom/dist/ios/BloomRacer.app") },
    idle: { args: [] }, ready: /best lap on record at startup/,   // printed after all loading, right before the first frame
    race: { args: ["--autopilot", "--autostart"] },                // quits by itself after the finish
  },
  E: {
    name: "E Bevy (Rust)", kind: "native",
    exe: path.join(ROOT, "E_bevy/target/macos/ApexRush.app/Contents/MacOS/racer"),
    sizes: { exe: path.join(ROOT, "E_bevy/target/macos/ApexRush.app/Contents/MacOS/racer"), "macOS .app": path.join(ROOT, "E_bevy/target/macos/ApexRush.app"), "iOS .app": path.join(ROOT, "E_bevy/target/ios/device/ApexRush.app") },
    idle: { env: {} }, ready: /track ready/,                       // Loading -> Menu transition
    race: { env: { RACER_AUTOSTART: "1", RACER_AUTOPILOT: "1", RACER_QUIT_AFTER_FINISH: "1" } },
  },
};
function clicks(sel) { const s = []; for (let f = 2; f <= 3600; f += 2) s.push(`${f} click ${sel}`); return s.join("; "); }

// ------------------------------------------------------------------ memory sampling
function processTable() {
  const out = execFileSync("ps", ["-Ao", "pid=,ppid=,rss="], { encoding: "utf8" });
  return out.trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
}
function tree(root) {
  const rows = processTable(); const pids = new Set([root]); let grew = true;
  while (grew) { grew = false; for (const [p, pp] of rows) if (pids.has(pp) && !pids.has(p)) { pids.add(p); grew = true; } }
  let rss = 0; for (const [p, , r] of rows) if (pids.has(p)) rss += r;
  return { pids: [...pids], rssKB: rss };
}
function footprint(pids) {  // phys_footprint and its peak, summed over the processes (bytes)
  let cur = 0, peak = 0;
  for (const pid of pids) {
    try {
      const o = execFileSync("footprint", ["-p", String(pid), "--noCategories", "-f", "bytes"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      cur += Number(/phys_footprint:\s+(\d+)/.exec(o)?.[1] ?? 0); peak += Number(/phys_footprint_peak:\s+(\d+)/.exec(o)?.[1] ?? 0);
    } catch { /* process gone */ }
  }
  return { cur, peak };
}
class Sampler {
  constructor(root) { this.root = root; this.samples = []; this.maxKB = 0; this.fp = { cur: 0, peak: 0 }; }
  start(ms = 250) { this.timer = setInterval(() => this.tick(), ms); }
  tick() { const t = tree(this.root); if (t.rssKB === 0) return; this.pids = t.pids; this.samples.push({ t: now(), kb: t.rssKB }); this.maxKB = Math.max(this.maxKB, t.rssKB); }
  snapFootprint() { if (this.pids) { const f = footprint(this.pids); if (f.peak > 0) this.fp = f; } }
  stop() { clearInterval(this.timer); }
  medianSince(t0) { const v = this.samples.filter((s) => s.t >= t0).map((s) => s.kb).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : 0; }
}

// ------------------------------------------------------------------ native runs
function launchNative(t, mode, logName) {
  const cfg = t[mode] ?? {};
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "racer-home-"));   // keeps best-lap saves out of the real profile
  const env = { ...process.env, HOME: home, RACER_SAVE_DIR: home, ...(cfg.env ?? {}) };
  const t0 = now();
  const p = spawn(t.exe, cfg.args ?? [], { env, cwd: path.dirname(t.exe), stdio: ["ignore", "pipe", "pipe"] });
  const log = fs.createWriteStream(path.join(LOGS, logName));
  const waiters = [];
  const onData = (buf) => {
    const text = buf.toString(); log.write(text.replace(/^(?=.)/gm, `[${((now() - t0) / 1000).toFixed(3)}] `));
    for (const w of [...waiters]) if (w.re.test(text)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(now() - t0); }
  };
  p.stdout.on("data", onData); p.stderr.on("data", onData);
  const exited = new Promise((r) => p.on("exit", (code) => { log.end(); r(code); }));
  const waitFor = (re, ms) => new Promise((resolve, reject) => {
    waiters.push({ re, resolve });
    setTimeout(() => reject(new Error(`timeout waiting for ${re}`)), ms);
    exited.then(() => reject(new Error(`exited before ${re}`)));
  });
  return { p, t0, waitFor, exited, kill: async () => { p.kill("SIGTERM"); await Promise.race([exited, sleep(3000)]); p.kill("SIGKILL"); await exited; } };
}

async function nativeStartup(key, t) {
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const r = launchNative(t, "idle", `${key}-startup-${i + 1}.log`);
    try { times.push(await r.waitFor(t.ready, 120000)); } catch (e) { times.push(null); console.log(`  ${key} startup ${i + 1}: ${e.message}`); }
    await r.kill(); await sleep(1500);
  }
  return times;
}
async function nativeIdle(key, t) {
  const r = launchNative(t, "idle", `${key}-idle.log`);
  const s = new Sampler(r.p.pid); s.start();
  await r.waitFor(t.ready, 120000); await sleep(5000);
  const from = now(); await sleep(IDLE_S * 1000); s.snapFootprint(); s.stop();
  const res = { idleRssMB: s.medianSince(from) / 1024, idleFootprintMB: s.fp.cur / 2 ** 20 };
  await r.kill(); return res;
}
async function nativeRace(key, t) {
  const r = launchNative(t, "race", `${key}-race.log`);
  const s = new Sampler(r.p.pid); s.start();
  const fpTimer = setInterval(() => s.snapFootprint(), 5000);   // peak is tracked by the kernel; snapshot before exit
  if (t.raceReady) await r.waitFor(t.raceReady, 120000);
  const t0 = now();
  const done = await Promise.race([r.exited.then(() => "exited"), sleep(RACE_CAP_S * 1000).then(() => "cap")]);
  clearInterval(fpTimer); s.stop();
  if (done === "cap") { s.snapFootprint(); await r.kill(); }
  return { maxRssMB: s.maxKB / 1024, peakFootprintMB: s.fp.peak / 2 ** 20, raceSeconds: (now() - t0) / 1000, ended: done };
}

// ------------------------------------------------------------------ web (A1) runs
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let server;
async function startServer(t) {
  if (server) return;
  server = spawn(path.join(t.dir, "node_modules/.bin/vite"), ["preview", "--port", "4199", "--strictPort"], { cwd: t.dir, stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { await fetch("http://localhost:4199/"); return; } catch { await sleep(200); } }
  throw new Error("vite preview did not start");
}
async function launchChrome(t) {
  const require = createRequire(path.join(t.dir, "package.json"));
  const { chromium } = require("playwright");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "racer-chrome-"));
  const port = 9300 + Math.floor(Math.random() * 500);
  const t0 = now();
  const p = spawn(CHROME, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required", "--window-size=1280,800", "about:blank"], { stdio: "ignore" });
  let browser;
  for (let i = 0; i < 150 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(100); } }
  if (!browser) throw new Error("chrome did not start");
  const page = browser.contexts()[0].pages()[0] ?? await browser.contexts()[0].newPage();
  const kill = async () => { await browser.close().catch(() => {}); p.kill("SIGTERM"); await sleep(1500); p.kill("SIGKILL"); };
  return { p, t0, browser, page, kill };
}
const URL_ = (q) => `http://localhost:4199/?debug${q}`;
const gameReady = (page) => page.waitForFunction(() => window.__game !== undefined, null, { timeout: 120000 });

async function webStartup(key, t) {
  await startServer(t);
  const cold = [], page = [];
  for (let i = 0; i < RUNS; i++) {
    const c = await launchChrome(t);
    const g = now(); await c.page.goto(URL_("")); await gameReady(c.page);
    cold.push(now() - c.t0); page.push(now() - g);
    await c.kill(); await sleep(1500);
  }
  return { cold, page };
}
async function webIdle(key, t) {
  await startServer(t);
  const c = await launchChrome(t); const s = new Sampler(c.p.pid); s.start();
  await c.page.goto(URL_("")); await gameReady(c.page); await sleep(5000);
  const from = now(); await sleep(IDLE_S * 1000); s.snapFootprint(); s.stop();
  const res = { idleRssMB: s.medianSince(from) / 1024, idleFootprintMB: s.fp.cur / 2 ** 20 };
  await c.kill(); return res;
}
async function webRace(key, t) {
  await startServer(t);
  const c = await launchChrome(t); const s = new Sampler(c.p.pid); s.start();
  const fpTimer = setInterval(() => s.snapFootprint(), 5000);
  await c.page.goto(URL_("&autopilot")); await gameReady(c.page);
  await c.page.click("#btn-start"); const t0 = now(); let ended = "cap";
  while (now() - t0 < RACE_CAP_S * 1000) {
    await sleep(1000);
    if (await c.page.evaluate(() => window.__game.player.progress.finished)) { ended = "finished"; break; }
  }
  clearInterval(fpTimer); s.snapFootprint(); s.stop();
  const res = { maxRssMB: s.maxKB / 1024, peakFootprintMB: s.fp.peak / 2 ** 20, raceSeconds: (now() - t0) / 1000, ended };
  await c.kill(); return res;
}

// ------------------------------------------------------------------ sizes
function duBytes(p) { if (!fs.existsSync(p)) return null; return Number(execFileSync("du", ["-sk", p], { encoding: "utf8" }).split("\t")[0]) * 1024; }
function gzipJs(dir) {
  let raw = 0, gz = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.(js|css|html)$/.test(e.name)) { const b = fs.readFileSync(f); raw += b.length; gz += zlib.gzipSync(b, { level: 9 }).length; } } };
  walk(dir); return { raw, gz };
}

// ------------------------------------------------------------------ main
const median = (a) => { const v = a.filter((x) => x != null).sort((x, y) => x - y); return v.length ? v[v.length >> 1] : null; };
const results = { stamp: STAMP, host: { cpu: os.cpus()[0].model, cores: os.cpus().length, memGB: Math.round(os.totalmem() / 2 ** 30), load: os.loadavg() }, runs: RUNS, targets: {} };
if (os.loadavg()[0] > os.cpus().length) console.log(`WARNING: load average ${os.loadavg()[0].toFixed(0)} on ${os.cpus().length} cores; startup times will be inflated.`);

for (const key of ONLY) {
  const t = T[key]; if (!t) { console.log("unknown target " + key); continue; }
  const r = { name: t.name, sizes: {} };
  for (const [k, p] of Object.entries(t.sizes)) r.sizes[k] = duBytes(p);
  if (t.kind === "web" && fs.existsSync(t.sizes["web dist"])) r.sizes["web code (js/css/html) gzip"] = gzipJs(t.sizes["web dist"]).gz;
  console.log(`== ${t.name}`);
  try {
    if (!SKIP.includes("startup")) {
      if (t.kind === "web") { const s = await webStartup(key, t); r.startupColdMs = s.cold; r.startupPageMs = s.page; }
      else r.startupMs = await nativeStartup(key, t);
      console.log("  startup", JSON.stringify(r.startupMs ?? r.startupColdMs));
    }
    if (!SKIP.includes("idle")) { Object.assign(r, t.kind === "web" ? await webIdle(key, t) : await nativeIdle(key, t)); console.log(`  idle ${r.idleRssMB?.toFixed(0)} MB RSS`); }
    if (!SKIP.includes("race")) { Object.assign(r, t.kind === "web" ? await webRace(key, t) : await nativeRace(key, t)); console.log(`  race max ${r.maxRssMB?.toFixed(0)} MB RSS (${r.ended}, ${r.raceSeconds?.toFixed(0)} s)`); }
  } catch (e) { r.error = String(e); console.log("  ERROR", e.message); }
  results.targets[key] = r;
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 1));
}
server?.kill();

// markdown summary
const mb = (b) => (b == null ? "–" : (b / 2 ** 20).toFixed(1) + " MB");
const ms = (v) => (v == null ? "–" : (v / 1000).toFixed(2) + " s");
const f0 = (v) => (v == null || v === 0 ? "–" : v.toFixed(0) + " MB");
let md = `# Racer measurements ${STAMP}\n\nHost: ${results.host.cpu}, ${results.host.cores} cores, ${results.host.memGB} GB; load at start ${results.host.load.map((x) => x.toFixed(1)).join(" / ")}. Startup = median of ${RUNS} launches (run 1 = cold cache). Memory: RSS summed over the process tree (Chrome: all its processes); footprint = macOS phys_footprint (includes GPU/IOSurface memory).\n\n`;
md += "| | exe | macOS .app | iOS .app | web | startup (median) | startup run 1 | idle RSS | idle footprint | max RSS (race) | peak footprint (race) | race |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n";
for (const [k, r] of Object.entries(results.targets)) {
  const st = r.startupMs ?? r.startupColdMs ?? [];
  const web = r.sizes["web dist"] != null ? `${mb(r.sizes["web dist"])} (code ${mb(r.sizes["web code (js/css/html) gzip"])} gz)` : "–";
  const warm = (a) => median(a.length > 1 ? a.slice(1) : a);   // run 1 is the cold-cache launch, reported on its own
  const startup = r.startupPageMs ? `${ms(warm(st))} (page only ${ms(warm(r.startupPageMs))})` : ms(warm(st));
  md += `| ${r.name} | ${mb(r.sizes.exe)} | ${mb(r.sizes["macOS .app"])} | ${mb(r.sizes["iOS .app"])} | ${web} | ${startup} | ${ms(st[0])} | ${f0(r.idleRssMB)} | ${f0(r.idleFootprintMB)} | ${f0(r.maxRssMB)} | ${f0(r.peakFootprintMB)} | ${r.ended ?? "–"} ${r.raceSeconds ? r.raceSeconds.toFixed(0) + " s" : ""} |\n`;
}
md += "\nStartup markers: A1 `window.__game` exists (assets loaded, game built); A2 the start screen is shown (BLOOM_SCRIPT click on `#start-best` succeeds); B the log line printed after all loading, before the first frame; E `track ready` (Loading → Menu).\n";
fs.writeFileSync(path.join(OUT, "results.md"), md);
console.log("\n" + md + `\n→ ${OUT}`);
process.exit(0);
