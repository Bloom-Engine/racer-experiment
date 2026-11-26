/**
 * Race rules: checkpoints in order, laps, positions, lap times. Pure game logic over
 * positions — it never touches physics or rendering.
 *
 * A checkpoint counts when a car's path from the last frame to this one crosses the
 * checkpoint's plane in the race direction, inside its trigger box. Only the *next* expected
 * checkpoint counts, so skipping one (a shortcut) means the lap never completes.
 */
import type { Track, V3 } from "./track.ts";

export const LAPS = 3;

export interface Racer {
  name: string;
  isPlayer: boolean;
  /** next checkpoint index expected (0 = the start/finish line) */
  nextCp: number;
  started: boolean;        // crossed the start line once (standing start behind it)
  lap: number;             // current lap, 1-based (LAPS + 1 when finished)
  lapStart: number;
  lapTimes: number[];
  bestLap: number;
  finished: boolean;
  finishTime: number;
  finishPlace: number;
  lastCp: number;          // last checkpoint index passed (for resets)
  lineIndex: number;       // nearest racing-line point
  distance: number;        // metres along the lap (0..length)
  progress: number;        // total progress for ordering
  place: number;
  missedCpWarning: number; // time a wrong-way / skipped-checkpoint warning was raised
  prev: V3;
}

export function newRacer(name: string, isPlayer: boolean, pos: V3): Racer {
  return {
    name, isPlayer, nextCp: 0, started: false, lap: 1, lapStart: 0, lapTimes: [], bestLap: Infinity,
    finished: false, finishTime: 0, finishPlace: 0, lastCp: 0, lineIndex: 0, distance: 0, progress: 0, place: 1,
    missedCpWarning: -10, prev: { ...pos },
  };
}

export type RaceEvent =
  | { kind: "lap"; racer: Racer; time: number; best: boolean }
  | { kind: "finish"; racer: Racer }
  | { kind: "checkpoint"; racer: Racer; index: number }
  | { kind: "missed"; racer: Racer; index: number };

export class Race {
  readonly racers: Racer[] = [];
  time = 0;            // seconds since GO
  finishedCount = 0;

  constructor(private readonly track: Track) {}

  add(r: Racer): void { this.racers.push(r); }

  /** Did the segment a->b cross checkpoint i forwards, inside its box? */
  private crossed(i: number, a: V3, b: V3): boolean {
    const cp = this.track.checkpoints[i]!;
    const da = (a.x - cp.pos.x) * cp.fwd.x + (a.z - cp.pos.z) * cp.fwd.z;
    const db = (b.x - cp.pos.x) * cp.fwd.x + (b.z - cp.pos.z) * cp.fwd.z;
    if (!(da < 0 && db >= 0)) return false;
    const t = da / (da - db);
    const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, z = a.z + (b.z - a.z) * t;
    const across = (x - cp.pos.x) * cp.right.x + (z - cp.pos.z) * cp.right.z;
    const up = y - cp.pos.y;
    return Math.abs(across) <= cp.halfAcross && up > -2 && up < cp.height;
  }

  /** Update one racer with its new position; returns events. */
  updateRacer(r: Racer, pos: V3, events: RaceEvent[]): void {
    const n = this.track.checkpoints.length;
    if (!r.finished) {
      // the expected checkpoint
      if (this.crossed(r.nextCp, r.prev, pos)) {
        const idx = r.nextCp;
        r.lastCp = idx;
        if (idx === 0) {
          if (!r.started) { r.started = true; }
          else {
            const lapTime = this.time - r.lapStart;
            r.lapTimes.push(lapTime);
            const best = lapTime < r.bestLap;
            if (best) r.bestLap = lapTime;
            r.lapStart = this.time;
            events.push({ kind: "lap", racer: r, time: lapTime, best });
            r.lap++;
            if (r.lap > LAPS) {
              r.finished = true;
              r.finishTime = this.time;
              r.finishPlace = ++this.finishedCount;
              events.push({ kind: "finish", racer: r });
            }
          }
        } else events.push({ kind: "checkpoint", racer: r, index: idx });
        r.nextCp = (idx + 1) % n;
      } else {
        // crossing some other checkpoint out of order: shortcut or wrong way — doesn't count
        for (let i = 0; i < n; i++) {
          if (i === r.nextCp) continue;
          if (this.crossed(i, r.prev, pos) && i !== (r.nextCp + n - 1) % n && this.time - r.missedCpWarning > 2) {
            r.missedCpWarning = this.time;
            events.push({ kind: "missed", racer: r, index: r.nextCp });
            break;
          }
        }
      }
    }
    r.prev = { x: pos.x, y: pos.y, z: pos.z };

    // progress along the lap for positions
    r.lineIndex = this.track.nearest(pos.x, pos.z, r.lineIndex);
    let d = this.track.distanceAt(r.lineIndex, pos.x, pos.z);
    const L = this.track.length;
    // keep the distance consistent with checkpoint state around the start line
    if (!r.started && d > L / 2) d -= L;                 // on the grid, behind the line
    if (r.started && r.nextCp === 1 && d > L / 2) d -= L;     // just after the line, jitter
    if (r.started && r.nextCp === 0 && d < L / 2) d += L;     // just before completing the lap
    r.distance = d;
    const lapsDone = r.lap - 1;
    r.progress = r.finished ? 1e9 - r.finishPlace : lapsDone * L + d;
  }

  /** Recompute race positions (1 = leader). */
  rank(): void {
    const sorted = [...this.racers].sort((a, b) => b.progress - a.progress);
    for (let i = 0; i < sorted.length; i++) sorted[i]!.place = i + 1;
  }
}
