/**
 * Input from Bloom: keyboard, gamepad and multi-touch, merged into one per-frame snapshot.
 * Touch fingers are tracked by slot (0..getMaxTouchPoints, skipping inactive slots) so steering
 * with one finger and holding nitro with another both work.
 */
import {
  isKeyDown, isKeyPressed, Key,
  isGamepadAvailable, getGamepadAxis, isGamepadButtonDown, isGamepadButtonPressed,
  getMaxTouchPoints, isTouchActive, getTouchX, getTouchY,
  isMouseButtonPressed, getMouseX, getMouseY, isMobile,
  getScreenWidth, getScreenHeight,
} from "@bloomengine/engine";

export interface InputFrame {
  throttle: number; brake: number; steer: number;
  handbrake: boolean; nitro: boolean;
  reset: boolean; camera: boolean; pause: boolean; confirm: boolean;
  /** taps / clicks this frame (screen coordinates), for menu buttons */
  taps: { x: number; y: number }[];
  touchMode: boolean;
}

export interface Rect { x: number; y: number; w: number; h: number }

export type TouchButton = "left" | "right" | "brake" | "nitro" | "drift" | "pause" | "camera" | "reset";

/** On-screen controls, sized from the screen height (works in iOS pixels and macOS points alike). */
export function touchLayout(): Record<TouchButton, Rect> {
  const w = getScreenWidth(), h = getScreenHeight();
  const u = h / 400;            // layout unit
  const big = 74 * u, small = 40 * u, m = 14 * u;
  return {
    left: { x: m, y: h - big - m, w: big, h: big },
    right: { x: m * 2 + big, y: h - big - m, w: big, h: big },
    brake: { x: w - big - m, y: h - big - m, w: big, h: big },
    nitro: { x: w - big * 2 - m * 2, y: h - big - m, w: big, h: big },
    drift: { x: w - big - m, y: h - big * 2 - m * 2, w: big, h: big * 0.8 },
    pause: { x: w - small - m, y: m, w: small, h: small },
    camera: { x: w - small * 2 - m * 2, y: m, w: small, h: small },
    reset: { x: w - small * 3 - m * 3, y: m, w: small, h: small },
  };
}

function inside(r: Rect, x: number, y: number): boolean { return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }

// gamepad mapping as polled by Bloom's GCController backend (native/macos, native/ios)
const PAD_STEER = 0, PAD_LT = 4, PAD_RT = 5;
const PAD_A = 0, PAD_B = 1, PAD_X = 2, PAD_Y = 3, PAD_LB = 4, PAD_RB = 5, PAD_UP = 12;

export class Input {
  private readonly mobile = isMobile();
  /** RACER_TOUCH=1 shows the touch controls on a desktop (screenshots, mouse testing) */
  private touchSeen = process.env["RACER_TOUCH"] === "1";
  private activeSlots = new Set<number>();
  /** which touch buttons are held right now (for drawing them pressed) */
  readonly held = new Set<TouchButton>();
  /** injected by scripted test runs */
  scripted: Partial<InputFrame> | null = null;

  poll(raceControlsVisible: boolean): InputFrame {
    const f: InputFrame = {
      throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false,
      reset: false, camera: false, pause: false, confirm: false, taps: [], touchMode: this.mobile || this.touchSeen,
    };
    // keyboard
    if (isKeyDown(Key.UP) || isKeyDown(Key.W)) f.throttle = 1;
    if (isKeyDown(Key.DOWN) || isKeyDown(Key.S)) f.brake = 1;
    if (isKeyDown(Key.LEFT) || isKeyDown(Key.A)) f.steer -= 1;
    if (isKeyDown(Key.RIGHT) || isKeyDown(Key.D)) f.steer += 1;
    if (isKeyDown(Key.SPACE)) f.handbrake = true;
    if (isKeyDown(Key.LEFT_SHIFT) || isKeyDown(Key.RIGHT_SHIFT)) f.nitro = true;
    if (isKeyPressed(Key.R)) f.reset = true;
    if (isKeyPressed(Key.C)) f.camera = true;
    if (isKeyPressed(Key.P) || isKeyPressed(Key.ESCAPE)) f.pause = true;
    if (isKeyPressed(Key.ENTER)) f.confirm = true;

    // gamepad
    if (isGamepadAvailable()) {
      const sx = getGamepadAxis(PAD_STEER);
      if (Math.abs(sx) > 0.12) f.steer += sx;
      f.throttle = Math.max(f.throttle, getGamepadAxis(PAD_RT));
      f.brake = Math.max(f.brake, getGamepadAxis(PAD_LT));
      if (isGamepadButtonDown(PAD_X) || isGamepadButtonDown(PAD_LB)) f.handbrake = true;
      if (isGamepadButtonDown(PAD_A) || isGamepadButtonDown(PAD_RB)) f.nitro = true;
      if (isGamepadButtonPressed(PAD_B)) f.reset = true;
      if (isGamepadButtonPressed(PAD_Y)) f.camera = true;
      if (isGamepadButtonPressed(PAD_UP)) f.pause = true;
      if (isGamepadButtonPressed(PAD_A)) f.confirm = true;
    }

    // touch: every live slot, each finger on its own button
    this.held.clear();
    const layout = touchLayout();
    const max = getMaxTouchPoints();
    const live = new Set<number>();
    for (let i = 0; i < max; i++) {
      if (!isTouchActive(i)) continue;
      live.add(i);
      this.touchSeen = true;
      const x = getTouchX(i), y = getTouchY(i);
      if (!this.activeSlots.has(i)) f.taps.push({ x, y });
      if (!raceControlsVisible) continue;
      for (const name of Object.keys(layout) as TouchButton[]) {
        if (inside(layout[name], x, y)) this.held.add(name);
      }
    }
    // a button counts as "pressed" for one-shot actions when a new finger lands on it
    for (const t of f.taps) {
      if (!raceControlsVisible) break;
      if (inside(layout.pause, t.x, t.y)) f.pause = true;
      if (inside(layout.camera, t.x, t.y)) f.camera = true;
      if (inside(layout.reset, t.x, t.y)) f.reset = true;
    }
    this.activeSlots = live;
    if (this.held.has("left")) f.steer -= 1;
    if (this.held.has("right")) f.steer += 1;
    if (this.held.has("brake")) f.brake = 1;
    if (this.held.has("nitro")) f.nitro = true;
    if (this.held.has("drift")) f.handbrake = true;
    if (f.touchMode && raceControlsVisible && f.brake === 0) f.throttle = 1;   // auto-accelerate on touch

    // mouse clicks act as taps on desktop (iOS mirrors touch 0 into the mouse: skip it there)
    if (!this.mobile && isMouseButtonPressed(0)) f.taps.push({ x: getMouseX(), y: getMouseY() });

    if (this.scripted !== null) Object.assign(f, this.scripted);
    f.steer = Math.max(-1, Math.min(1, f.steer));
    return f;
  }
}
