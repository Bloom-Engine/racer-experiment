// Input aggregation: keyboard + gamepad + multi-touch -> one control state.
import {
  isKeyDown, isKeyPressed, Key, getScreenWidth, getScreenHeight,
  isTouchActive, getMaxTouchPoints, getTouchX, getTouchY,
  isGamepadAvailable, getGamepadAxis, isGamepadButtonDown, isGamepadButtonPressed,
  isMouseButtonPressed, getMouseX, getMouseY, isMobile,
} from "bloom/core";

export interface Rect { x: number; y: number; w: number; h: number }

export interface Controls {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
  nitro: boolean;
  reset: boolean;      // pressed this frame
  camera: boolean;     // pressed this frame
  pause: boolean;      // pressed this frame
  confirm: boolean;    // pressed this frame (Enter / A / tap)
  tapX: number;        // tap/click position this frame (-1 if none)
  tapY: number;
  // touch button highlight state
  tLeft: boolean; tRight: boolean; tBrake: boolean; tNitro: boolean;
}

export const controls: Controls = {
  throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false,
  reset: false, camera: false, pause: false, confirm: false, tapX: -1, tapY: -1,
  tLeft: false, tRight: false, tBrake: false, tNitro: false,
};

/** True once any touch has been seen (or on mobile platforms). Enables touch UI + auto-throttle. */
export let touchMode = false;

export interface TouchLayout {
  left: Rect; right: Rect; brake: Rect; nitro: Rect;
  pause: Rect; camera: Rect; reset: Rect;
}

// Cached per screen size: called several times per frame, and fresh objects
// are never freed in the browser build (Perry wasm runtime).
let layoutCache: TouchLayout | null = null;
let layoutW = -1, layoutH = -1;
export function touchLayout(): TouchLayout {
  const sw = getScreenWidth(), sh = getScreenHeight();
  if (layoutCache !== null && sw === layoutW && sh === layoutH) return layoutCache;
  layoutW = sw; layoutH = sh;
  layoutCache = buildTouchLayout(sw, sh);
  return layoutCache;
}

function buildTouchLayout(sw: number, sh: number): TouchLayout {
  const u = sh / 720;
  const b = 150 * u;          // big button size
  const m = 36 * u;           // margin
  const s = 84 * u;           // small button
  return {
    left: { x: m, y: sh - b - m, w: b, h: b },
    right: { x: m + b + 24 * u, y: sh - b - m, w: b, h: b },
    brake: { x: sw - b - m, y: sh - b - m, w: b, h: b },
    nitro: { x: sw - 2 * b - m - 24 * u, y: sh - b - m, w: b, h: b },
    pause: { x: sw - s - 24 * u, y: 24 * u, w: s, h: s },
    camera: { x: sw - 2 * s - 40 * u, y: 24 * u, w: s, h: s },
    reset: { x: sw - 3 * s - 56 * u, y: 24 * u, w: s, h: s },
  };
}

export function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

// Per-slot previous-frame activity, for tap detection.
const MAX_SLOTS = 10;
const prevActive: boolean[] = [false, false, false, false, false, false, false, false, false, false];

export function initInput(): void {
  if (isMobile()) touchMode = true;
}

/** Poll all devices. `inRace` enables the in-race touch buttons. */
export function pollInput(inRace: boolean): void {
  const c = controls;
  c.reset = false; c.camera = false; c.pause = false; c.confirm = false;
  c.tapX = -1; c.tapY = -1;

  // ---- keyboard ----
  let throttle = 0, brake = 0, steer = 0;
  let handbrake = false, nitro = false;
  if (isKeyDown(Key.UP) || isKeyDown(Key.W)) throttle = 1;
  if (isKeyDown(Key.DOWN) || isKeyDown(Key.S)) brake = 1;
  if (isKeyDown(Key.LEFT) || isKeyDown(Key.A)) steer -= 1;
  if (isKeyDown(Key.RIGHT) || isKeyDown(Key.D)) steer += 1;
  if (isKeyDown(Key.SPACE)) handbrake = true;
  if (isKeyDown(Key.LEFT_SHIFT) || isKeyDown(Key.RIGHT_SHIFT)) nitro = true;
  if (isKeyPressed(Key.R)) c.reset = true;
  if (isKeyPressed(Key.C)) c.camera = true;
  if (isKeyPressed(Key.P) || isKeyPressed(Key.ESCAPE)) c.pause = true;
  if (isKeyPressed(Key.ENTER)) c.confirm = true;

  // ---- gamepad ----
  if (isGamepadAvailable()) {
    const ax = getGamepadAxis(0);
    if (Math.abs(ax) > 0.12) steer += ax;
    const rt = getGamepadAxis(5);
    const lt = getGamepadAxis(4);
    if (rt > 0.05) throttle = Math.max(throttle, rt);
    if (lt > 0.05) brake = Math.max(brake, lt);
    if (isGamepadButtonDown(14)) steer -= 1;
    if (isGamepadButtonDown(15)) steer += 1;
    if (isGamepadButtonDown(0) || isGamepadButtonDown(5)) nitro = true;
    if (isGamepadButtonDown(1)) handbrake = true;
    if (isGamepadButtonPressed(2)) c.reset = true;
    if (isGamepadButtonPressed(3)) c.camera = true;
    if (isGamepadButtonPressed(4)) c.pause = true;
    if (isGamepadButtonPressed(0)) c.confirm = true;
  }

  // ---- mouse click (desktop menus) ----
  if (isMouseButtonPressed(0)) { c.tapX = getMouseX(); c.tapY = getMouseY(); }

  // ---- touch (true multi-touch: scan all slots, skip inactive ones) ----
  c.tLeft = false; c.tRight = false; c.tBrake = false; c.tNitro = false;
  const L = touchLayout();
  let n = getMaxTouchPoints();
  if (n > MAX_SLOTS) n = MAX_SLOTS;
  for (let i = 0; i < n; i++) {
    const active = isTouchActive(i);
    if (active) {
      touchMode = true;
      const x = getTouchX(i), y = getTouchY(i);
      const began = !prevActive[i];
      if (began) { c.tapX = x; c.tapY = y; }
      if (inRace) {
        if (inRect(L.left, x, y)) c.tLeft = true;
        if (inRect(L.right, x, y)) c.tRight = true;
        if (inRect(L.brake, x, y)) c.tBrake = true;
        if (inRect(L.nitro, x, y)) c.tNitro = true;
        if (began && inRect(L.pause, x, y)) c.pause = true;
        if (began && inRect(L.camera, x, y)) c.camera = true;
        if (began && inRect(L.reset, x, y)) c.reset = true;
      }
    }
    prevActive[i] = active;
  }
  if (touchMode && inRace) {
    if (c.tLeft) steer -= 1;
    if (c.tRight) steer += 1;
    if (c.tNitro) nitro = true;
    if (c.tBrake) {
      brake = 1;
    } else if (throttle === 0 && brake === 0) {
      throttle = 1; // auto-accelerate on touch devices
    }
    // tapping brake while steering hard acts as a handbrake for drifting
    if (c.tBrake && (c.tLeft || c.tRight)) handbrake = true;
  }

  if (steer > 1) steer = 1;
  if (steer < -1) steer = -1;
  c.throttle = throttle; c.brake = brake; c.steer = steer;
  c.handbrake = handbrake; c.nitro = nitro;
}
