import { formatTime } from '../core/math';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

export interface HudState {
  speedKmh: number;
  gear: number;
  rpm: number;
  place: number;
  cars: number;
  lap: number;
  laps: number;
  lapTime: number;
  bestLap: number | null;
  nitro: number;
  boosting: boolean;
  drafting: boolean;
  drifting: boolean;
  wrongWay: boolean;
  offTrack: number; // seconds until auto reset, 0 = on track
}

/** DOM HUD. Writes only when a value changed to keep layout/paint cost negligible. */
export class Hud {
  readonly root = $('hud');
  private readonly speed = $('hud-speed');
  private readonly gear = $('hud-gear');
  private readonly rpm = $<HTMLElement>('hud-rpm');
  private readonly pos = $('hud-pos');
  private readonly posTotal = $('hud-pos-total');
  private readonly lap = $('hud-lap');
  private readonly lapTime = $('hud-laptime');
  private readonly best = $('hud-best');
  private readonly nitroFill = $('hud-nitro-fill');
  private readonly nitroWrap = $('hud-nitro');
  private readonly tags = $('hud-tags');
  private readonly center = $('hud-center');
  private readonly sub = $('hud-sub');
  private readonly warn = $('hud-warn');
  private readonly vignette = $('nitro-vignette');
  private cache: Record<string, string> = {};
  private centerTimer = 0;
  private subTimer = 0;

  private set(el: HTMLElement, key: string, text: string): void {
    if (this.cache[key] === text) return;
    this.cache[key] = text;
    el.textContent = text;
  }

  private cls(el: HTMLElement, key: string, name: string, on: boolean): void {
    const k = `${key}:${name}`;
    const v = on ? '1' : '0';
    if (this.cache[k] === v) return;
    this.cache[k] = v;
    el.classList.toggle(name, on);
  }

  show(on: boolean): void {
    this.root.classList.toggle('hidden', !on);
  }

  /** Big centre text (countdown, GO, FINISH). duration 0 = until replaced. */
  flash(text: string, duration: number, style = ''): void {
    this.center.textContent = text;
    this.center.className = `show ${style}`;
    // restart the CSS animation
    void this.center.offsetWidth;
    this.center.classList.add('pop');
    this.centerTimer = duration;
  }

  message(text: string, duration = 2): void {
    this.sub.textContent = text;
    this.sub.classList.add('show');
    this.subTimer = duration;
  }

  clearMessages(): void {
    this.center.className = '';
    this.sub.classList.remove('show');
    this.centerTimer = 0;
    this.subTimer = 0;
  }

  update(dt: number, s: HudState): void {
    if (this.centerTimer > 0) {
      this.centerTimer -= dt;
      if (this.centerTimer <= 0) this.center.className = '';
    }
    if (this.subTimer > 0) {
      this.subTimer -= dt;
      if (this.subTimer <= 0) this.sub.classList.remove('show');
    }
    this.set(this.speed, 'speed', String(Math.round(s.speedKmh)));
    this.set(this.gear, 'gear', s.gear === 0 ? 'R' : String(s.gear));
    const rpmPct = Math.round(Math.min(1, s.rpm / 7800) * 100);
    const rk = String(rpmPct);
    if (this.cache.rpm !== rk) {
      this.cache.rpm = rk;
      this.rpm.style.setProperty('--rpm', `${rpmPct}`);
    }
    this.cls(this.rpm, 'rpm', 'redline', s.rpm > 7000);
    this.set(this.pos, 'pos', String(s.place));
    this.set(this.posTotal, 'posT', `/${s.cars}`);
    this.set(this.lap, 'lap', `${s.lap}/${s.laps}`);
    this.set(this.lapTime, 'lt', formatTime(s.lapTime));
    this.set(this.best, 'best', formatTime(s.bestLap));
    const nk = (Math.round(s.nitro * 200) / 2).toFixed(1);
    if (this.cache.nitro !== nk) {
      this.cache.nitro = nk;
      this.nitroFill.style.transform = `scaleX(${s.nitro.toFixed(3)})`;
    }
    this.cls(this.nitroWrap, 'nitro', 'ready', s.nitro >= 0.12 && !s.boosting);
    this.cls(this.nitroWrap, 'nitro', 'active', s.boosting);
    this.cls(this.vignette, 'vig', 'on', s.boosting);
    const tags = s.drafting ? 'SLIPSTREAM +N2O' : s.drifting ? 'DRIFT +N2O' : '';
    this.set(this.tags, 'tags', tags);
    let warn = '';
    if (s.wrongWay) warn = 'WRONG WAY';
    else if (s.offTrack > 0) warn = `OFF TRACK · RESET IN ${Math.ceil(s.offTrack)}`;
    this.set(this.warn, 'warn', warn);
    this.cls(this.warn, 'warn', 'show', warn !== '');
  }
}
