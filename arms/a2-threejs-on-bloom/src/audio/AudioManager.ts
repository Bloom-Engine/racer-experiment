import { clamp } from '../core/math';

interface Loop {
  src: AudioBufferSourceNode;
  gain: GainNode;
}

interface AIVoice extends Loop {
  pan: StereoPannerNode | null;
}

const ENGINE_LAYERS: [string, number][] = [
  ['engine_idle', 900],
  ['engine_mid', 4000],
  ['engine_high', 7500],
];

/**
 * Web Audio based sound. Engine = three seamless loops (idle/mid/high) pitched by
 * rpm/base_rpm and equal-power crossfaded in log-rpm space; upshifts duck the bus
 * briefly. Tyre screech, wind and nitro rumble are continuous layers; AI cars get
 * a quiet panned engine voice each. Everything is started on the first user gesture.
 */
export class AudioManager {
  readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly sfx: GainNode;
  private readonly engineBus: GainNode;
  private buffers: Record<string, AudioBuffer> = {};
  private engine: Loop[] = [];
  private screech: Loop | null = null;
  private wind: Loop | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private rumble: Loop | null = null;
  private ai: AIVoice[] = [];
  private started = false;
  private muted = false;
  private duckUntil = 0;
  private lastHit = 0;

  constructor() {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(this.ctx.destination);
    this.sfx = this.ctx.createGain();
    this.sfx.connect(this.master);
    this.engineBus = this.ctx.createGain();
    this.engineBus.gain.value = 0;
    this.engineBus.connect(this.master);
    try {
      this.muted = localStorage.getItem('apexrush.muted') === '1';
    } catch {
      /* storage unavailable */
    }
    this.master.gain.value = this.muted ? 0 : 0.9;
  }

  async decode(raw: Record<string, ArrayBuffer>): Promise<void> {
    const entries = await Promise.all(
      Object.entries(raw).map(async ([name, data]) => {
        try {
          // slice: Safari detaches the buffer
          const buf = await this.ctx.decodeAudioData(data.slice(0));
          return [name, buf] as const;
        } catch {
          return [name, null] as const;
        }
      }),
    );
    for (const [n, b] of entries) if (b) this.buffers[n] = b;
    if (!this.buffers.wind_noise) this.buffers.wind_noise = this.makeNoise(2);
  }

  private makeNoise(seconds: number): AudioBuffer {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const b = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // brown-ish noise: smoother, less hissy
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    // circular crossfade so the loop is seamless
    const fade = Math.floor(this.ctx.sampleRate * 0.05);
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      d[i] = d[i] * t + d[len - fade + i] * (1 - t);
    }
    return b;
  }

  private loop(name: string, dest: AudioNode, gain = 0): Loop | null {
    const buf = this.buffers[name];
    if (!buf) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(dest);
    src.start(this.ctx.currentTime, Math.random() * buf.duration);
    return { src, gain: g };
  }

  /** Must be called from a user gesture (iOS/Chrome autoplay policies). */
  unlock(): void {
    if (this.ctx.state !== 'running') void this.ctx.resume();
    if (this.started) return;
    this.started = true;
    // iOS: play a one-sample silent buffer inside the gesture
    const silent = this.ctx.createBuffer(1, 1, 22050);
    const s = this.ctx.createBufferSource();
    s.buffer = silent;
    s.connect(this.ctx.destination);
    s.start();

    this.engine = ENGINE_LAYERS.map(([n]) => this.loop(n, this.engineBus)).filter((l): l is Loop => !!l);
    this.screech = this.loop('tyre_screech_loop', this.sfx);
    const wf = this.ctx.createBiquadFilter();
    wf.type = 'bandpass';
    wf.frequency.value = 400;
    wf.Q.value = 0.6;
    wf.connect(this.sfx);
    this.windFilter = wf;
    this.wind = this.loop('wind_noise', wf);
    const rf = this.ctx.createBiquadFilter();
    rf.type = 'lowpass';
    rf.frequency.value = 180;
    rf.connect(this.sfx);
    this.rumble = this.loop('wind_noise', rf);
    for (let i = 0; i < 3; i++) {
      const pan = typeof this.ctx.createStereoPanner === 'function' ? this.ctx.createStereoPanner() : null;
      if (pan) pan.connect(this.sfx);
      const l = this.loop('engine_mid', pan ?? this.sfx);
      if (l) this.ai.push({ ...l, pan });
    }
  }

  get isMuted(): boolean {
    return this.muted;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, this.ctx.currentTime, 0.05);
    try {
      localStorage.setItem('apexrush.muted', this.muted ? '1' : '0');
    } catch {
      /* ignore */
    }
    return this.muted;
  }

  setPaused(p: boolean): void {
    if (p) void this.ctx.suspend();
    else void this.ctx.resume();
  }

  /** Silence the continuous layers (menus). */
  quiet(): void {
    const t = this.ctx.currentTime;
    this.engineBus.gain.setTargetAtTime(0, t, 0.15);
    for (const l of [this.screech, this.wind, this.rumble, ...this.ai]) l?.gain.gain.setTargetAtTime(0, t, 0.1);
  }

  updatePlayer(p: {
    rpm: number;
    throttle: number;
    speed: number;
    slip: number;
    grounded: boolean;
    boosting: boolean;
    shiftedUp: boolean;
    offroad: boolean;
  }): void {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    const rpm = clamp(p.rpm, 600, 8200);
    const lr = Math.log(rpm);
    const w = [0, 0, 0];
    const l0 = Math.log(900);
    const l1 = Math.log(4000);
    const l2 = Math.log(7500);
    if (lr <= l0) w[0] = 1;
    else if (lr <= l1) {
      const x = (lr - l0) / (l1 - l0);
      w[0] = Math.cos((x * Math.PI) / 2);
      w[1] = Math.sin((x * Math.PI) / 2);
    } else if (lr <= l2) {
      const x = (lr - l1) / (l2 - l1);
      w[1] = Math.cos((x * Math.PI) / 2);
      w[2] = Math.sin((x * Math.PI) / 2);
    } else w[2] = 1;
    this.engine.forEach((l, i) => {
      const base = ENGINE_LAYERS[i][1];
      l.src.playbackRate.setTargetAtTime(clamp(rpm / base, 0.5, 2.2), t, 0.03);
      l.gain.gain.setTargetAtTime(w[i] * (i === 0 ? 0.9 : 1), t, 0.04);
    });
    if (p.shiftedUp) this.duckUntil = t + 0.12;
    const load = 0.55 + 0.45 * p.throttle;
    const duck = t < this.duckUntil ? 0.45 : 1;
    this.engineBus.gain.setTargetAtTime(0.42 * load * duck * (p.boosting ? 1.15 : 1), t, duck < 1 ? 0.015 : 0.05);

    const sq = p.grounded ? clamp((p.slip - 0.12) / 0.35, 0, 1) * clamp(p.speed / 12, 0, 1) : 0;
    this.screech?.gain.gain.setTargetAtTime(sq * (p.offroad ? 0.15 : 0.45), t, 0.06);
    if (this.screech) this.screech.src.playbackRate.setTargetAtTime(0.9 + sq * 0.2, t, 0.1);

    const sp = clamp(p.speed / 80, 0, 1.2);
    this.wind?.gain.gain.setTargetAtTime(sp * sp * 0.5 + (p.offroad ? 0.25 * clamp(p.speed / 20, 0, 1) : 0), t, 0.1);
    this.windFilter?.frequency.setTargetAtTime(300 + sp * 900 + (p.offroad ? 300 : 0), t, 0.1);
    this.rumble?.gain.gain.setTargetAtTime(p.boosting ? 1.6 : 0, t, p.boosting ? 0.05 : 0.25);
  }

  updateAI(i: number, rpm: number, distance: number, pan: number): void {
    const v = this.ai[i];
    if (!v) return;
    const t = this.ctx.currentTime;
    const g = clamp(1 - distance / 70, 0, 1);
    v.gain.gain.setTargetAtTime(g * g * 0.22, t, 0.08);
    v.src.playbackRate.setTargetAtTime(clamp(rpm / 4000, 0.4, 2.0), t, 0.05);
    v.pan?.pan.setTargetAtTime(clamp(pan, -1, 1) * 0.8, t, 0.08);
  }

  play(name: string, volume = 1, rate = 1): void {
    const buf = this.buffers[name];
    if (!buf || !this.started) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.sfx);
    src.start();
  }

  impact(dv: number): void {
    const now = this.ctx.currentTime;
    if (now - this.lastHit < 0.12 || dv < 1.2) return;
    this.lastHit = now;
    if (dv > 7) this.play('collision_heavy', clamp(dv / 18, 0.5, 1), 0.9 + Math.random() * 0.2);
    else this.play('collision_light', clamp(dv / 6, 0.25, 0.9), 0.9 + Math.random() * 0.25);
  }
}
