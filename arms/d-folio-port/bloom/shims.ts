/**
 * Small adapters between folio-2025 and @bloomengine/web (see PORT_LOG.md for each).
 * Installed after the browser runtime, before the game's code runs.
 */
import { spawn } from "node:child_process";

const g = globalThis as unknown as Record<string, unknown>;

// --- XMLHttpRequest (Howler loads its sounds with it): a GET over the page's fetch.
class XMLHttpRequestShim {
  static readonly UNSENT = 0; static readonly OPENED = 1; static readonly HEADERS_RECEIVED = 2; static readonly LOADING = 3; static readonly DONE = 4;
  readyState = 0;
  status = 0;
  statusText = "";
  response: unknown = null;
  responseText = "";
  responseType = "";
  responseURL = "";
  withCredentials = false;
  timeout = 0;
  onload: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onreadystatechange: ((e: unknown) => void) | null = null;
  onprogress: ((e: unknown) => void) | null = null;
  private method = "GET";
  private url = "";
  private listeners = new Map<string, Array<(e: unknown) => void>>();
  open(method: string, url: string): void { this.method = method; this.url = url; this.readyState = 1; }
  setRequestHeader(_k: string, _v: string): void {}
  overrideMimeType(_t: string): void {}
  getAllResponseHeaders(): string { return ""; }
  getResponseHeader(_k: string): string | null { return null; }
  abort(): void {}
  addEventListener(type: string, f: (e: unknown) => void): void { const l = this.listeners.get(type) ?? []; l.push(f); this.listeners.set(type, l); }
  removeEventListener(type: string, f: (e: unknown) => void): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((x) => x !== f)); }
  private emit(type: string): void {
    const e = { type, target: this, currentTarget: this, loaded: 0, total: 0, lengthComputable: false };
    const own = (this as unknown as Record<string, unknown>)["on" + type];
    if (typeof own === "function") (own as (e: unknown) => void).call(this, e);
    for (const f of this.listeners.get(type) ?? []) f.call(this, e);
  }
  send(_body?: unknown): void {
    const f = g["fetch"] as (url: string, init: unknown) => Promise<{ ok: boolean; status: number; url?: string; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }>;
    f(this.url, { method: this.method }).then(async (r) => {
      this.status = r.ok ? 200 : r.status || 404;
      this.responseURL = r.url ?? this.url;
      if (this.responseType === "arraybuffer" || this.responseType === "blob") this.response = await r.arrayBuffer();
      else if (this.responseType === "json") { this.responseText = await r.text(); this.response = JSON.parse(this.responseText); }
      else { this.responseText = await r.text(); this.response = this.responseText; }
      this.readyState = 4;
      this.emit("readystatechange");
      this.emit("load");
      this.emit("loadend");
    }, () => {
      this.status = 0; this.readyState = 4;
      this.emit("readystatechange");
      this.emit("error");
      this.emit("loadend");
    });
  }
}
if (typeof g["XMLHttpRequest"] === "undefined") g["XMLHttpRequest"] = XMLHttpRequestShim;

// --- window.open(url): the project, lab and social links open in the system browser. perry/system's
// openURL needs Perry's UI library next to Bloom's window, so macOS uses `open`; elsewhere the link is logged.
{
  const win = g["window"] as Record<string, unknown> | undefined;
  const open = (url?: string): null => {
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) return null;
    if (process.platform === "darwin") { try { spawn("/usr/bin/open", [url], { detached: true, stdio: "ignore" }); return null; } catch (_e) { /* below */ } }
    console.log("window.open: " + url);
    return null;
  };
  if (win !== undefined) win["open"] = open;
  g["open"] = open;
}

// --- CanvasRenderingContext2D.strokeText (the altar's counter): the bridge's 2D context has fillText
// only. Outlined text is drawn filled in the stroke colour.
{
  const doc = g["document"] as { createElement(t: string): { getContext(k: string): object | null } };
  const ctx = doc.createElement("canvas").getContext("2d");
  const proto = ctx === null ? null : Object.getPrototypeOf(ctx) as Record<string, unknown>;
  if (proto !== null && typeof proto["strokeText"] !== "function") {
    proto["strokeText"] = function (this: { fillStyle: unknown; strokeStyle: unknown; fillText(t: string, x: number, y: number, w?: number): void }, text: string, x: number, y: number, maxWidth?: number): void {
      const fill = this.fillStyle;
      this.fillStyle = this.strokeStyle;
      this.fillText(text, x, y, maxWidth);
      this.fillStyle = fill;
    };
  }
}

// --- getBoundingClientRect before the first layout. A browser lays the page out on demand; here an
// element gets its box when the page is first drawn, so the game's Viewport (built in Game.init, before
// any frame) measured `.game` as 0x0 and every camera matrix became NaN. A fixed element without a box
// yet measures as the viewport it is fixed to; before the first frame (no styles computed yet either) so
// does a child of <body> (`.game` is both: position fixed, 100% x 100%).
{
  const El = g["Element"] as { prototype: Record<string, unknown> } | undefined;
  const getStyle = g["getComputedStyle"] as ((e: unknown) => { position?: string; width?: string; height?: string }) | undefined;
  if (El !== undefined && getStyle !== undefined) {
    const original = El.prototype["getBoundingClientRect"] as (this: unknown) => { width: number; height: number };
    El.prototype["getBoundingClientRect"] = function (this: { _box?: unknown }) {
      const r = original.call(this);
      if (r.width === 0 && r.height === 0 && (this._box === null || this._box === undefined)) {
        const cs = getStyle(this);
        // before the first frame there is no cascade yet either: a top-level block of the body is page-sized
        const parent = (this as unknown as { parentElement?: unknown }).parentElement;
        const body = (g["document"] as { body?: unknown }).body;
        if (cs.position === "fixed" || ((cs.position ?? "") === "" && parent === body)) {
          const w = g["innerWidth"] as number, h = g["innerHeight"] as number;
          const Rect = g["DOMRect"] as new (x: number, y: number, w: number, h: number) => unknown;
          return new Rect(0, 0, w, h);
        }
      }
      return r;
    };
  }
}

export {};
