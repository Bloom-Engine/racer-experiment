/**
 * Diagnostics for scripted runs (BLOOM_SCRIPT="... probe"): the game's view and player state.
 * Not needed to play; imported by main.ts after the shims.
 */
import { config } from "@bloomengine/web/config";
import { Game } from "./.build/sources/Game/Game.js";

const fmt = (v: unknown): string => {
  if (v === null || v === undefined) return String(v);
  const o = v as Record<string, number>;
  if (typeof o["x"] === "number") return `(${o["x"].toFixed(2)},${o["y"]?.toFixed(2)},${(o["z"] ?? 0).toFixed?.(2)})`;
  return JSON.stringify(v);
};
config().scriptCommands["probe"] = () => {
  const g = (Game as unknown as { getInstance(): Record<string, any> }).getInstance();
  const view = g["view"], vp = g["viewport"], t = g["ticker"];
  { const el = (globalThis as any).document.querySelector(".game"); const cs = (globalThis as any).getComputedStyle(el); const r = el.getBoundingClientRect(); console.error(`probe .game rect ${r.width}x${r.height} position ${cs.position} width ${cs.width} box ${JSON.stringify(el._box)} Element ${typeof (globalThis as any).Element} patched ${String((globalThis as any).Element?.prototype?.getBoundingClientRect).slice(0, 60)} inner ${(globalThis as any).innerWidth}x${(globalThis as any).innerHeight}`); }
  console.error(`probe viewport ${vp?.width}x${vp?.height} ratio ${vp?.ratio} pixelRatio ${vp?.pixelRatio}`);
  console.error(`probe ticker delta ${t?.delta} deltaScaled ${t?.deltaScaled} deltaAverage ${t?.deltaAverage} elapsed ${t?.elapsed}`);
  console.error(`probe camera ${fmt(view?.camera?.position)} aspect ${view?.camera?.aspect} fov ${view?.camera?.fov}`);
  console.error(`probe spherical r ${view?.spherical?.radius?.current} phi ${view?.spherical?.phi} theta ${view?.spherical?.theta} offset ${fmt(view?.spherical?.offset)}`);
  console.error(`probe zoom ${JSON.stringify({ ratio: view?.zoom?.ratio, smoothed: view?.zoom?.smoothedRatio })}`);
  console.error(`probe focus ${fmt(view?.focusPoint?.position)} smoothed ${fmt(view?.focusPoint?.smoothedPosition)} tracked ${fmt(view?.focusPoint?.trackedPosition)}`);
  console.error(`probe view.position ${fmt(view?.position)} optimal radius ${view?.optimalArea?.radius} base ${fmt(view?.optimalArea?.basePosition)}`);
  console.error(`probe player ${fmt(g["player"]?.position)} vehicle ${fmt(g["physicalVehicle"]?.position)} speed ${g["physicalVehicle"]?.speed}`);
};

// FOLIO_TRACE=1: a listener that throws names itself (its source), since native stack frames don't.
import { Events } from "./.build/sources/Game/Events.js";
if (process.env["FOLIO_TRACE"] === "1") {
  const proto = (Events as unknown as { prototype: Record<string, unknown> }).prototype;
  proto["trigger"] = function (this: { callbacks: Record<string, Array<Array<(...a: unknown[]) => void>>> }, name: string, args: unknown[] = []) {
    const lists = this.callbacks[name];
    if (Array.isArray(lists)) {
      for (const order in lists) {
        for (const f of lists[order] ?? []) {
          try { f.apply(this, args); } catch (e) {
            console.error(`trace listener "${name}" #${order} threw ${String(e)}:\n${String(f).slice(0, 400)}`);
            throw e;
          }
        }
      }
    }
    return this;
  };
}
import { Ticker } from "./.build/sources/Game/Ticker.js";
if (process.env["FOLIO_TRACE"] === "1") {
  const proto = (Ticker as unknown as { prototype: Record<string, unknown> }).prototype;
  const wait = proto["wait"] as (this: unknown, frames: number, f: () => void) => void;
  proto["wait"] = function (this: unknown, frames: number, f: () => void) {
    wait.call(this, frames, () => { try { f(); } catch (e) { console.error(`trace wait callback threw ${String(e)}:\n${String(f).slice(0, 500)}`); throw e; } });
  };
}
