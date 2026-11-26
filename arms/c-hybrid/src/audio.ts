/**
 * Sound through Bloom's mixer (no Web Audio): the player's engine is three looping layers
 * (idle/mid/high) pitched by rpm / base_rpm and crossfaded; opponents get one 3D engine voice
 * each; tyre screech follows the slide; one-shots for impacts, nitro, countdown and finish.
 */
import {
  initAudio, loadSound, playSound, setSoundVolume, setMasterVolume, setListenerPosition,
  playSoundEx, playSound3DEx, voiceSetPitch, voiceSetVolume, voiceSetPosition, voiceStop,
} from "@bloomengine/engine/audio";
import type { Sound } from "@bloomengine/engine";
import { asset } from "./paths.ts";

interface Layer { sound: Sound; base: number; voice: number }

const LAYERS: [string, number][] = [["engine_idle", 900], ["engine_mid", 4000], ["engine_high", 7500]];

function load(name: string): Sound { return loadSound(asset("audio/" + name + ".wav")); }

export class Audio {
  private layers: Layer[] = [];
  private screech: Sound;
  private screechVoice = 0;
  private opponentEngine: Sound;
  private opponentVoices: number[] = [];
  private readonly sfx: Record<string, Sound> = {};
  private running = false;
  private lastGearShift = 0;
  private shiftDip = 0;
  private lastGear = 1;
  muted = false;

  constructor() {
    initAudio();
    setMasterVolume(0.9);
    for (const [name, base] of LAYERS) this.layers.push({ sound: load(name), base, voice: 0 });
    this.screech = load("tyre_screech_loop");
    this.opponentEngine = load("engine_mid");
    for (const n of ["collision_light", "collision_heavy", "nitro_whoosh", "beep_short", "beep_long", "finish_fanfare"]) {
      this.sfx[n] = load(n);
    }
  }

  /** Start the looping voices (race start / restart). */
  startEngines(opponents: number): void {
    this.stopEngines();
    for (const l of this.layers) l.voice = playSoundEx(l.sound, true, 0, 1, 0);
    this.screechVoice = playSoundEx(this.screech, true, 0, 1, 0);
    for (let i = 0; i < opponents; i++) this.opponentVoices.push(playSound3DEx(this.opponentEngine, 0, 0, 0, true, 8, 250, 1));
    this.running = true;
  }

  stopEngines(): void {
    for (const l of this.layers) { voiceStop(l.voice); l.voice = 0; }
    voiceStop(this.screechVoice); this.screechVoice = 0;
    for (const v of this.opponentVoices) voiceStop(v);
    this.opponentVoices = [];
    this.running = false;
  }

  /** Pause: silence the loops without losing them. */
  setPaused(p: boolean): void {
    if (!p) return;
    for (const l of this.layers) voiceSetVolume(l.voice, 0);
    voiceSetVolume(this.screechVoice, 0);
    for (const v of this.opponentVoices) voiceSetVolume(v, 0);
  }

  /**
   * Per frame. rpm from the Jolt engine, throttle 0..1, slide 0..1 (tyre screech), gear
   * (a change dips the engine for a moment: the shift you hear).
   */
  updatePlayer(rpm: number, throttle: number, slide: number, gear: number, time: number, nitro: boolean): void {
    if (!this.running) return;
    if (gear !== this.lastGear) {
      if (gear > this.lastGear && gear > 1 && time - this.lastGearShift > 0.25) this.shiftDip = 1;
      this.lastGear = gear; this.lastGearShift = time;
    }
    this.shiftDip = Math.max(0, this.shiftDip - 0.08);
    // our rpm range 1000..6000 maps onto the samples' 900..7500 range
    const r = 900 + (Math.max(1000, Math.min(6500, rpm)) - 1000) * (6600 / 5500) * (nitro ? 1.05 : 1);
    const loud = (0.45 + 0.55 * throttle) * (1 - 0.45 * this.shiftDip);
    for (let i = 0; i < this.layers.length; i++) {
      const l = this.layers[i]!;
      // triangular crossfade between neighbouring layers in log-rpm
      const lr = Math.log(r), lb = Math.log(l.base);
      const prev = i > 0 ? Math.log(this.layers[i - 1]!.base) : lb - 1;
      const next = i < this.layers.length - 1 ? Math.log(this.layers[i + 1]!.base) : lb + 1;
      let w = 0;
      if (lr <= lb) w = i === 0 ? 1 : Math.max(0, (lr - prev) / (lb - prev));
      else w = i === this.layers.length - 1 ? 1 : Math.max(0, (next - lr) / (next - lb));
      voiceSetVolume(l.voice, this.muted ? 0 : w * loud * 0.7);
      voiceSetPitch(l.voice, Math.max(0.5, Math.min(2.2, r / l.base)));
    }
    voiceSetVolume(this.screechVoice, this.muted ? 0 : Math.min(1, slide) * 0.55);
    voiceSetPitch(this.screechVoice, 0.9 + slide * 0.2);
  }

  updateOpponent(i: number, x: number, y: number, z: number, rpm: number): void {
    const v = this.opponentVoices[i];
    if (v === undefined) return;
    voiceSetPosition(v, x, y, z);
    voiceSetPitch(v, Math.max(0.5, Math.min(2, (900 + (rpm - 1000) * 1.2) / 4000)));
    voiceSetVolume(v, this.muted ? 0 : 0.8);
  }

  listener(x: number, y: number, z: number, fx: number, fy: number, fz: number): void {
    setListenerPosition(x, y, z, fx, fy, fz);
  }

  play(name: "collision_light" | "collision_heavy" | "nitro_whoosh" | "beep_short" | "beep_long" | "finish_fanfare", volume = 1): void {
    const s = this.sfx[name];
    if (s === undefined || this.muted) return;
    setSoundVolume(s, volume);
    playSound(s);
  }
}
