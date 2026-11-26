import * as THREE from 'three';
import { CAR, KMH, NITRO } from '../core/config';
import { clamp, damp, rng } from '../core/math';
import { emptyControls, type Controls } from '../physics/Vehicle';
import type { Track } from '../track/Track';
import type { Car } from '../game/Car';

const _target = new THREE.Vector3();

export interface Personality {
  /** fraction of the racing-line speed profile the driver targets */
  skill: number;
  /** preferred lateral offset from the racing line (m, + = left) */
  lane: number;
  /** 0 = polite (lifts behind cars), 1 = will lean on you */
  aggression: number;
  /** how eagerly nitro is used on straights (0..1) */
  nitroEagerness: number;
  seed: number;
}

/**
 * Racing-line follower. Produces the same Controls a human would, so AI cars obey
 * exactly the same physics (no cheating, no ghosting). Pure-pursuit steering on a
 * lane-offset copy of the racing line, braking-aware speed targets from the line's
 * speed profile, simple overtaking / blocking awareness, nitro on straights and
 * mild rubber-banding so races stay close.
 */
export class AIDriver {
  readonly controls: Controls = emptyControls();
  private lane = 0;
  private t = 0;
  private stuck = 0;
  private reverse = 0;
  private nitroHold = 0;
  private wobble = 0;
  private readonly rand: () => number;
  /** set by the game every frame: + means this AI is ahead of the player (m) */
  gapToPlayer = 0;
  /** global difficulty multiplier (set by the game) */
  difficulty = 1;

  constructor(readonly p: Personality) {
    this.rand = rng(p.seed);
    this.t = this.rand() * 100;
    this.lane = p.lane;
  }

  update(dt: number, me: Car, cars: Car[], track: Track): Controls {
    const c = this.controls;
    const v = me.vehicle;
    const pr = me.progress.proj;
    this.t += dt;
    const speed = v.speed;
    const L = track.length;

    // ---------------------------------------------------------------- base target speed
    const rubber =
      this.gapToPlayer > 0
        ? 1 - clamp((this.gapToPlayer - 30) / 300, 0, 0.07)
        : 1 + clamp((-this.gapToPlayer - 40) / 400, 0, 0.045);
    this.wobble = Math.sin(this.t * 0.21 + this.p.seed) * 0.012 + Math.sin(this.t * 0.07 + this.p.seed * 3) * 0.01;
    const skill = this.p.skill * this.difficulty * rubber * (1 + this.wobble);
    const aBrake = 13.5;
    let target = Infinity;
    let straight = Infinity;
    const i0 = pr.index;
    for (let k = 1; k < 40; k++) {
      const j = (i0 + k) % track.n;
      const d = track.ahead(pr.s, track.ls[j]);
      const vj = track.lspeed[j] * skill;
      const allowed = Math.sqrt(vj * vj + 2 * aBrake * d);
      if (allowed < target) target = allowed;
      if (k < 30 && track.lspeed[j] < straight) straight = track.lspeed[j];
    }
    const vHere = track.lspeed[i0] * skill;
    target = Math.min(target, vHere + 6);

    // ---------------------------------------------------------------- lane choice & traffic
    let desired =
      this.p.lane + Math.sin(this.t * 0.11 + this.p.seed) * 1.0 + Math.sin(this.t * 0.043 + this.p.seed * 2) * 0.6;
    for (const o of cars) {
      if (o === me) continue;
      let gap = track.ahead(pr.s, o.progress.proj.s);
      if (gap > L / 2) gap -= L;
      const oLat = o.progress.proj.lateral;
      const closing = v.forwardSpeed - o.vehicle.forwardSpeed;
      if (gap > 0 && gap < 32) {
        const latDiff = oLat - pr.lateral;
        if (Math.abs(latDiff) < 2.8 && closing > -2) {
          // pick the side with more room around the car ahead
          const idx = o.progress.proj.index;
          const roomL = track.roomLeft[idx] - 1.4 - oLat;
          const roomR = track.roomRight[idx] - 1.4 + oLat;
          const goLeft = roomL > roomR ? roomL > 2.6 : !(roomR > 2.6);
          desired = oLat + (goLeft ? 3.2 : -3.2);
        }
        // don't rear-end slower cars (aggressive drivers cut it finer)
        const sameLane = Math.abs(latDiff) < 2.1;
        const margin = 6 + closing * (0.9 - this.p.aggression * 0.5);
        if (sameLane && closing > 0 && gap < margin) {
          target = Math.min(target, o.vehicle.forwardSpeed - 0.5 + this.p.aggression * 2);
        }
      }
    }

    // ---------------------------------------------------------------- steering (pure pursuit)
    const ld = clamp(7 + speed * 0.42, 9, 38);
    const sT = pr.s + ld;
    const it = track.indexAt(sT);
    const maxL = Math.max(0, track.roomLeft[it] - 1.5);
    const maxR = Math.max(0, track.roomRight[it] - 1.5);
    desired = clamp(desired, -maxR, maxL);
    this.lane += (desired - this.lane) * damp(1.4, dt);
    this.lane = clamp(this.lane, -maxR, maxL);
    const tgt = track.pointAt(sT, this.lane, _target);
    const dx = tgt.x - v.pos.x;
    const dz = tgt.z - v.pos.z;
    const fx = v.fx;
    const fz = v.fz;
    const fwd = dx * fx + dz * fz;
    const left = -(dx * -fz + dz * fx); // right = (-fz, fx)
    const alpha = Math.atan2(left, Math.max(0.1, fwd));
    const curvature = (2 * Math.sin(alpha)) / Math.max(4, Math.hypot(dx, dz));
    const steerAngle = Math.atan(curvature * CAR.wheelbase);
    const maxSteer = CAR.minSteer + (CAR.maxSteerLow - CAR.minSteer) / (1 + speed / CAR.steerFalloff);
    let steer = clamp(steerAngle / maxSteer, -1, 1);

    // corners are tighter on the inside lane
    const kc = track.lcurv[it];
    if (Math.abs(kc) > 0.002) {
      const R = 1 / Math.abs(kc);
      const Rp = R - this.lane * Math.sign(kc);
      target *= Math.sqrt(clamp(Rp / R, 0.55, 1.15));
    }

    // ---------------------------------------------------------------- throttle / brake
    const err = target - v.forwardSpeed;
    let throttle = 0;
    let brake = 0;
    if (err > 0) throttle = clamp(0.35 + err * 0.5, 0, 1);
    else if (err < -1.2) brake = clamp(-err * 0.18, 0, 1);
    else throttle = 0.15;

    // ---------------------------------------------------------------- nitro
    v.nitro = Math.min(1, v.nitro + NITRO.aiPassiveFill * dt);
    if (this.nitroHold > 0) this.nitroHold -= dt;
    else if (
      v.nitro > 0.45 &&
      straight > 185 * KMH &&
      speed > 90 * KMH &&
      Math.abs(steer) < 0.4 &&
      this.rand() < dt * (0.4 + this.p.nitroEagerness * 1.5) * (this.gapToPlayer < 0 ? 2 : 1)
    ) {
      this.nitroHold = 1.2 + this.rand() * 1.8;
    }
    const nitro = this.nitroHold > 0 && straight > 150 * KMH && v.nitro > 0;

    // ---------------------------------------------------------------- unstick
    if (speed < 1.5 && throttle > 0.3 && this.reverse <= 0) {
      this.stuck += dt;
      if (this.stuck > 1.2) {
        this.reverse = 1.3;
        this.stuck = 0;
      }
    } else if (speed > 4) this.stuck = 0;
    if (this.reverse > 0) {
      this.reverse -= dt;
      throttle = 0;
      brake = 1;
      steer = -steer;
    }

    c.throttle = throttle;
    c.brake = brake;
    c.steer = steer;
    c.handbrake = false;
    c.nitro = nitro && this.reverse <= 0;
    return c;
  }
}
