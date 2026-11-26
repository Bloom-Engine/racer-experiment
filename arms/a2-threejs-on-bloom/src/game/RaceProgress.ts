import * as THREE from 'three';
import { RACE } from '../core/config';
import type { Projection, Track } from '../track/Track';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export type ProgressEvent = 'none' | 'start' | 'checkpoint' | 'lap' | 'finish';

/**
 * Lap / checkpoint bookkeeping for one car. A checkpoint only counts when it is the
 * next one in order and its gate plane is crossed in the race direction inside the
 * trigger box. A lap counts when cp_01..cp_15 were passed and cp_00 is crossed.
 */
export class RaceProgress {
  nextCp = 0;
  cpCount = 0;
  lastCp = -1;
  lap = 0; // completed laps
  lapStart = 0;
  lapTimes: number[] = [];
  finished = false;
  finishTime = 0;
  finishPlace = 0;
  readonly proj: Projection = { index: -1, s: 0, lateral: 0, dist: 0 };
  /** continuous race distance in metres (for gaps / rubber-banding) */
  distance = 0;
  /** monotonic ordering key for live positions */
  rankKey = 0;
  wrongWayTime = 0;

  reset(): void {
    this.nextCp = 0;
    this.cpCount = 0;
    this.lastCp = -1;
    this.lap = 0;
    this.lapStart = 0;
    this.lapTimes = [];
    this.finished = false;
    this.finishTime = 0;
    this.finishPlace = 0;
    this.proj.index = -1;
    this.distance = 0;
    this.rankKey = 0;
    this.wrongWayTime = 0;
  }

  get bestLap(): number | null {
    return this.lapTimes.length ? Math.min(...this.lapTimes) : null;
  }

  get currentLapDisplay(): number {
    return Math.min(RACE.laps, this.lap + 1);
  }

  /** Test the gate of the next checkpoint against the movement prev -> cur. */
  checkGate(track: Track, prev: THREE.Vector3, cur: THREE.Vector3, time: number): ProgressEvent {
    if (this.finished) return 'none';
    const cp = track.checkpoints[this.nextCp];
    _a.copy(prev).applyMatrix4(cp.inv);
    _b.copy(cur).applyMatrix4(cp.inv);
    // race direction is local -Z: crossing means z goes from + to -
    if (!(_a.z > 0 && _b.z <= 0)) return 'none';
    const t = _a.z / (_a.z - _b.z);
    const x = _a.x + (_b.x - _a.x) * t;
    const y = _a.y + (_b.y - _a.y) * t;
    if (Math.abs(x) > cp.halfAcross || y < -3 || y > cp.height + 2) return 'none';

    let ev: ProgressEvent = 'checkpoint';
    if (cp.index === 0) {
      if (this.cpCount === 0) {
        ev = 'start';
      } else {
        this.lapTimes.push(time - this.lapStart);
        this.lapStart = time;
        this.lap++;
        ev = 'lap';
        if (this.lap >= RACE.laps) {
          this.finished = true;
          this.finishTime = time;
          ev = 'finish';
        }
      }
    }
    this.cpCount++;
    this.lastCp = cp.index;
    this.nextCp = (cp.index + 1) % track.checkpoints.length;
    return ev;
  }

  updateMetrics(track: Track, x: number, z: number): void {
    track.project(x, z, this.proj.index, this.proj);
    const L = track.length;
    const s0 = track.checkpoints[0].s;
    const next = track.checkpoints[this.nextCp];
    this.rankKey = this.cpCount * 1e4 - track.ahead(this.proj.s, next.s);
    let along = track.ahead(s0, this.proj.s);
    if (this.cpCount === 0 || (this.nextCp === 1 && along > L * 0.5)) along -= L;
    if (this.nextCp === 0 && this.cpCount > 0 && along < L * 0.5) along += L;
    this.distance = this.lap * L + along;
  }
}
