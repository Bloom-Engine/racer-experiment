import { approach, clamp } from '../core/math';
import { emptyControls, type Controls } from '../physics/Vehicle';

export type Action = 'pause' | 'camera' | 'reset' | 'mute';
type TouchButton = 'left' | 'right' | 'brake' | 'nitro';

/**
 * Merges keyboard, multi-touch buttons and gamepad into one Controls struct plus
 * edge-triggered actions. Touch: every pointer is tracked independently (steer +
 * nitro + brake at once), fingers may slide between buttons, throttle is automatic.
 */
export class Input {
  readonly controls: Controls = emptyControls();
  readonly isTouch: boolean;
  touchActive = false;
  private readonly keys = new Set<string>();
  private readonly actions = new Set<Action>();
  private readonly pointers = new Map<number, TouchButton | null>();
  private readonly held: Record<TouchButton, number> = { left: 0, right: 0, brake: 0, nitro: 0 };
  private steer = 0;
  private padPrev: boolean[] = [];
  private padUsed = false;
  enabled = true;

  constructor() {
    this.isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    this.touchActive = this.isTouch;
    window.addEventListener('keydown', (e) => {
      if (e.repeat) {
        if (this.isGameKey(e.code)) e.preventDefault();
        return;
      }
      this.keys.add(e.code);
      this.touchActive = false;
      switch (e.code) {
        case 'KeyP':
        case 'Escape':
          this.actions.add('pause');
          break;
        case 'KeyC':
          this.actions.add('camera');
          break;
        case 'KeyR':
          this.actions.add('reset');
          break;
        case 'KeyM':
          this.actions.add('mute');
          break;
      }
      if (this.isGameKey(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.pointers.clear();
      this.held.left = this.held.right = this.held.brake = this.held.nitro = 0;
    });
  }

  private isGameKey(code: string): boolean {
    return /^(Arrow|Space|Shift)/.test(code) || ['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(code);
  }

  /** Wire up the on-screen touch buttons (elements with data-touch="left|right|brake|nitro"). */
  bindTouch(root: HTMLElement): void {
    const buttonAt = (x: number, y: number): TouchButton | null => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      const b = el?.closest<HTMLElement>('[data-touch]');
      return (b?.dataset.touch as TouchButton | undefined) ?? null;
    };
    const set = (id: number, b: TouchButton | null): void => {
      const prev = this.pointers.get(id) ?? null;
      if (prev === b) return;
      if (prev) this.held[prev]--;
      if (b) this.held[b]++;
      this.pointers.set(id, b);
      this.refreshTouchVisuals(root);
    };
    root.addEventListener('pointerdown', (e) => {
      const b = buttonAt(e.clientX, e.clientY);
      if (!b) return;
      e.preventDefault();
      this.touchActive = true;
      try {
        root.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      set(e.pointerId, b);
    });
    root.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const prev = this.pointers.get(e.pointerId) ?? null;
      const b = buttonAt(e.clientX, e.clientY);
      // allow sliding between the two steering buttons, keep others latched
      if (prev === 'left' || prev === 'right') {
        if (b === 'left' || b === 'right') set(e.pointerId, b);
      }
    });
    const up = (e: PointerEvent): void => {
      if (!this.pointers.has(e.pointerId)) return;
      set(e.pointerId, null);
      this.pointers.delete(e.pointerId);
    };
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);
    root.addEventListener('lostpointercapture', up);
    root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private refreshTouchVisuals(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>('[data-touch]').forEach((el) => {
      const k = el.dataset.touch as TouchButton;
      el.classList.toggle('pressed', this.held[k] > 0);
    });
  }

  trigger(a: Action): void {
    this.actions.add(a);
  }

  consume(a: Action): boolean {
    return this.actions.delete(a);
  }

  /** Clear latched actions (e.g. when changing screens). */
  clearActions(): void {
    this.actions.clear();
  }

  update(dt: number, forwardSpeed: number): Controls {
    const k = this.keys;
    const c = this.controls;
    let throttle = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0;
    let brake = k.has('KeyS') || k.has('ArrowDown') ? 1 : 0;
    let steerTarget = (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) - (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0);
    let handbrake = k.has('Space');
    let nitro = k.has('ShiftLeft') || k.has('ShiftRight');
    let analogSteer: number | null = null;

    // ---- touch: auto-throttle, brake doubles as drift button while steering at speed
    if (this.touchActive) {
      const tl = this.held.left > 0;
      const tr = this.held.right > 0;
      const tb = this.held.brake > 0;
      if (tl || tr) steerTarget = (tl ? 1 : 0) - (tr ? 1 : 0);
      if (tb) {
        if ((tl || tr) && forwardSpeed > 12) {
          handbrake = true;
          throttle = 1;
        } else {
          brake = 1;
          throttle = 0;
        }
      } else throttle = 1;
      if (this.held.nitro > 0) nitro = true;
    }

    // ---- gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const btn = (i: number): number => (p.buttons[i] ? p.buttons[i].value : 0);
      const pressed = (i: number): boolean => !!p.buttons[i]?.pressed;
      const ax = p.axes[0] ?? 0;
      const rt = btn(7);
      const lt = btn(6);
      const any = Math.abs(ax) > 0.15 || rt > 0.05 || lt > 0.05 || p.buttons.some((b) => b.pressed);
      if (any) {
        this.padUsed = true;
        this.touchActive = false;
      }
      if (!this.padUsed) break;
      if (Math.abs(ax) > 0.12) analogSteer = -Math.sign(ax) * ((Math.abs(ax) - 0.12) / 0.88);
      if (pressed(14)) steerTarget = 1;
      if (pressed(15)) steerTarget = -1;
      throttle = Math.max(throttle, rt, pressed(12) ? 1 : 0);
      brake = Math.max(brake, lt, pressed(13) ? 1 : 0);
      handbrake = handbrake || pressed(2) || pressed(1);
      nitro = nitro || pressed(0) || pressed(5);
      const edges: [number, Action][] = [
        [9, 'pause'],
        [3, 'camera'],
        [8, 'reset'],
      ];
      for (const [i, a] of edges) {
        const now = pressed(i);
        if (now && !this.padPrev[i]) this.actions.add(a);
        this.padPrev[i] = now;
      }
      break;
    }

    if (analogSteer !== null) {
      this.steer = analogSteer;
    } else {
      // digital steering ramps for smoothness; returning/reversing is faster
      const rate = steerTarget === 0 ? 7 : Math.sign(steerTarget) !== Math.sign(this.steer) ? 9 : 4.2;
      this.steer = approach(this.steer, steerTarget, rate * dt);
    }

    if (!this.enabled) {
      throttle = brake = 0;
      handbrake = nitro = false;
    }
    c.throttle = clamp(throttle, 0, 1);
    c.brake = clamp(brake, 0, 1);
    c.steer = clamp(this.steer, -1, 1);
    c.handbrake = handbrake;
    c.nitro = nitro;
    return c;
  }
}
