// Procedural engine audio (run with `node tools/gen-audio.ts`).
//
// The asset set's engine_mid/high loops are near-pure harmonic tones with a
// flat envelope; pitched and crossfaded they read as one long drone. Bloom
// cannot play PCM generated at runtime (no sound-from-samples API), so we
// synthesise the loops here and write them to resources/audio/ (never into
// ./assets). Each loop is exactly 2.0 s and seamless: every periodic
// component completes whole cycles and all filtering is circular.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SR = 44100;
const LEN = SR * 2;

let seed = 12345;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

function writeWav(path: string, data: Float32Array): void {
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  const g = peak > 0 ? 0.89 / peak : 1;
  const buf = Buffer.alloc(44 + data.length * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + data.length * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(data.length * 2, 40);
  for (let i = 0; i < data.length; i++) {
    const v = Math.max(-1, Math.min(1, data[i] * g));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

/** Circular one-pole low-pass (run twice so the wrap-around settles). */
function lowpassCircular(x: Float32Array, cutoff: number): Float32Array {
  const a = 1 - Math.exp(-2 * Math.PI * cutoff / SR);
  const y = new Float32Array(x.length);
  let s = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < x.length; i++) { s += a * (x[i] - s); y[i] = s; }
  }
  return y;
}

/**
 * V8-style engine loop. rpm -> firing frequency = rpm/60 * 4 (8 cylinders,
 * 4-stroke). Each firing is a short damped "thump" through two exhaust
 * resonances; cylinders get fixed amplitude/timing offsets (the uneven
 * cross-plane burble), plus intake/mechanical noise.
 */
function engineLoop(rpm: number, brightness: number, roughness: number): Float32Array {
  const fireHz = rpm / 60 * 4;
  const events = Math.max(1, Math.round(fireHz * 2)); // whole number per 2 s loop
  const period = LEN / events;
  const out = new Float32Array(LEN);
  const cylAmp: number[] = [], cylJit: number[] = [];
  for (let c = 0; c < 8; c++) { cylAmp.push(0.7 + rnd() * 0.6); cylJit.push((rnd() - 0.5) * 0.18); }
  const res1 = 90 + brightness * 260, res2 = 420 + brightness * 1500;
  const decay1 = 0.010 + 0.02 * (1 - brightness), decay2 = 0.004;
  const respLen = Math.floor(SR * 0.06);
  for (let e = 0; e < events; e++) {
    const c = e % 8;
    const start = (e + cylJit[c] * roughness) * period;
    const amp = cylAmp[c] * (1 + (rnd() - 0.5) * 0.25 * roughness);
    for (let k = 0; k < respLen; k++) {
      const t = k / SR;
      const env = Math.exp(-t / decay1);
      let v = Math.sin(2 * Math.PI * res1 * t) * env;
      v += 0.55 * Math.sin(2 * Math.PI * res2 * t + 1.1) * Math.exp(-t / decay2);
      v += (rnd() * 2 - 1) * 0.35 * Math.exp(-t / 0.003); // combustion crack
      const idx = Math.floor(start + k) % LEN;
      out[(idx + LEN) % LEN] += v * amp;
    }
  }
  // low "body" at half firing order (crank rotation), whole cycles per loop
  const bodyHz = Math.round(fireHz / 2 * 2) / 2;
  for (let i = 0; i < LEN; i++) out[i] += 0.35 * Math.sin(2 * Math.PI * bodyHz * i / SR);
  // intake / mechanical noise, band-limited, amplitude-modulated by firing
  const noise = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) noise[i] = rnd() * 2 - 1;
  const lp = lowpassCircular(noise, 900 + brightness * 3500);
  const lp2 = lowpassCircular(noise, 200);
  for (let i = 0; i < LEN; i++) {
    const mod = 0.6 + 0.4 * Math.sin(2 * Math.PI * events / 2 * i / SR * 1);
    out[i] += (lp[i] - lp2[i]) * (0.25 + brightness * 0.35) * mod;
  }
  return lowpassCircular(out, 2500 + brightness * 6000);
}

/** Turbo blow-off / shift "pssh": filtered noise burst with falling cutoff. */
function shiftSound(): Float32Array {
  const n = Math.floor(SR * 0.35);
  const out = new Float32Array(n);
  let s = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const cutoff = 5000 * (1 - t) + 400;
    const a = 1 - Math.exp(-2 * Math.PI * cutoff / SR);
    s += a * ((rnd() * 2 - 1) - s);
    s2 += 0.02 * (s - s2);
    const env = Math.min(1, t * 40) * Math.pow(1 - t, 2.2);
    out[i] = (s - s2 * 0.8) * env;
  }
  return out;
}

const dir = join(root, "resources/audio");
mkdirSync(dir, { recursive: true });
writeWav(join(dir, "engine_low.wav"), engineLoop(900, 0.0, 1.0));
writeWav(join(dir, "engine_mid.wav"), engineLoop(4000, 0.5, 0.6));
writeWav(join(dir, "engine_high.wav"), engineLoop(7500, 1.0, 0.35));
writeWav(join(dir, "shift.wav"), shiftSound());
console.log("wrote resources/audio/{engine_low,engine_mid,engine_high,shift}.wav");
