import type { Manifest } from '../core/manifest';

export interface MapDot {
  x: number;
  z: number;
  heading: number;
  color: string;
  player: boolean;
}

/** Track outline (minimap_1024.png) cropped to the circuit, with live car dots. */
export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly bg: HTMLCanvasElement;
  private readonly k: number;
  private readonly ox: number;
  private readonly oz: number;
  private cropX = 0;
  private cropY = 0;
  private cropS = 1024;
  private size = 0;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly image: HTMLImageElement,
    manifest: Manifest,
  ) {
    const mm = manifest.track.minimap;
    this.k = mm.pixels_per_metre;
    this.ox = mm.offset_px[0];
    this.oz = mm.offset_px[1];
    const b = mm.world_bounds;
    const x0 = b.min_x * this.k + this.ox;
    const x1 = b.max_x * this.k + this.ox;
    const y0 = b.min_z * this.k + this.oz;
    const y1 = b.max_z * this.k + this.oz;
    const pad = 28;
    this.cropS = Math.max(x1 - x0, y1 - y0) + pad * 2;
    this.cropX = (x0 + x1) / 2 - this.cropS / 2;
    this.cropY = (y0 + y1) / 2 - this.cropS / 2;
    this.ctx = canvas.getContext('2d')!;
    this.bg = document.createElement('canvas');
    this.resize();
  }

  resize(): void {
    const css = this.canvas.clientWidth || 150;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(css * dpr);
    if (px === this.size) return;
    this.size = px;
    this.canvas.width = this.canvas.height = px;
    this.bg.width = this.bg.height = px;
    const b = this.bg.getContext('2d')!;
    b.clearRect(0, 0, px, px);
    b.drawImage(this.image, this.cropX, this.cropY, this.cropS, this.cropS, 0, 0, px, px);
  }

  draw(dots: MapDot[]): void {
    const c = this.ctx;
    const s = this.size;
    c.clearRect(0, 0, s, s);
    c.drawImage(this.bg, 0, 0);
    const scale = s / this.cropS;
    // draw opponents first, player last (on top)
    for (let pass = 0; pass < 2; pass++) {
      for (const d of dots) {
        if (d.player !== (pass === 1)) continue;
        const u = (d.x * this.k + this.ox - this.cropX) * scale;
        const v = (d.z * this.k + this.oz - this.cropY) * scale;
        const r = (d.player ? 5.5 : 4.2) * (s / 150);
        c.save();
        c.translate(u, v);
        if (d.player) {
          c.rotate(-d.heading);
          c.beginPath();
          c.moveTo(0, -r * 1.5);
          c.lineTo(r, r);
          c.lineTo(-r, r);
          c.closePath();
        } else {
          c.beginPath();
          c.arc(0, 0, r, 0, Math.PI * 2);
        }
        c.fillStyle = d.color;
        c.fill();
        c.lineWidth = Math.max(1.5, s / 90);
        c.strokeStyle = d.player ? '#fff' : 'rgba(10,12,18,0.9)';
        c.stroke();
        c.restore();
      }
    }
  }
}
