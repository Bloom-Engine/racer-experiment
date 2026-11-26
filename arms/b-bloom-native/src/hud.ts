// HUD and screens (2D overlay). All layout scales with screen height (u = sh/720),
// so the same code works with macOS points and iOS pixels (Bloom EN-024).
import { getScreenWidth, getScreenHeight, Font, Texture, Color } from "bloom/core";
import { drawRect, drawRectLines, drawLine, drawCircle } from "bloom/shapes";
import { loadFont, drawTextEx, measureTextEx } from "bloom/text";
import { loadTexture, drawTexturePro } from "bloom/textures";
import { Car } from "./vehicle";
import { Race, Phase } from "./race";
import { controls, touchMode, touchLayout, inRect, Rect } from "./input";
import { MINIMAP_PX_PER_M, MINIMAP_OFFSET_PX, CAR_VARIANT_NAMES } from "./generated/trackData";
import { TOTAL_LAPS, NITRO_MAX } from "./config";

let font: Font = { handle: 0, size: 64 };
let minimap: Texture = { handle: 0, width: 0, height: 0 };
let icoLeft: Texture = { handle: 0, width: 0, height: 0 };
let icoRight: Texture = { handle: 0, width: 0, height: 0 };
let icoBrake: Texture = { handle: 0, width: 0, height: 0 };
let icoNitro: Texture = { handle: 0, width: 0, height: 0 };
let icoPause: Texture = { handle: 0, width: 0, height: 0 };
let icoCamera: Texture = { handle: 0, width: 0, height: 0 };
let icoReset: Texture = { handle: 0, width: 0, height: 0 };

const CAR_COLORS: Color[] = [
  { r: 235, g: 40, b: 40, a: 255 },
  { r: 40, g: 110, b: 255, a: 255 },
  { r: 255, g: 210, b: 30, a: 255 },
  { r: 30, g: 30, b: 34, a: 255 },
];

// Per-frame colours come from a small ring of reused objects: each one is
// consumed by its draw call immediately, and in the browser build Perry's
// wasm runtime never frees an object, so ~50 fresh colours per frame added
// up. Long-lived colours are separate literals.
const COL_RING = 256;
const colRing: Color[] = new Array(COL_RING);
for (let i = 0; i < COL_RING; i++) colRing[i] = { r: 0, g: 0, b: 0, a: 0 };
let colNext = 0;
function col(r: number, g: number, b: number, a: number): Color {
  const c = colRing[colNext];
  colNext = (colNext + 1) % COL_RING;
  c.r = r; c.g = g; c.b = b; c.a = a;
  return c;
}
const WHITE: Color = { r: 255, g: 255, b: 255, a: 255 };
const PANEL: Color = { r: 10, g: 12, b: 20, a: 150 };
const ACCENT: Color = { r: 255, g: 196, b: 0, a: 255 };
const NITRO_COL: Color = { r: 40, g: 200, b: 255, a: 255 };
// scratch for draw calls (same reason)
const textPos = { x: 0, y: 0 };
const srcRect = { x: 0, y: 0, width: 0, height: 0 };
const dstRect = { x: 0, y: 0, width: 0, height: 0 };
const origin0 = { x: 0, y: 0 };

export function initHud(): void {
  font = loadFont("assets/ui/fonts/RussoOne-Regular.ttf", 64);
  minimap = loadTexture("assets/track/minimap_1024.png");
  icoLeft = loadTexture("assets/ui/icons/steer_left_128.png");
  icoRight = loadTexture("assets/ui/icons/steer_right_128.png");
  icoBrake = loadTexture("assets/ui/icons/brake_128.png");
  icoNitro = loadTexture("assets/ui/icons/nitro_128.png");
  icoPause = loadTexture("assets/ui/icons/pause_128.png");
  icoCamera = loadTexture("assets/ui/icons/camera_128.png");
  icoReset = loadTexture("assets/ui/icons/reset_128.png");
}

// ------------------------------------------------------------ helpers
export function text(s: string, x: number, y: number, size: number, c: Color): void {
  textPos.x = x; textPos.y = y;
  drawTextEx(font, s, textPos, size, 1, c);
}
export function textW(s: string, size: number): number {
  return measureTextEx(font, s, size, 1).x;
}
function textC(s: string, cx: number, y: number, size: number, c: Color): void {
  text(s, cx - textW(s, size) / 2, y, size, c);
}
function textShadowC(s: string, cx: number, y: number, size: number, c: Color): void {
  const o = Math.max(2, size * 0.05);
  textC(s, cx + o, y + o, size, col(0, 0, 0, Math.floor(c.a * 0.6)));
  textC(s, cx, y, size, c);
}
function icon(t: Texture, r: Rect, pad: number, a: number): void {
  if (t.handle === 0) return;
  srcRect.x = 0; srcRect.y = 0; srcRect.width = t.width; srcRect.height = t.height;
  dstRect.x = r.x + pad; dstRect.y = r.y + pad; dstRect.width = r.w - pad * 2; dstRect.height = r.h - pad * 2;
  drawTexturePro(t, srcRect, dstRect, origin0, 0, col(255, 255, 255, a));
}

export function formatTime(t: number): string {
  if (t <= 0) return "--:--.---";
  const m = Math.floor(t / 60);
  const s = Math.floor(t - m * 60);
  const ms = Math.floor((t - Math.floor(t)) * 1000);
  let ss = "" + s;
  if (s < 10) ss = "0" + ss;
  let mss = "" + ms;
  if (ms < 10) mss = "00" + mss;
  else if (ms < 100) mss = "0" + mss;
  return m + ":" + ss + "." + mss;
}

function ordinal(n: number): string {
  if (n === 1) return "1ST";
  if (n === 2) return "2ND";
  if (n === 3) return "3RD";
  return n + "TH";
}

export function driverName(c: Car): string {
  if (c.isPlayer) return "YOU";
  return CAR_VARIANT_NAMES[c.index].toUpperCase();
}

/** Button: draws and returns true when tapped/clicked this frame. */
export function button(label: string, cx: number, cy: number, w: number, h: number, highlight: boolean): boolean {
  const r: Rect = { x: cx - w / 2, y: cy - h / 2, w: w, h: h };
  const hit = controls.tapX >= 0 && inRect(r, controls.tapX, controls.tapY);
  drawRect(r.x, r.y, r.w, r.h, highlight ? col(255, 196, 0, 235) : col(20, 24, 36, 220));
  drawRectLines(r.x, r.y, r.w, r.h, 3, highlight ? col(255, 255, 255, 255) : ACCENT);
  const size = h * 0.45;
  textC(label, cx, cy - size * 0.62, size, highlight ? col(20, 20, 20, 255) : WHITE);
  return hit;
}

// ------------------------------------------------------------ banners
let bannerText = "";
let bannerTime = 0;
export function showBanner(s: string, seconds: number): void {
  bannerText = s;
  bannerTime = seconds;
}

// ------------------------------------------------------------ race HUD
export function drawRaceHud(race: Race, dt: number, fps: number, showFps: boolean): void {
  const sw = getScreenWidth(), sh = getScreenHeight();
  const u = sh / 720;
  const p = race.player();

  // ---- top-left: position, lap, times ----
  drawRect(16 * u, 16 * u, 300 * u, 200 * u, PANEL);
  text("POS", 30 * u, 24 * u, 20 * u, col(200, 200, 210, 255));
  text(race.playerPosition + "/" + race.cars.length, 30 * u, 44 * u, 56 * u, ACCENT);
  const lapShown = Math.min(p.lap, TOTAL_LAPS);
  text("LAP", 170 * u, 24 * u, 20 * u, col(200, 200, 210, 255));
  text(lapShown + "/" + TOTAL_LAPS, 170 * u, 44 * u, 56 * u, WHITE);
  let cur = race.raceTime - p.lapStart;
  if (race.phase === Phase.Countdown || race.phase === Phase.Menu) cur = 0;
  if (p.finished) cur = p.lastLapTime;
  text("TIME  " + formatTime(cur), 30 * u, 116 * u, 24 * u, WHITE);
  text("LAST  " + formatTime(p.lastLapTime), 30 * u, 146 * u, 20 * u, col(210, 210, 220, 255));
  let best = race.bestLapEver;
  text("BEST  " + formatTime(best), 30 * u, 176 * u, 20 * u, col(120, 255, 140, 255));

  // ---- minimap ----
  // the track occupies pixels x 55..970, y 298..741 of the 1024 image: crop to it
  const c0 = 35, cy0 = 270, cs = 955, csh = 500;
  const mmW = 270 * u;
  const k = mmW / cs;
  const mmH = csh * k;
  const mmX = sw - mmW - 20 * u;
  let mmY = 20 * u;
  if (touchMode) mmY = 120 * u;
  drawRect(mmX, mmY, mmW, mmH, col(10, 12, 20, 120));
  if (minimap.handle !== 0) {
    srcRect.x = c0; srcRect.y = cy0; srcRect.width = cs; srcRect.height = csh;
    dstRect.x = mmX; dstRect.y = mmY; dstRect.width = mmW; dstRect.height = mmH;
    drawTexturePro(minimap, srcRect, dstRect, origin0, 0, col(255, 255, 255, 230));
  }
  for (let i = race.cars.length - 1; i >= 0; i--) {
    const c = race.cars[i];
    const px = (c.pos.x * MINIMAP_PX_PER_M + MINIMAP_OFFSET_PX[0] - c0) * k + mmX;
    const py = (c.pos.z * MINIMAP_PX_PER_M + MINIMAP_OFFSET_PX[1] - cy0) * k + mmY;
    const r = c.isPlayer ? 7 * u : 5.5 * u;
    drawCircle(px, py, r + 2 * u, c.isPlayer ? WHITE : col(0, 0, 0, 200));
    drawCircle(px, py, r, CAR_COLORS[c.index]);
  }

  // ---- speedometer + nitro (bottom centre) ----
  const cx = sw / 2;
  const by = sh - 150 * u;
  drawRect(cx - 170 * u, by, 340 * u, 132 * u, PANEL);
  const kmh = Math.round(p.kmh());
  let gearS = "" + p.gear;
  if (p.speed < -0.5) gearS = "R";
  textC(gearS, cx - 125 * u, by + 6 * u, 46 * u, ACCENT);
  textC("GEAR", cx - 125 * u, by + 58 * u, 14 * u, col(200, 200, 210, 255));
  textC("" + kmh, cx + 5 * u, by + 4 * u, 72 * u, WHITE);
  textC("KM/H", cx + 122 * u, by + 46 * u, 20 * u, col(200, 200, 210, 255));
  // rpm bar
  const rpmFrac = Math.min(1, p.rpm / 7600);
  drawRect(cx - 150 * u, by + 84 * u, 300 * u, 8 * u, col(255, 255, 255, 40));
  drawRect(cx - 150 * u, by + 84 * u, 300 * u * rpmFrac, 8 * u, rpmFrac > 0.9 ? col(255, 60, 60, 255) : col(230, 230, 240, 230));
  // nitro bar
  const nf = p.nitro / NITRO_MAX;
  drawRect(cx - 150 * u, by + 100 * u, 300 * u, 18 * u, col(255, 255, 255, 40));
  const pulse = p.nitroActive ? 0.75 + 0.25 * Math.sin(race.raceTime * 30) : 1;
  drawRect(cx - 150 * u, by + 100 * u, 300 * u * nf, 18 * u,
    col(Math.floor(NITRO_COL.r * pulse), Math.floor(NITRO_COL.g * pulse), 255, 255));
  drawRectLines(cx - 150 * u, by + 100 * u, 300 * u, 18 * u, 2, nf > 0.99 ? ACCENT : col(255, 255, 255, 120));
  text("NITRO", cx - 146 * u, by + 100 * u, 16 * u, col(10, 10, 20, 220));
  if (p.drifting) textC("DRIFT +NITRO", cx, by - 34 * u, 24 * u, col(255, 210, 60, 255));
  else if (p.draftTimer > 0) textC("SLIPSTREAM +NITRO", cx, by - 34 * u, 24 * u, NITRO_COL);

  // ---- banner ----
  if (bannerTime > 0) {
    bannerTime -= dt;
    const a = Math.floor(255 * Math.min(1, bannerTime * 2));
    textShadowC(bannerText, sw / 2, sh * 0.22, 46 * u, col(255, 220, 60, a));
  }

  if (showFps) text("FPS " + Math.round(fps), 20 * u, sh - 34 * u, 18 * u, col(255, 255, 255, 200));
  if (touchMode) drawTouchControls();
}

function drawTouchControls(): void {
  const L = touchLayout();
  const sh = getScreenHeight();
  const u = sh / 720;
  const items: Rect[] = [L.left, L.right, L.brake, L.nitro];
  const on: boolean[] = [controls.tLeft, controls.tRight, controls.tBrake, controls.tNitro];
  const icons: Texture[] = [icoLeft, icoRight, icoBrake, icoNitro];
  for (let i = 0; i < 4; i++) {
    const r = items[i];
    drawRect(r.x, r.y, r.w, r.h, on[i] ? col(255, 196, 0, 150) : col(0, 0, 0, 90));
    drawRectLines(r.x, r.y, r.w, r.h, 3, col(255, 255, 255, on[i] ? 255 : 140));
    icon(icons[i], r, 26 * u, on[i] ? 255 : 200);
  }
  const small: Rect[] = [L.pause, L.camera, L.reset];
  const sicons: Texture[] = [icoPause, icoCamera, icoReset];
  for (let i = 0; i < 3; i++) {
    const r = small[i];
    drawRect(r.x, r.y, r.w, r.h, col(0, 0, 0, 100));
    icon(sicons[i], r, 16 * u, 220);
  }
}

// ------------------------------------------------------------ effects
let lineSeed = 1;
function rnd(): number {
  lineSeed = (lineSeed * 16807) % 2147483647;
  return (lineSeed - 1) / 2147483646;
}

/** Radial motion lines while boosting / at very high speed. */
export function drawSpeedLines(intensity: number): void {
  if (intensity <= 0.02) return;
  const sw = getScreenWidth(), sh = getScreenHeight();
  const cx = sw / 2, cy = sh * 0.45;
  const n = Math.floor(10 + 30 * intensity);
  const maxR = Math.sqrt(cx * cx + cy * cy) * 1.1;
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2;
    const r0 = maxR * (0.45 + rnd() * 0.35);
    const r1 = r0 + maxR * (0.15 + rnd() * 0.3) * intensity;
    const ca = Math.cos(a), sa = Math.sin(a);
    drawLine(cx + ca * r0, cy + sa * r0, cx + ca * r1, cy + sa * r1, 2 + rnd() * 3,
      col(220, 240, 255, Math.floor(60 + 120 * intensity * rnd())));
  }
  // blue edge tint
  const t = Math.floor(70 * intensity);
  drawRect(0, 0, sw, sh * 0.06, col(40, 160, 255, t));
  drawRect(0, sh * 0.94, sw, sh * 0.06, col(40, 160, 255, t));
}

export function drawImpactFlash(amount: number): void {
  if (amount <= 0.01) return;
  const sw = getScreenWidth(), sh = getScreenHeight();
  drawRect(0, 0, sw, sh, col(255, 255, 255, Math.floor(70 * amount)));
}

// ------------------------------------------------------------ screens
export function drawCountdown(value: number): void {
  const sw = getScreenWidth(), sh = getScreenHeight();
  const u = sh / 720;
  const n = Math.ceil(value);
  let s = "" + n;
  let c = col(255, 70, 50, 255);
  if (n <= 0) { s = "GO!"; c = col(80, 255, 110, 255); }
  if (n > 3) return;
  const frac = value - Math.floor(value);
  const size = (110 + 60 * frac) * u;
  textShadowC(s, sw / 2, sh * 0.32 - size * 0.3, size, c);
}

export const MenuAction = { None: 0, Start: 1, Resume: 2, Restart: 3, Mute: 4 };

export function drawMenu(bestEver: number, muted: boolean): number {
  const sw = getScreenWidth(), sh = getScreenHeight();
  const u = sh / 720;
  drawRect(0, 0, sw, sh, col(5, 8, 18, 120));
  textShadowC("BLOOM RACER", sw / 2, sh * 0.13, 92 * u, ACCENT);
  textC("3 LAPS  -  4 CARS  -  1 CIRCUIT", sw / 2, sh * 0.13 + 110 * u, 24 * u, WHITE);
  let action = MenuAction.None;
  if (button("START", sw / 2, sh * 0.52, 300 * u, 84 * u, true)) action = MenuAction.Start;
  if (controls.confirm) action = MenuAction.Start;
  if (button(muted ? "SOUND: OFF" : "SOUND: ON", sw / 2, sh * 0.52 + 100 * u, 220 * u, 50 * u, false)) action = MenuAction.Mute;
  textC("BEST LAP  " + formatTime(bestEver), sw / 2, sh * 0.52 + 150 * u, 26 * u, col(120, 255, 140, 255));
  if (touchMode) {
    textC("Touch: left/right steer  -  brake  -  nitro  (auto-accelerate)", sw / 2, sh - 70 * u, 20 * u, col(220, 220, 230, 255));
  } else {
    textC("W/Up accelerate  -  S/Down brake  -  A/D steer  -  SPACE handbrake/drift", sw / 2, sh - 90 * u, 20 * u, col(220, 220, 230, 255));
    textC("SHIFT nitro  -  R reset  -  C camera  -  P pause  -  gamepad supported", sw / 2, sh - 60 * u, 20 * u, col(220, 220, 230, 255));
  }
  return action;
}

export function drawPause(): number {
  const sw = getScreenWidth(), sh = getScreenHeight();
  const u = sh / 720;
  drawRect(0, 0, sw, sh, col(0, 0, 0, 150));
  textShadowC("PAUSED", sw / 2, sh * 0.22, 80 * u, WHITE);
  let action = MenuAction.None;
  if (button("RESUME", sw / 2, sh * 0.5, 300 * u, 76 * u, true)) action = MenuAction.Resume;
  if (button("RESTART", sw / 2, sh * 0.5 + 100 * u, 300 * u, 76 * u, false)) action = MenuAction.Restart;
  if (controls.confirm) action = MenuAction.Resume;
  return action;
}

export function drawFinish(race: Race): number {
  const sw = getScreenWidth(), sh = getScreenHeight();
  const u = sh / 720;
  drawRect(0, 0, sw, sh, col(0, 0, 0, 120));
  const p = race.player();
  const pos = race.playerPosition;
  let title = "FINISHED " + ordinal(pos);
  if (pos === 1) title = "YOU WIN!";
  textShadowC(title, sw / 2, 40 * u, 72 * u, pos === 1 ? ACCENT : WHITE);
  const tw = 900 * u;
  const tx = sw / 2 - tw / 2;
  let y = 150 * u;
  drawRect(tx, y - 10 * u, tw, 70 * u + race.cars.length * 56 * u, PANEL);
  const headers: string[] = ["POS", "DRIVER", "TOTAL", "BEST LAP", "LAP 1", "LAP 2", "LAP 3"];
  const colX: number[] = [20, 100, 260, 430, 590, 690, 790];
  for (let i = 0; i < headers.length; i++) text(headers[i], tx + colX[i] * u, y, 20 * u, col(190, 190, 200, 255));
  y += 44 * u;
  const st = race.standings();
  for (let i = 0; i < st.length; i++) {
    const c = st[i];
    const rowCol = c.isPlayer ? ACCENT : WHITE;
    if (c.isPlayer) drawRect(tx + 6 * u, y - 6 * u, tw - 12 * u, 50 * u, col(255, 196, 0, 40));
    text("" + (i + 1), tx + colX[0] * u, y, 30 * u, rowCol);
    drawCircle(tx + colX[1] * u - 18 * u, y + 17 * u, 9 * u, CAR_COLORS[c.index]);
    text(driverName(c), tx + colX[1] * u, y, 30 * u, rowCol);
    let total = "RACING...";
    if (c.finished) total = formatTime(c.finishTime);
    text(total, tx + colX[2] * u, y + 4 * u, 24 * u, rowCol);
    text(formatTime(c.bestLapTime), tx + colX[3] * u, y + 4 * u, 24 * u, rowCol);
    for (let l = 0; l < 3; l++) {
      let s = "-";
      if (l < c.lapTimes.length) s = formatTime(c.lapTimes[l]);
      text(s, tx + colX[4 + l] * u, y + 8 * u, 16 * u, rowCol);
    }
    y += 56 * u;
  }
  if (race.events.newBest || race.bestLapEver === p.bestLapTime) {
    textC("BEST LAP EVER  " + formatTime(race.bestLapEver), sw / 2, y + 10 * u, 24 * u, col(120, 255, 140, 255));
  }
  let action = MenuAction.None;
  if (button("RESTART", sw / 2, sh - 90 * u, 300 * u, 76 * u, true)) action = MenuAction.Restart;
  if (controls.confirm) action = MenuAction.Restart;
  return action;
}
