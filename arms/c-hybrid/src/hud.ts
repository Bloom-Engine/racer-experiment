/**
 * HUD and menus with Bloom 2D (drawRect/drawTextEx/drawTexturePro) over the three.js view.
 * Layout is in screen units derived from the screen height, so it holds in macOS points and
 * iOS pixels alike.
 */
import {
  drawRect, drawRectLines, drawCircle, drawTextEx, measureTextEx, loadFont, loadTexture, drawTexturePro,
  getScreenWidth, getScreenHeight, type Color, type Font, type Texture,
} from "@bloomengine/engine";
import { asset } from "./paths.ts";
import { touchLayout, type Rect, type TouchButton } from "./input.ts";
import type { Track } from "./track.ts";
import type { Racer } from "./race.ts";
import { LAPS } from "./race.ts";

const WHITE: Color = { r: 255, g: 255, b: 255, a: 255 };
const SHADOW: Color = { r: 0, g: 0, b: 0, a: 150 };
const PANEL: Color = { r: 10, g: 14, b: 24, a: 170 };
const ACCENT: Color = { r: 255, g: 70, b: 40, a: 255 };
const NITRO: Color = { r: 70, g: 170, b: 255, a: 255 };
const GOLD: Color = { r: 255, g: 210, b: 60, a: 255 };
const DOTS: Color[] = [
  { r: 230, g: 40, b: 30, a: 255 }, { r: 40, g: 90, b: 230, a: 255 },
  { r: 250, g: 200, b: 20, a: 255 }, { r: 40, g: 40, b: 46, a: 255 },
];

export function formatTime(t: number): string {
  if (!isFinite(t) || t <= 0) return "--:--.---";
  const m = Math.floor(t / 60), s = t - m * 60;
  const ss = Math.floor(s), ms = Math.floor((s - ss) * 1000);
  return `${m}:${ss < 10 ? "0" : ""}${ss}.${ms < 10 ? "00" : ms < 100 ? "0" : ""}${ms}`;
}

export interface HudData {
  speedKmh: number; gear: number; rpm: number;
  player: Racer; racers: Racer[]; carPositions: { x: number; z: number }[];
  lapTime: number; bestLap: number | null;
  nitro: number; nitroActive: boolean; drifting: boolean; drafting: boolean;
  countdown: number | null;     // 3,2,1,0(GO) or null
  message: string; messageAge: number;
  touch: boolean; held: Set<TouchButton>;
  fps: number;
}

export class Hud {
  private font: Font;
  private minimap: Texture;
  private icons: Record<string, Texture> = {};
  showFps = false;

  constructor(private readonly track: Track) {
    this.font = loadFont(asset("ui/fonts/RussoOne-Regular.ttf"), 96);
    this.minimap = loadTexture(asset("track/minimap_1024.png"));
    for (const n of ["nitro", "pause", "camera", "reset", "steer_left", "steer_right", "brake"]) this.icons[n] = loadTexture(asset(`ui/icons/${n}_128.png`));
  }

  private get u(): number { return getScreenHeight() / 720; }

  text(s: string, x: number, y: number, size: number, c: Color = WHITE, align: "left" | "center" | "right" = "left"): void {
    const w = measureTextEx(this.font, s, size, 1).x;
    const ax = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
    const off = Math.max(1, size * 0.05);
    drawTextEx(this.font, s, { x: ax + off, y: y + off }, size, 1, SHADOW);
    drawTextEx(this.font, s, { x: ax, y }, size, 1, c);
  }

  private panel(x: number, y: number, w: number, h: number): void { drawRect(x, y, w, h, PANEL); }

  private icon(name: string, r: Rect, alpha: number): void {
    const t = this.icons[name];
    if (t === undefined) return;
    const s = Math.min(r.w, r.h) * 0.62;
    drawTexturePro(t, { x: 0, y: 0, width: t.width, height: t.height },
      { x: r.x + (r.w - s) / 2, y: r.y + (r.h - s) / 2, width: s, height: s }, { x: 0, y: 0 }, 0, { r: 255, g: 255, b: 255, a: alpha });
  }

  drawRace(d: HudData): void {
    const u = this.u, W = getScreenWidth(), H = getScreenHeight();
    const m = 18 * u;

    // top-left: position, lap, times
    this.panel(m, m, 300 * u, 150 * u);
    this.text(`${d.player.place}`, m + 14 * u, m + 4 * u, 78 * u, GOLD);
    this.text(`/${d.racers.length}`, m + 14 * u + measureTextEx(this.font, `${d.player.place}`, 78 * u, 1).x + 4 * u, m + 38 * u, 36 * u);
    const lap = Math.min(LAPS, d.player.lap);
    this.text(`LAP ${lap}/${LAPS}`, m + 286 * u, m + 12 * u, 30 * u, WHITE, "right");
    this.text(formatTime(d.lapTime), m + 286 * u, m + 48 * u, 28 * u, WHITE, "right");
    this.text("BEST " + formatTime(d.bestLap ?? 0), m + 14 * u, m + 104 * u, 26 * u, { r: 200, g: 220, b: 255, a: 255 });

    // bottom-right (desktop) / bottom-centre (touch): speed, gear, nitro
    const cx = d.touch ? W / 2 : W - m - 170 * u;
    const by = H - m - 150 * u;
    this.panel(cx - 170 * u, by, 340 * u, 150 * u);
    this.text(`${Math.round(d.speedKmh)}`, cx + 20 * u, by + 2 * u, 84 * u, WHITE, "right");
    this.text("KM/H", cx + 28 * u, by + 48 * u, 26 * u, { r: 190, g: 190, b: 200, a: 255 });
    this.text(d.gear === 0 ? "R" : `${d.gear}`, cx + 158 * u, by + 10 * u, 60 * u, ACCENT, "right");
    // rpm strip
    const rpmFrac = Math.max(0, Math.min(1, (d.rpm - 1000) / 5000));
    drawRect(cx - 150 * u, by + 96 * u, 300 * u * rpmFrac, 6 * u, rpmFrac > 0.85 ? ACCENT : { r: 230, g: 230, b: 230, a: 220 });
    // nitro bar
    const nx = cx - 150 * u, ny = by + 112 * u, nw = 300 * u, nh = 22 * u;
    drawRect(nx, ny, nw, nh, { r: 20, g: 30, b: 50, a: 220 });
    const pulse = d.nitroActive ? 0.75 + 0.25 * Math.sin(Date.now() / 50) : 1;
    drawRect(nx, ny, nw * d.nitro, nh, { r: Math.round(NITRO.r * pulse), g: Math.round(NITRO.g * pulse), b: 255, a: 255 });
    drawRectLines(nx, ny, nw, nh, 2 * u, d.nitro >= 0.999 ? GOLD : { r: 120, g: 160, b: 220, a: 255 });
    this.text(d.drifting ? "DRIFT +" : d.drafting ? "DRAFT +" : "NITRO", nx + 8 * u, ny + 1 * u, 18 * u, WHITE);

    this.drawMinimap(d, W - m - 210 * u, d.touch ? 125 * u : m, d.touch ? 210 * u : 230 * u);

    // countdown / GO
    if (d.countdown !== null) {
      const label = d.countdown > 0 ? `${d.countdown}` : "GO!";
      this.text(label, W / 2, H * 0.28, 170 * u, d.countdown > 0 ? WHITE : { r: 90, g: 255, b: 120, a: 255 }, "center");
    }
    if (d.message !== "" && d.messageAge < 2.2) {
      const a = Math.round(255 * Math.min(1, (2.2 - d.messageAge) * 2));
      this.text(d.message, W / 2, H * 0.2, 46 * u, { r: 255, g: 230, b: 120, a }, "center");
    }
    if (d.touch) this.drawTouch(d.held);
    if (this.showFps) this.text(`${Math.round(d.fps)} fps`, m, H - 40 * u, 22 * u);
  }

  private drawMinimap(d: HudData, x: number, y: number, size: number): void {
    this.panel(x, y, size, size);
    const pad = size * 0.04, inner = size - pad * 2;
    const t = this.minimap;
    drawTexturePro(t, { x: 0, y: 0, width: t.width, height: t.height }, { x: x + pad, y: y + pad, width: inner, height: inner }, { x: 0, y: 0 }, 0, WHITE);
    const k = inner / (this.track.manifest.track.minimap.image_size_px[0] ?? 1024);
    // opponents first, the player on top
    for (let i = d.carPositions.length - 1; i >= 0; i--) {
      const p = d.carPositions[i]!;
      const mp = this.track.toMap(p.x, p.z);
      const r = (i === 0 ? 7 : 5.5) * this.u;
      drawCircle(x + pad + mp.u * k, y + pad + mp.v * k, r + 1.5 * this.u, WHITE);
      drawCircle(x + pad + mp.u * k, y + pad + mp.v * k, r, DOTS[i] ?? WHITE);
    }
  }

  private drawTouch(held: Set<TouchButton>): void {
    const L = touchLayout();
    const icon: Record<TouchButton, string> = { left: "steer_left", right: "steer_right", brake: "brake", nitro: "nitro", drift: "", pause: "pause", camera: "camera", reset: "reset" };
    for (const k of Object.keys(L) as TouchButton[]) {
      const r = L[k];
      const on = held.has(k);
      drawRect(r.x, r.y, r.w, r.h, on ? { r: 255, g: 255, b: 255, a: 110 } : { r: 0, g: 0, b: 0, a: 90 });
      drawRectLines(r.x, r.y, r.w, r.h, 2 * this.u, { r: 255, g: 255, b: 255, a: 160 });
      if (icon[k] !== "") this.icon(icon[k], r, on ? 255 : 210);
      else this.text("DRIFT", r.x + r.w / 2, r.y + r.h / 2 - 14 * this.u, 26 * this.u, WHITE, "center");
    }
  }

  // ------------------------------------------------------------- screens

  /** A button: drawn, and its rect returned for hit testing. */
  button(label: string, cx: number, cy: number, w: number, h: number, primary: boolean): Rect {
    const r = { x: cx - w / 2, y: cy - h / 2, w, h };
    drawRect(r.x, r.y, r.w, r.h, primary ? ACCENT : { r: 40, g: 50, b: 70, a: 235 });
    drawRectLines(r.x, r.y, r.w, r.h, 2 * this.u, WHITE);
    this.text(label, cx, cy - h * 0.3, h * 0.55, WHITE, "center");
    return r;
  }

  drawStart(best: number | null, touch: boolean): Rect {
    const u = this.u, W = getScreenWidth(), H = getScreenHeight();
    drawRect(0, 0, W, H, { r: 5, g: 8, b: 16, a: 120 });
    this.text("ARCADE RACER", W / 2, H * 0.14, 96 * u, WHITE, "center");
    this.text("3 LAPS  ·  4 CARS", W / 2, H * 0.30, 32 * u, GOLD, "center");
    const r = this.button("START", W / 2, H * 0.48, 320 * u, 90 * u, true);
    this.text("BEST LAP  " + formatTime(best ?? 0), W / 2, H * 0.60, 30 * u, WHITE, "center");
    const help = touch
      ? ["Auto throttle · arrows steer · BRAKE · NITRO · DRIFT", "Fill nitro by drifting and drafting behind cars"]
      : ["Arrows/WASD drive · SPACE drift · SHIFT nitro", "R reset · C camera · P pause · fill nitro by drifting and drafting"];
    this.text(help[0]!, W / 2, H * 0.72, 24 * u, { r: 220, g: 225, b: 235, a: 255 }, "center");
    this.text(help[1]!, W / 2, H * 0.77, 24 * u, { r: 220, g: 225, b: 235, a: 255 }, "center");
    return r;
  }

  drawPause(): { resume: Rect; restart: Rect } {
    const u = this.u, W = getScreenWidth(), H = getScreenHeight();
    drawRect(0, 0, W, H, { r: 0, g: 0, b: 0, a: 150 });
    this.text("PAUSED", W / 2, H * 0.22, 90 * u, WHITE, "center");
    const resume = this.button("RESUME", W / 2, H * 0.48, 320 * u, 80 * u, true);
    const restart = this.button("RESTART", W / 2, H * 0.62, 320 * u, 80 * u, false);
    return { resume, restart };
  }

  drawFinish(racers: Racer[], playerBest: number | null, newRecord: boolean): Rect {
    const u = this.u, W = getScreenWidth(), H = getScreenHeight();
    drawRect(0, 0, W, H, { r: 0, g: 0, b: 0, a: 160 });
    const player = racers.find((r) => r.isPlayer);
    const won = player !== undefined && player.finishPlace === 1;
    this.text(won ? "YOU WIN!" : "FINISH", W / 2, H * 0.07, 84 * u, won ? GOLD : WHITE, "center");
    const order = [...racers].sort((a, b) => (a.finished ? a.finishPlace : 99 + a.place) - (b.finished ? b.finishPlace : 99 + b.place));
    const tw = 900 * u, x0 = W / 2 - tw / 2;
    let y = H * 0.24;
    this.panel(x0, y - 10 * u, tw, (order.length + 1) * 52 * u + 20 * u);
    const cols = [x0 + 20 * u, x0 + 90 * u, x0 + 330 * u, x0 + 520 * u, x0 + 700 * u];
    this.text("POS", cols[0]!, y, 24 * u, GOLD); this.text("DRIVER", cols[1]!, y, 24 * u, GOLD);
    this.text("TOTAL", cols[2]!, y, 24 * u, GOLD); this.text("BEST LAP", cols[3]!, y, 24 * u, GOLD); this.text("LAPS", cols[4]!, y, 24 * u, GOLD);
    y += 52 * u;
    for (let i = 0; i < order.length; i++) {
      const r = order[i]!;
      const c = r.isPlayer ? { r: 255, g: 120, b: 100, a: 255 } : WHITE;
      this.text(`${i + 1}`, cols[0]!, y, 30 * u, c);
      this.text(r.name, cols[1]!, y, 30 * u, c);
      this.text(r.finished ? formatTime(r.finishTime) : "DNF", cols[2]!, y, 30 * u, c);
      this.text(formatTime(r.bestLap), cols[3]!, y, 30 * u, c);
      this.text(r.lapTimes.map((t) => formatTime(t)).join("  "), cols[4]!, y + 6 * u, 16 * u, c);
      y += 52 * u;
    }
    this.text((newRecord ? "NEW RECORD!  " : "BEST LAP EVER  ") + formatTime(playerBest ?? 0), W / 2, y + 20 * u, 30 * u, newRecord ? GOLD : WHITE, "center");
    return this.button("RESTART", W / 2, H * 0.86, 320 * u, 80 * u, true);
  }
}
