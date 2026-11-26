#!/usr/bin/env node
// Browser CPU + RAM comparison: Three.js build (race-A1-run1/dist) vs Bloom + WASM build (B_bloom/dist/web).
//
//   node bench/web-compare.mjs                      # 5 interleaved rounds, all phases (~45 min)
//   node bench/web-compare.mjs --runs 3 --skip race # quick: load + idle only
//   node bench/web-compare.mjs --smoke              # 1 round, 30 s race cap, no idle wait: checks the harness works
//
// Each run = a fresh, headed Google Chrome with a fresh profile, served by the same static server.
//   load : navigate -> game ready                      (wall time, CPU-seconds)
//   idle : start screen, 20 s window after 5 s settle  (CPU %, fps, phys_footprint)
//   race : full 3-lap autopilot race                   (CPU %, CPU ms/frame, fps, frame-time p99, phys_footprint)
// "blank" (about:blank in the same Chrome setup) is measured in the idle phase as the browser's own baseline.
//
// CPU = CPU time summed over Chrome's whole process tree (browser + renderer + GPU + utility), from `ps`,
//       100 % = one core. Split into page (renderer), gpu, browser+other.
// RAM = macOS phys_footprint per process (what Activity Monitor calls "Memory"; includes GPU/IOSurface
//       allocations and the WASM heap; does not double-count shared pages like RSS does), summed.
// FPS = timestamps of the page's requestAnimationFrame callbacks (both games drive their loop with rAF).
//
// Reliability: runs are interleaved (A B / B A / ...), every run first waits until the machine is idle
// (`top` idle >= --min-idle %), and results are medians with min–max. Runs that started on a busy machine are
// flagged. Close other apps, stop builds, keep the Chrome window visible and the laptop on power.
import { spawn, execFile, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const argv = process.argv.slice(2);
const flag = (n) => argv.includes("--" + n);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const SMOKE = flag("smoke");
const RUNS = Number(opt("runs", SMOKE ? "1" : "5"));
const SKIP = opt("skip", "").split(",");
const RACE_CAP_S = Number(opt("race-cap", SMOKE ? "30" : "300"));
const MIN_IDLE = Number(opt("min-idle", SMOKE ? "0" : "85"));     // % system CPU idle required before a run
const WAIT_IDLE_S = Number(opt("wait-idle", "900"));
const DPR = opt("dpr", "1");                                      // forced device scale factor (same pixels for both)
const W = 1280, H = 800;
const SETTLE_S = 5, IDLE_S = SMOKE ? 8 : 20;
const CHROME = opt("chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = path.join(ROOT, "bench", "results", "web-" + STAMP + (SMOKE ? "-smoke" : ""));
fs.mkdirSync(path.join(OUT, "logs"), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

// ------------------------------------------------------------------ targets
const T = {
  threejs: {
    name: "Three.js (WebGL)", root: path.join(ROOT, "race-A1-run1/dist"), port: 4301,
    idleQuery: "?debug", raceQuery: "?debug&autopilot",
    ready: (page) => page.waitForFunction(() => window.__game !== undefined, null, { timeout: 180000, polling: 100 }),
    startRace: (page) => page.click("#btn-start"),
    finished: async (page) => page.evaluate(() => !!window.__game?.player?.progress?.finished),
    // sanity check: the game's own clock must have advanced with the wall clock (it pauses when the tab is hidden)
    check: async (page, wall) => { const s = await page.evaluate(() => window.__game.debugState());
      return { state: s.state, gameSeconds: s.raceTime, ok: s.state === "finished" || s.raceTime > wall * 0.8 }; },
  },
  bloom: {
    name: "Bloom + WASM (WebGPU)", root: path.join(ROOT, "B_bloom/dist/web"), port: 4302,
    idleQuery: "", raceQuery: "?autopilot&autostart",
    readyLine: /best lap on record at startup/,   // printed after all loading; with ?autostart the race starts right after
    finishLine: /PLAYER FINISHED/,
    check: async (page, wall, lines) => { const l = lines.filter((x) => /^t=\d+ /.test(x)).pop() ?? ""; const g = Number(/^t=(\d+)/.exec(l)?.[1] ?? 0);
      const fin = lines.some((x) => /PLAYER FINISHED/.test(x)); return { state: fin ? "finished" : "racing", gameSeconds: g, ok: fin || g > wall * 0.8 - 5 }; },
  },
};
const ORDER = opt("only", "threejs,bloom").split(",");

// ------------------------------------------------------------------ static server (same for both)
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm",
  ".json": "application/json", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".ktx2": "image/ktx2", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".bin": "application/octet-stream",
  ".ogg": "audio/ogg", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".svg": "image/svg+xml", ".hdr": "application/octet-stream" };
function serve(root, port) {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const f = path.join(root, path.normalize(p));
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": MIME[path.extname(f).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}

// ------------------------------------------------------------------ system state
async function systemIdlePct() {   // second sample of `top` = usage over the last ~1 s
  const { stdout } = await run("top", ["-l", "2", "-n", "0", "-s", "1"]);
  const m = [...stdout.matchAll(/CPU usage:.*?([\d.]+)% idle/g)];
  return m.length ? Number(m[m.length - 1][1]) : 0;
}
async function waitForQuietMachine() {
  const t0 = now(); let idle = await systemIdlePct();
  while (idle < MIN_IDLE && now() - t0 < WAIT_IDLE_S * 1000) {
    log(`  waiting for an idle machine: ${idle.toFixed(0)} % idle (< ${MIN_IDLE} %), load ${os.loadavg()[0].toFixed(1)}`);
    await sleep(15000); idle = await systemIdlePct();
  }
  return { idlePct: idle, load1: os.loadavg()[0], busy: idle < MIN_IDLE };
}

// ------------------------------------------------------------------ chrome process tree: CPU + footprint
const cpuSec = (s) => s.split(":").reduce((acc, x) => acc * 60 + Number(x), 0);   // "M:SS.ss" or "H:MM:SS.ss"
function chromeProcs(rootPid) {
  const out = execFileSync("ps", ["-Ao", "pid=,ppid=,time=,args="], { encoding: "utf8", maxBuffer: 64 << 20 });
  const rows = out.trim().split("\n").map((l) => { const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l); return m && { pid: +m[1], ppid: +m[2], cpu: cpuSec(m[3]), args: m[4] }; }).filter(Boolean);
  const pids = new Set([rootPid]); let grew = true;
  while (grew) { grew = false; for (const r of rows) if (pids.has(r.ppid) && !pids.has(r.pid)) { pids.add(r.pid); grew = true; } }
  const procs = new Map();
  for (const r of rows) if (pids.has(r.pid)) {
    const type = /--type=renderer/.test(r.args) ? (/--extension-process/.test(r.args) ? "other" : "page")
      : /--type=gpu-process/.test(r.args) ? "gpu" : /--type=/.test(r.args) ? "other" : "browser";
    procs.set(r.pid, { pid: r.pid, cpu: r.cpu, type });
  }
  return procs;
}
function cpuDelta(a, b) {   // CPU-seconds per group between two snapshots (processes born in between count from 0)
  const g = { page: 0, gpu: 0, browser: 0, other: 0 };
  for (const [pid, p] of b) g[p.type] += Math.max(0, p.cpu - (a.get(pid)?.cpu ?? 0));
  g.total = g.page + g.gpu + g.browser + g.other; return g;
}
async function footprintOf(procs) {
  const g = { page: 0, gpu: 0, browser: 0, other: 0, pagePeak: 0 };
  await Promise.all([...procs.values()].map(async (p) => {
    try {
      const { stdout } = await run("footprint", ["-p", String(p.pid), "--noCategories", "-f", "bytes"]);
      g[p.type] += Number(/phys_footprint:\s+(\d+)/.exec(stdout)?.[1] ?? 0);
      if (p.type === "page") g.pagePeak = Math.max(g.pagePeak, Number(/phys_footprint_peak:\s+(\d+)/.exec(stdout)?.[1] ?? 0));
    } catch { /* process exited */ }
  }));
  g.total = g.page + g.gpu + g.browser + g.other; return g;
}
class MemSampler {   // footprint every 2 s (the `footprint` calls run outside Chrome, so they do not count as its CPU)
  constructor(rootPid) { this.rootPid = rootPid; this.samples = []; }
  start() { const loop = async () => { while (!this.stopped) { this.samples.push(await footprintOf(chromeProcs(this.rootPid))); await sleep(2000); } }; this.done = loop(); }
  async stop() { this.stopped = true; await this.done; }
  summary() {
    const s = this.samples; if (!s.length) return null; const pick = (k) => s.map((x) => x[k]);
    return { totalMedianMB: med(pick("total")) / MB, totalMaxMB: Math.max(...pick("total")) / MB, pageMedianMB: med(pick("page")) / MB,
      gpuMedianMB: med(pick("gpu")) / MB, browserOtherMedianMB: med(s.map((x) => x.browser + x.other)) / MB,
      pagePeakMB: Math.max(...pick("pagePeak")) / MB, totalLastMB: s[s.length - 1].total / MB, samples: s.length };
  }
}
const MB = 2 ** 20;
const med = (a) => { const v = a.filter((x) => x != null && !Number.isNaN(x)).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };

// ------------------------------------------------------------------ chrome
const require = createRequire(path.join(ROOT, "race-A1-run1/package.json"));
const { chromium } = require("playwright");
// Counts the page's frames: wraps rAF and records each distinct callback timestamp.
const FRAME_PROBE = `(() => {
  const raf = window.requestAnimationFrame.bind(window); let last = -1;
  const b = window.__bench = { ts: [], hidden: 0, mark() { this.ts = []; this.hidden = 0; } };
  document.addEventListener('visibilitychange', () => { if (document.hidden) b.hidden++; });
  window.requestAnimationFrame = (cb) => raf((t) => { if (t !== last) { last = t; b.ts.push(t); } return cb(t); });
})();`;
async function launchChrome(tag) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "racer-webbench-"));
  const port = 9400 + Math.floor(Math.random() * 500);
  const p = spawn(CHROME, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-component-update", "--disable-sync", "--disable-background-networking", "--metrics-recording-only",
    "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows", `--force-device-scale-factor=${DPR}`, `--window-size=${W},${H}`, "--window-position=0,0",
    "about:blank"], { stdio: "ignore" });
  let browser;
  for (let i = 0; i < 200 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(100); } }
  if (!browser) throw new Error("chrome did not start");
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.addInitScript(FRAME_PROBE);
  const consoleLog = fs.createWriteStream(path.join(OUT, "logs", tag + ".log"));
  const lines = []; const waiters = [];
  page.on("console", (m) => { const t = m.text(); lines.push(t); consoleLog.write(t + "\n"); for (const w of [...waiters]) if (w.re.test(t)) { waiters.splice(waiters.indexOf(w), 1); w.res(); } });
  page.on("pageerror", (e) => consoleLog.write("PAGEERROR " + e.message + "\n"));
  const waitLine = (re, ms) => lines.some((l) => re.test(l)) ? Promise.resolve() : new Promise((res, rej) => { waiters.push({ re, res }); setTimeout(() => rej(new Error("timeout waiting for " + re)), ms); });
  const kill = async () => { consoleLog.end(); await browser.close().catch(() => {}); p.kill("SIGTERM"); await sleep(1500); p.kill("SIGKILL"); fs.rmSync(profile, { recursive: true, force: true }); };
  await sleep(2000);   // let Chrome's own startup work finish before any measurement window opens
  return { pid: p.pid, page, lines, waitLine, kill };
}
async function frameStats(page) {
  const ts = await page.evaluate(() => window.__bench?.ts ?? []);
  if (ts.length < 3) return { frames: ts.length, fps: 0 };
  const d = []; for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1]); d.sort((a, b) => a - b);
  const q = (p) => d[Math.min(d.length - 1, Math.floor(p * d.length))];
  return { frames: ts.length, fps: (ts.length - 1) / ((ts[ts.length - 1] - ts[0]) / 1000), p50ms: q(0.5), p95ms: q(0.95), p99ms: q(0.99), maxMs: d[d.length - 1], over25ms: d.filter((x) => x > 25).length };
}
async function gpuInfo(page) {
  return page.evaluate(async () => {
    const r = { webgpu: !!navigator.gpu };
    try { const a = await navigator.gpu?.requestAdapter(); r.webgpuAdapter = a ? (a.info?.vendor + " " + a.info?.architecture) : null; } catch {}
    try { const gl = document.createElement("canvas").getContext("webgl2"); const e = gl.getExtension("WEBGL_debug_renderer_info"); r.webgl = gl.getParameter(e.UNMASKED_RENDERER_WEBGL); } catch {}
    return r;
  });
}
const url = (t, q) => `http://127.0.0.1:${t.port}/${q}`;
async function waitReady(t, c) { if (t.ready) await t.ready(c.page); else await c.waitLine(t.readyLine, 180000); }

// ------------------------------------------------------------------ phases
async function idleRun(key, round) {
  const t = T[key]; const c = await launchChrome(`${key}-idle-${round}`);
  try {
    const r = {};
    if (key !== "blank") {
      const p0 = chromeProcs(c.pid), t0 = now();
      await c.page.goto(url(t, t.idleQuery)); await waitReady(t, c);
      r.loadMs = now() - t0; r.loadCpuSec = cpuDelta(p0, chromeProcs(c.pid)).total;
      r.gpu = await gpuInfo(c.page);
    }
    await sleep(SETTLE_S * 1000);
    const m = new MemSampler(c.pid); m.start();
    await c.page.evaluate(() => window.__bench?.mark());
    const p1 = chromeProcs(c.pid), t1 = now();
    await sleep(IDLE_S * 1000);
    const cpu = cpuDelta(p1, chromeProcs(c.pid)), wall = (now() - t1) / 1000;
    await m.stop();
    Object.assign(r, { idle: { cpuPct: pct(cpu, wall), mem: m.summary(), frames: key === "blank" ? null : await frameStats(c.page) } });
    return r;
  } finally { await c.kill(); }
}
async function raceRun(key, round) {
  const t = T[key]; const c = await launchChrome(`${key}-race-${round}`);
  try {
    await c.page.goto(url(t, t.raceQuery)); await waitReady(t, c);
    if (t.startRace) await t.startRace(c.page);
    await c.page.evaluate(() => window.__bench?.mark());
    const m = new MemSampler(c.pid); m.start();
    const p0 = chromeProcs(c.pid), t0 = now();
    let ended = "cap"; let finishedLine = false;
    if (t.finishLine) c.waitLine(t.finishLine, RACE_CAP_S * 1000).then(() => { finishedLine = true; }, () => {});
    while (now() - t0 < RACE_CAP_S * 1000) {
      await sleep(500);
      if (t.finished ? await t.finished(c.page) : finishedLine) { ended = "finished"; break; }
    }
    const cpu = cpuDelta(p0, chromeProcs(c.pid)), wall = (now() - t0) / 1000;
    await m.stop();
    const frames = await frameStats(c.page);
    const check = { ...(await t.check(c.page, wall, c.lines)), hiddenEvents: await c.page.evaluate(() => window.__bench.hidden) };
    await c.page.screenshot({ path: path.join(OUT, "logs", `${key}-race-${round}.png`) }).catch(() => {});
    if (!check.ok || check.hiddenEvents) throw new Error("race did not run normally: " + JSON.stringify(check));
    return { race: { check, ended, seconds: wall, cpuPct: pct(cpu, wall), cpuMsPerFrame: frames.frames > 1 ? (cpu.total * 1000) / frames.frames : null,
      pageCpuMsPerFrame: frames.frames > 1 ? (cpu.page * 1000) / frames.frames : null, mem: m.summary(), frames } };
  } finally { await c.kill(); }
}
const pct = (cpu, wall) => Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, (v / wall) * 100]));

// ------------------------------------------------------------------ main
for (const k of ORDER) if (!fs.existsSync(path.join(T[k].root, "index.html"))) { console.error(`missing build: ${T[k].root}`); process.exit(1); }
const servers = await Promise.all(ORDER.map((k) => serve(T[k].root, T[k].port)));
T.blank = { name: "Chrome, about:blank (baseline)" };
const host = { cpu: os.cpus()[0].model, cores: os.cpus().length, memGB: Math.round(os.totalmem() / 2 ** 30), os: os.release(),
  chrome: execFileSync(CHROME, ["--version"], { encoding: "utf8" }).trim(), dpr: DPR, window: `${W}x${H}` };
const results = { stamp: STAMP, smoke: SMOKE, host, runs: [], summary: {} };
const save = () => fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 1));
log(`${host.chrome} on ${host.cpu}; ${RUNS} round(s); results -> ${OUT}`);

for (let round = 1; round <= RUNS; round++) {
  const order = round % 2 ? ORDER : [...ORDER].reverse();   // A B, B A, ... cancels drift (thermals, background work)
  const jobs = [];
  if (!SKIP.includes("idle")) { jobs.push(["blank", "idle"]); for (const k of order) jobs.push([k, "idle"]); }
  if (!SKIP.includes("race")) for (const k of order) jobs.push([k, "race"]);
  for (const [key, phase] of jobs) {
    const sys = await waitForQuietMachine();
    log(`round ${round}: ${key} ${phase} (system ${sys.idlePct.toFixed(0)} % idle${sys.busy ? ", BUSY — flagged" : ""})`);
    const entry = { round, key, phase, system: sys };
    for (let attempt = 1; attempt <= 2; attempt++) {   // one retry: a hidden/occluded window pauses the Three.js game
      try { Object.assign(entry, phase === "idle" ? await idleRun(key, round) : await raceRun(key, round)); delete entry.error; break; }
      catch (e) { entry.error = String(e.message ?? e); entry.attempts = attempt; log(`  ERROR (attempt ${attempt}) ` + entry.error); }
    }
    entry.systemAfterIdlePct = await systemIdlePct();
    if (entry.idle) log(`  idle: CPU ${entry.idle.cpuPct.total.toFixed(1)} %, ${entry.idle.frames?.fps?.toFixed(0) ?? "-"} fps, ${entry.idle.mem?.totalMedianMB.toFixed(0)} MB` + (entry.loadMs ? `; load ${(entry.loadMs / 1000).toFixed(2)} s` : ""));
    if (entry.race) log(`  race: ${entry.race.ended} ${entry.race.seconds.toFixed(0)} s, CPU ${entry.race.cpuPct.total.toFixed(1)} %, ${entry.race.cpuMsPerFrame?.toFixed(2)} ms/frame, ${entry.race.frames.fps?.toFixed(0)} fps, ${entry.race.mem?.totalMedianMB.toFixed(0)} MB (max ${entry.race.mem?.totalMaxMB.toFixed(0)})`);
    results.runs.push(entry); save();
    await sleep(3000);
  }
}
servers.forEach((s) => s.close());

// ------------------------------------------------------------------ summary
const get = (o, p) => p.split(".").reduce((x, k) => x?.[k], o);
const METRICS = [
  ["Load time (s)", "loadMs", (v) => v / 1000, 2], ["Load CPU (CPU-s)", "loadCpuSec", (v) => v, 2],
  ["Idle CPU total (% of 1 core)", "idle.cpuPct.total", (v) => v, 1], ["Idle CPU page", "idle.cpuPct.page", (v) => v, 1], ["Idle CPU GPU proc", "idle.cpuPct.gpu", (v) => v, 1],
  ["Idle fps", "idle.frames.fps", (v) => v, 0], ["Idle RAM total (MB)", "idle.mem.totalMedianMB", (v) => v, 0], ["Idle RAM page (MB)", "idle.mem.pageMedianMB", (v) => v, 0],
  ["Idle RAM GPU proc (MB)", "idle.mem.gpuMedianMB", (v) => v, 0],
  ["Race CPU total (% of 1 core)", "race.cpuPct.total", (v) => v, 1], ["Race CPU page", "race.cpuPct.page", (v) => v, 1], ["Race CPU GPU proc", "race.cpuPct.gpu", (v) => v, 1],
  ["Race CPU per frame (ms, all procs)", "race.cpuMsPerFrame", (v) => v, 2], ["Race CPU per frame (ms, page only)", "race.pageCpuMsPerFrame", (v) => v, 2],
  ["Race fps", "race.frames.fps", (v) => v, 1], ["Race frame time p99 (ms)", "race.frames.p99ms", (v) => v, 1], ["Race frames > 25 ms", "race.frames.over25ms", (v) => v, 0],
  ["Race RAM total median (MB)", "race.mem.totalMedianMB", (v) => v, 0], ["Race RAM total max (MB)", "race.mem.totalMaxMB", (v) => v, 0],
  ["Race RAM page median (MB)", "race.mem.pageMedianMB", (v) => v, 0], ["Race RAM GPU proc median (MB)", "race.mem.gpuMedianMB", (v) => v, 0],
  ["Race RAM page peak (MB)", "race.mem.pagePeakMB", (v) => v, 0],
];
const cell = (vals, d) => { const v = vals.filter((x) => x != null); if (!v.length) return "–"; const m = med(v); return v.length > 1 ? `**${m.toFixed(d)}** (${Math.min(...v).toFixed(d)}–${Math.max(...v).toFixed(d)})` : m.toFixed(d); };
const cols = ["blank", ...ORDER];
let md = `# Browser comparison: Three.js vs Bloom + WASM — ${STAMP}${SMOKE ? " (SMOKE TEST, not a measurement)" : ""}\n\n`;
md += `${host.chrome}, ${host.cpu} (${host.cores} cores, ${host.memGB} GB), macOS ${host.os}. Window ${host.window}, DPR forced to ${DPR}. `;
md += `${RUNS} interleaved round(s); cells are **median** (min–max). CPU: % of one core, summed over Chrome's whole process tree. RAM: macOS phys_footprint, summed.\n\n`;
md += `| Metric | ${cols.map((k) => T[k].name).join(" | ")} |\n|---|${cols.map(() => "---").join("|")}|\n`;
for (const [label, p, f, d] of METRICS) {
  const row = cols.map((k) => cell(results.runs.filter((r) => r.key === k).map((r) => {
    const v = get(r, p); return v == null ? null : f(v);
  }), d));
  if (row.every((c) => c === "–")) continue;
  md += `| ${label} | ${row.join(" | ")} |\n`;
}
const flagged = results.runs.filter((r) => r.system.busy || r.systemAfterIdlePct < MIN_IDLE - 15);
const errors = results.runs.filter((r) => r.error);
const gpus = results.runs.filter((r) => r.gpu).map((r) => `${r.key}: WebGPU ${r.gpu.webgpu ? r.gpu.webgpuAdapter : "unavailable"}, WebGL "${r.gpu.webgl}"`);
md += `\nGPU: ${[...new Set(gpus)].join("; ") || "–"}\n`;
md += `\nRace ends: ${results.runs.filter((r) => r.race).map((r) => `${r.key}#${r.round} ${r.race.ended} ${r.race.seconds.toFixed(0)}s`).join(", ") || "–"}\n`;
if (flagged.length) md += `\n⚠️ ${flagged.length} run(s) ran on a busy machine: ${flagged.map((r) => `${r.key} ${r.phase} #${r.round} (${r.system.idlePct.toFixed(0)}% idle before, ${r.systemAfterIdlePct.toFixed(0)}% after)`).join(", ")}\n`;
if (errors.length) md += `\n❌ errors: ${errors.map((r) => `${r.key} ${r.phase} #${r.round}: ${r.error}`).join("; ")}\n`;
md += `\nNotes: the two builds do not render identical content (Bloom has no tyre smoke/skid marks; renderers and post-effects differ), so this compares the two *apps as built*, not the engines in isolation. If fps differs between the two, compare "CPU per frame" rather than CPU %. Logs: logs/.\n`;
fs.writeFileSync(path.join(OUT, "results.md"), md);
console.log("\n" + md + `\n→ ${OUT}`);
process.exit(0);
