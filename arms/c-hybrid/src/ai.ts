/**
 * AI drivers: follow the manifest racing line (pure pursuit), brake for the speed profile ahead,
 * swerve around cars in front (they are real physics bodies — no ghosts), use nitro on straights.
 * Each driver has its own skill, line offset and rhythm so they don't drive as a train.
 */
import type { Track } from "./track.ts";
import type { Controls, CarState } from "./physics/vehicle.ts";
import type { Racer } from "./race.ts";

export interface Opponent { state: CarState; racer: Racer }

export class AIDriver {
  private laneTarget = 0;
  private lane = 0;
  private stuckTime = 0;
  private reverseTime = 0;
  private phase: number;
  /** extra nitro use knob (0..1) */
  readonly aggression: number;

  constructor(private readonly track: Track, public skill: number, seed: number) {
    this.phase = seed * 2.17;
    this.aggression = 0.3 + (seed % 3) * 0.25;
  }

  drive(me: CarState, racer: Racer, others: Opponent[], player: Racer | null, nitroCharge: number, dt: number, time: number): Controls {
    const t = this.track;
    const v = Math.max(0, me.speed);
    const i0 = racer.lineIndex;

    // rubber band, mild: beatable when you drive well, no free win when you don't
    let skill = this.skill;
    if (player !== null && !player.finished) {
      const gap = racer.progress - player.progress;   // + = AI ahead
      if (gap > 120) skill *= 1 - Math.min(0.07, (gap - 120) / 4000);
      else if (gap < -120) skill *= 1 + Math.min(0.06, (-gap - 120) / 4000);
    }

    // --- lane: personal offset that drifts slowly, plus avoidance of the car ahead
    const wander = Math.sin(time * 0.13 + this.phase) * 1.4;
    let avoid = 0;
    let blocked = false;
    for (const o of others) {
      if (o.state === me) continue;
      const dx = o.state.pos.x - me.pos.x, dz = o.state.pos.z - me.pos.z;
      const ahead = dx * me.forward.x + dz * me.forward.z;
      const side = dx * me.right.x + dz * me.right.z;
      if (ahead > 0 && ahead < 22 && Math.abs(side) < 3.2) {
        // pass on the side with more room (and away from the other car)
        const myLat = t.lateral(i0, me.pos.x, me.pos.z);
        const room = t.roadHalfWidth - 2.2;
        const dir = side > 0 ? -1 : 1;
        const target = myLat + dir * 3.5;
        avoid = Math.max(-room, Math.min(room, target)) - wander;
        if (o.state.speed < me.speed - 2 && ahead < 10) blocked = true;
      }
    }
    this.laneTarget = wander + avoid;
    this.lane += (this.laneTarget - this.lane) * Math.min(1, dt * 1.5);
    const laneClamped = Math.max(-(t.roadHalfWidth - 2), Math.min(t.roadHalfWidth - 2, this.lane));

    // --- steering: pure pursuit on the offset line
    const look = 3 + Math.floor(v * 0.11);
    const p = t.point(i0 + look);
    const dirL = t.direction(i0 + look);
    const tx = p.x + -dirL.z * laneClamped, tz = p.z + dirL.x * laneClamped;
    const dx = tx - me.pos.x, dz = tz - me.pos.z;
    const localX = dx * me.right.x + dz * me.right.z;
    const localZ = dx * me.forward.x + dz * me.forward.z;
    const angle = Math.atan2(localX, Math.max(0.1, localZ));
    let steer = Math.max(-1, Math.min(1, angle * 2.4));

    // --- speed: the slowest corner ahead, reachable with our braking
    const brakeDecel = 10.5;
    let target = Infinity;
    for (let k = 1; k < 34; k += 2) {
      const q = t.point(i0 + k);
      const dist = k * 5;
      const vq = q.speed * skill;
      const reach = Math.sqrt(vq * vq + 2 * brakeDecel * dist);
      if (reach < target) target = reach;
    }
    target = Math.min(target, t.point(i0).speed * skill + 3);
    if (blocked) target = Math.min(target, Math.max(10, v - 3));

    let throttle = 0, brake = 0;
    const err = target - v;
    if (err > 0) throttle = Math.min(1, 0.35 + err * 0.25);
    else if (err < -2.5) brake = Math.min(1, -err * 0.15);
    else throttle = 0.25;

    // nitro on straights when there is charge
    const straight = Math.abs(steer) < 0.12 && err > 15;
    const nitro = straight && nitroCharge > 0.25 && Math.sin(time * 0.31 + this.phase) > 0.4 - this.aggression;

    // --- stuck: back out
    if (v < 1.5 && Math.abs(me.speed) < 1.5 && time > 2) this.stuckTime += dt; else this.stuckTime = 0;
    if (this.stuckTime > 1.6) { this.reverseTime = 1.2; this.stuckTime = 0; }
    if (this.reverseTime > 0) {
      this.reverseTime -= dt;
      return { throttle: 0, brake: 1, steer: -steer, handbrake: false, nitro: false };
    }
    if (me.slipAngle > 0.6 || me.slipAngle < -0.6) steer *= 0.5;   // don't fight a spin
    return { throttle, brake, steer, handbrake: false, nitro };
  }
}
