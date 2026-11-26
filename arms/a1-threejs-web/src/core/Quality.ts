import type * as THREE from 'three';

/**
 * Frame-time monitor + dynamic resolution. Browsers cap rAF at the display rate, so
 * we can only detect *missing* headroom: if the average over a 2 s window drops
 * below ~55 fps the render scale steps down (never below minRatio). Also records
 * fps statistics for the debug overlay and automated perf runs.
 */
export class Quality {
  ratio: number;
  private readonly minRatio: number;
  private acc = 0;
  private frames = 0;
  private cooldown = 0;
  // stats
  fps = 60;
  totalFrames = 0;
  totalTime = 0;
  worstWindowFps = Infinity;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    mobile: boolean,
  ) {
    const dpr = window.devicePixelRatio || 1;
    this.ratio = Math.min(dpr, mobile ? 1.6 : 2);
    this.minRatio = Math.min(this.ratio, mobile ? 0.9 : 1);
    renderer.setPixelRatio(this.ratio);
  }

  resetStats(): void {
    this.totalFrames = 0;
    this.totalTime = 0;
    this.worstWindowFps = Infinity;
  }

  /** Returns true if the render scale changed. */
  frame(dt: number, adapt: boolean): boolean {
    this.acc += dt;
    this.frames++;
    this.totalFrames++;
    this.totalTime += dt;
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.acc < 2) return false;
    this.fps = this.frames / this.acc;
    this.worstWindowFps = Math.min(this.worstWindowFps, this.fps);
    this.acc = 0;
    this.frames = 0;
    if (!adapt || this.cooldown > 0) return false;
    if (this.fps < 54 && this.ratio > this.minRatio + 0.01) {
      this.ratio = Math.max(this.minRatio, this.ratio - 0.15);
      this.renderer.setPixelRatio(this.ratio);
      this.cooldown = 3;
      return true;
    }
    return false;
  }

  get averageFps(): number {
    return this.totalTime > 0 ? this.totalFrames / this.totalTime : 0;
  }
}
