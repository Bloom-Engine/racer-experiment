/**
 * Small adapters for what @bloomengine/web doesn't provide yet (see ../PORT_LOG.md).
 * Imported after @bloomengine/web, before the game.
 */
import { Canvas2D, dom, document, onBeforeFrame, viewCanvas } from "@bloomengine/web";
import { AudioParam } from "@bloomengine/web/audio";

type Img = { src: string };
type CanvasEl = { width: number; height: number; clientWidth: number; isConnected: boolean; parentNode: unknown; style: Record<string, string>; __crop?: Crop };
interface Crop { src: string; sx: number; sy: number; sw: number; sh: number }

// ---------------------------------------------------------------- drawImage
// CanvasRenderingContext2D.drawImage is missing from Canvas2D. The game's only use is the
// minimap: drawImage(img, sx, sy, sw, sh, 0, 0, w, h) crops the track image into an offscreen
// canvas. Remember the crop on that canvas (the page minimap below shows it); draw nothing.
const proto = Canvas2D.prototype as unknown as Record<string, unknown>;
if (typeof proto["drawImage"] !== "function") {
  proto["drawImage"] = function (this: { canvas: CanvasEl }, image: Img, sx: number, sy: number, sw?: number, sh?: number): void {
    if (typeof image.src === "string" && sw !== undefined && sh !== undefined) this.canvas.__crop = { src: image.src, sx, sy, sw, sh };
  };
}

// ---------------------------------------------------------------- page canvases
// @bloomengine/web paints only the 3D view's <canvas>: a 2D canvas in the page (the minimap) is laid
// out but never drawn, and rasterizing it in TypeScript costs ~6 ms a frame for nothing. So a 2D
// canvas that is in the page gets a context that replays the minimap's drawing as DOM, which the
// page engine does draw: the cropped track image as an <img>, each car as a round <div>.
class PageCanvasContext {
  fillStyle = "#000";
  strokeStyle = "#000";
  lineWidth = 1;
  private readonly box: dom.HTMLElement;
  private readonly img: dom.HTMLElement;
  private readonly dots: dom.HTMLElement[] = [];
  private used = 0;
  private x = 0;
  private y = 0;
  private turned = false;
  private crop: Crop | null = null;

  constructor(readonly canvas: CanvasEl) {
    const box = document.createElement("div") as dom.HTMLElement;
    box.className = (canvas as unknown as { className: string }).className;
    box.id = "native-" + ((canvas as unknown as { id: string }).id || "canvas");
    // the canvas's own box (size, border, background) stays: the DOM goes on top of it, with
    // #minimap's corner radius (style.css)
    box.setAttribute("style", "position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden;border-radius:14px;pointer-events:none");
    const img = document.createElement("img") as dom.HTMLElement;
    img.setAttribute("style", "position:absolute;left:0;top:0;max-width:none");
    box.appendChild(img);
    // the canvas is a replaced element: wrap it so the overlay can sit on it
    const wrap = document.createElement("div") as dom.HTMLElement;
    wrap.setAttribute("style", "position:relative;display:block;flex:none");
    const parent = canvas.parentNode as dom.Node;
    parent.insertBefore(wrap, canvas as unknown as dom.Node);
    wrap.appendChild(canvas as unknown as dom.Node);
    wrap.appendChild(box);
    this.box = box;
    this.img = img;
  }

  /** CSS px per canvas px. */
  private scale(): number { return (this.canvas.clientWidth || 150) / Math.max(1, this.canvas.width); }

  clearRect(): void { this.used = 0; }
  drawImage(source: CanvasEl): void {
    const crop = source.__crop;
    if (crop === undefined || crop === this.crop) return;
    this.crop = crop;
    const k = (this.canvas.clientWidth || 150) / crop.sw;
    this.img.setAttribute("src", crop.src);
    this.img.style["width"] = `${Math.round(1024 * k)}px`;
    this.img.style["left"] = `${(-crop.sx * k).toFixed(1)}px`;
    this.img.style["top"] = `${(-crop.sy * k).toFixed(1)}px`;
  }
  save(): void { this.turned = false; }
  translate(x: number, y: number): void { this.x = x; this.y = y; }
  rotate(): void { this.turned = true; }
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
  arc(): void {}
  fill(): void {}
  stroke(): void {
    // one car: a dot at the translation, the player's (rotated, white outline) bigger
    let d = this.dots[this.used];
    if (d === undefined) {
      d = document.createElement("div") as dom.HTMLElement;
      this.box.appendChild(d);
      this.dots.push(d);
    }
    this.used++;
    const k = this.scale();
    const r = this.turned ? 6 : 4.5;
    const css = `position:absolute;left:0;top:0;width:${r * 2}px;height:${r * 2}px;border-radius:50% !important;box-sizing:border-box;` +
      `background:${String(this.fillStyle)};border:${this.turned ? 2 : 1.5}px solid ${this.turned ? "#fff" : "rgba(10,12,18,0.9)"};` +
      `transform:translate(${(this.x * k - r).toFixed(1)}px,${(this.y * k - r).toFixed(1)}px)`;
    if (d.getAttribute("style") !== css) d.setAttribute("style", css);
  }
  restore(): void {}
}

const canvasProto = dom.HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
const getContext = canvasProto["getContext"] as (this: CanvasEl, kind: string, options?: unknown) => unknown;
const pageContexts = new Map<CanvasEl, PageCanvasContext>();
canvasProto["getContext"] = function (this: CanvasEl, kind: string, options?: unknown): unknown {
  if (kind === "2d" && process.env["APEX_NO_MAP"] !== "1" && this.isConnected && (this as unknown) !== viewCanvas()) {
    let c = pageContexts.get(this);
    if (c === undefined) { c = new PageCanvasContext(this); pageContexts.set(this, c); }
    return c;
  }
  return getContext.call(this, kind, options);
};

// ---------------------------------------------------------------- AudioParam history
// AudioParam keeps every automation event forever and evaluates the whole list on each frame. The
// game calls setTargetAtTime ~20 times a frame (engine layers, AI voices, wind), so the audio update
// grows by ~1.3 ms per 1000 frames until the race crawls. A browser forgets events in the past: when a
// set/target event starts now (or earlier), fold everything before it into the base value.
type Param = { _events: { time: number }[]; _base: number; _valueAt(t: number): number; ctx: { currentTime: number } };
const paramProto = AudioParam.prototype as unknown as Record<string, unknown>;
for (const name of ["setTargetAtTime", "setValueAtTime"]) {
  const original = paramProto[name] as (this: Param, value: number, time: number, tc?: number) => unknown;
  paramProto[name] = function (this: Param, value: number, time: number, tc?: number): unknown {
    if (this._events.length > 8 && time <= this.ctx.currentTime) {
      const v = this._valueAt(time);
      this._events = this._events.filter((e) => e.time > time);
      this._base = v;
    }
    return original.call(this, value, time, tc);
  };
}

// ---------------------------------------------------------------- page restyle rate
// Any DOM change makes @bloomengine/web re-run the whole page (cascade, boxes, layout, paint list:
// ~11 ms a frame on an iPhone 16 Pro), and the HUD changes every frame (lap timer, speed). With
// APEX_PAGE_EVERY=n the page's invalidations are applied every n-th frame; every frame still draws
// the last page. The page's sink is the last one registered (installPage, when @bloomengine/web loads).
const every = Math.max(1, Number(process.env["APEX_PAGE_EVERY"] ?? "1") || 1);
if (every > 1) {
  const sinks = dom.mutationSinks;
  const pageSink = sinks[sinks.length - 1];
  if (pageSink !== undefined) {
    let pending: dom.MutationRecordInit | null = null;
    let frame = 0;
    sinks[sinks.length - 1] = (r) => { pending = r; };
    onBeforeFrame(() => {
      frame++;
      if (pending !== null && frame % every === 0) { const r = pending; pending = null; pageSink(r); }
    });
  }
}

// ---------------------------------------------------------------- SVG icons
// <img> files go to Bloom's texture loader, which reads raster images only: the HUD's .svg icons
// don't load. The asset pack has each icon as a PNG too (ui/icons/<name>_128.png).
for (const img of document.querySelectorAll("img[src$='.svg']")) {
  const src = img.getAttribute("src") ?? "";
  img.setAttribute("src", src.replace(/\.svg$/, "_128.png"));
}

// ---------------------------------------------------------------- flat HUD (phones, see config.ts)
// @bloomengine/web draws rounded corners one rect per device-pixel row, gradients as 24 px cells and
// blurred shadows as copies: ~10,000 draws a frame for the race HUD at 3x. Flat panels: ~100.
const FLAT_HUD = `
#hud, #hud *, #touch, #touch * { text-shadow: none !important; box-shadow: none !important; background-image: none !important; border-radius: 0 !important; }
.rpm-fill { background-color: #ffd447 !important; }
#hud-nitro-fill { background-color: #39c6ff !important; }
.hud-speedo { background-color: rgba(10, 14, 22, 0.6) !important; }
#minimap { background-color: rgba(14, 20, 30, 0.6) !important; }
`;
// Debugging: APEX_CSS="<rules>" adds native-only CSS after the page's own.
const extraCss = (process.env["APEX_FLAT_HUD"] === "1" ? FLAT_HUD : "") + (process.env["APEX_CSS"] ?? "");
if (extraCss !== "") {
  const style = document.createElement("style");
  style.textContent = extraCss;
  document.head.appendChild(style);
}
