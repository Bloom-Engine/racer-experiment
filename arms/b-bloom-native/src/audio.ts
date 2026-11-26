// Audio: RPM-driven 3-layer engine (idle/mid/high loops pitched by
// rpm/base_rpm and crossfaded), gear-shift dip, tyre screech, nitro, impacts,
// countdown and finish. AI engines are spatial voices.
import { Sound } from "bloom/core";
import {
  initAudio, loadSound, playSoundEx, playSound, setMasterVolume,
  voiceSetVolume, voiceSetPitch, voiceSetPosition, playSound3DEx, setListenerPosition,
  setSoundVolume,
} from "bloom/audio";
import { Car } from "./vehicle";
import { dataPath } from "./paths";
import { clampN, lerpN } from "./util/math3d";

const BASE_RPM: number[] = [900, 4000, 7500];

let sIdle: Sound = { handle: 0 };
let sMid: Sound = { handle: 0 };
let sHigh: Sound = { handle: 0 };
let sScreech: Sound = { handle: 0 };
let sNitro: Sound = { handle: 0 };
let sHitLight: Sound = { handle: 0 };
let sHitHeavy: Sound = { handle: 0 };
let sBeepShort: Sound = { handle: 0 };
let sBeepLong: Sound = { handle: 0 };
let sFanfare: Sound = { handle: 0 };
let sShift: Sound = { handle: 0 };

const engVoice: number[] = [0, 0, 0];
let screechVoice = 0;
const aiVoice: number[] = [];
let started = false;
let shiftDip = 0;
let lastShiftCount = 0;
let hitCooldown = 0;
let wasNitro = false;
let muted = false;

export function initGameAudio(): void {
  initAudio();
  setMasterVolume(0.9);
  // WAVs: the loops are sample-exact (Ogg encoders may pad).
  // Engine loops are procedural (tools/gen-audio.ts): the asset loops are
  // near-pure tones that read as a single drone when crossfaded.
  sIdle = loadSound(dataPath("audio/engine_low.wav"));
  sMid = loadSound(dataPath("audio/engine_mid.wav"));
  sHigh = loadSound(dataPath("audio/engine_high.wav"));
  sShift = loadSound(dataPath("audio/shift.wav"));
  sScreech = loadSound("assets/audio/tyre_screech_loop.wav");
  sNitro = loadSound("assets/audio/nitro_whoosh.wav");
  sHitLight = loadSound("assets/audio/collision_light.wav");
  sHitHeavy = loadSound("assets/audio/collision_heavy.wav");
  sBeepShort = loadSound("assets/audio/beep_short.wav");
  sBeepLong = loadSound("assets/audio/beep_long.wav");
  sFanfare = loadSound("assets/audio/finish_fanfare.wav");
  setSoundVolume(sNitro, 0.8);
  console.log("audio handles: engine " + sIdle.handle + "/" + sMid.handle + "/" + sHigh.handle +
    " shift " + sShift.handle + " screech " + sScreech.handle + " nitro " + sNitro.handle +
    " hits " + sHitLight.handle + "/" + sHitHeavy.handle + " beeps " + sBeepShort.handle + "/" + sBeepLong.handle +
    " fanfare " + sFanfare.handle);
}

/** Start the looping voices (call when the race scene starts). */
export function startEngines(cars: Car[]): void {
  if (started) return;
  started = true;
  engVoice[0] = playSoundEx(sIdle, true, 0, 1, 0);
  engVoice[1] = playSoundEx(sMid, true, 0, 1, 0);
  engVoice[2] = playSoundEx(sHigh, true, 0, 1, 0);
  screechVoice = playSoundEx(sScreech, true, 0, 1, 0);
  for (let i = 0; i < cars.length; i++) {
    if (cars[i].isPlayer) { aiVoice.push(0); continue; }
    const p = cars[i].pos;
    aiVoice.push(playSound3DEx(sMid, p.x, p.y, p.z, true, 6, 120, 1.0));
  }
}

export function setMuted(m: boolean): void {
  muted = m;
  setMasterVolume(m ? 0 : 0.9);
}
export function isMuted(): boolean { return muted; }

export function beepShort(): void { playSound(sBeepShort); }
export function beepLong(): void { playSound(sBeepLong); }
export function fanfare(): void { playSound(sFanfare); }

/** Per-frame audio update. `active` = false silences engines (menus/pause). */
export function updateAudio(cars: Car[], camX: number, camY: number, camZ: number,
  fwdX: number, fwdY: number, fwdZ: number, active: boolean, dt: number): void {
  if (!started) return;
  setListenerPosition(camX, camY, camZ, fwdX, fwdY, fwdZ);
  const p = cars[0];
  hitCooldown -= dt;

  // ---- player engine: crossfade 3 layers by rpm ----
  if (p.shiftCount !== lastShiftCount) {
    lastShiftCount = p.shiftCount;
    shiftDip = 1;
    if (active) playSoundEx(sShift, false, 0.5, 0.9 + Math.random() * 0.2, 0);
  }
  shiftDip = Math.max(0, shiftDip - dt * 6);
  const rpm = p.rpm;
  const load = clampN(0.55 + p.input.throttle * 0.45, 0, 1);
  // weights: triangular crossfade between neighbouring base rpms
  let wIdle = 0, wMid = 0, wHigh = 0;
  if (rpm <= BASE_RPM[1]) {
    const t = clampN((rpm - BASE_RPM[0]) / (BASE_RPM[1] - BASE_RPM[0]), 0, 1);
    wIdle = 1 - t; wMid = t;
  } else {
    const t = clampN((rpm - BASE_RPM[1]) / (BASE_RPM[2] - BASE_RPM[1]), 0, 1);
    wMid = 1 - t; wHigh = t;
  }
  let master = 0.75 * load * (1 - shiftDip * 0.45);
  if (!active) master = 0;
  if (p.nitroActive) master *= 1.15;
  voiceSetVolume(engVoice[0], Math.sqrt(wIdle) * master);
  voiceSetVolume(engVoice[1], Math.sqrt(wMid) * master);
  voiceSetVolume(engVoice[2], Math.sqrt(wHigh) * master);
  voiceSetPitch(engVoice[0], clampN(rpm / BASE_RPM[0], 0.5, 2.5));
  voiceSetPitch(engVoice[1], clampN(rpm / BASE_RPM[1], 0.5, 2.0));
  voiceSetPitch(engVoice[2], clampN(rpm / BASE_RPM[2], 0.5, 1.6));

  // ---- tyre screech ----
  let screech = 0;
  if (p.grounded >= 2) {
    screech = p.driftAmount;
    if (p.input.handbrake && Math.abs(p.speed) > 8) screech = Math.max(screech, 0.6);
    if (p.braking && Math.abs(p.speed) > 25 && p.input.brake > 0.8) screech = Math.max(screech, 0.35);
  }
  if (!active) screech = 0;
  voiceSetVolume(screechVoice, screech * 0.55);
  voiceSetPitch(screechVoice, 0.9 + screech * 0.2);

  // ---- nitro whoosh on activation ----
  if (active && p.nitroActive && !wasNitro) playSound(sNitro);
  wasNitro = p.nitroActive;

  // ---- impacts (any car near the listener) ----
  if (active && hitCooldown <= 0) {
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (c.impact <= 0) continue;
      const dx = c.pos.x - camX, dz = c.pos.z - camZ;
      if (dx * dx + dz * dz > 60 * 60) continue;
      if (c.impact > 7) playSound(sHitHeavy);
      else playSound(sHitLight);
      hitCooldown = 0.18;
      break;
    }
  }

  // ---- AI engines (spatial) ----
  for (let i = 0; i < cars.length; i++) {
    const v = aiVoice[i];
    if (v === 0) continue;
    const c = cars[i];
    voiceSetPosition(v, c.pos.x, c.pos.y + 0.5, c.pos.z);
    voiceSetPitch(v, clampN(lerpN(0.6, 1.9, c.rpm / 7600), 0.5, 2));
    voiceSetVolume(v, active ? 0.55 : 0);
  }
}
