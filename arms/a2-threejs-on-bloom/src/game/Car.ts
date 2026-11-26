import { Vehicle, emptyControls, type Controls } from '../physics/Vehicle';
import type { AIDriver } from '../ai/AIDriver';
import { CarVisual } from './CarVisual';
import { RaceProgress } from './RaceProgress';

/** One race participant: physics + visuals + race bookkeeping + (optional) AI brain. */
export class Car {
  readonly vehicle = new Vehicle();
  readonly progress = new RaceProgress();
  controls: Controls = emptyControls();
  offTrackTime = 0;
  upsideTime = 0;
  stuckTime = 0;
  drafting = false;
  resets = 0;
  lastResetReason = '';
  /** live position (1-based) */
  place = 1;

  constructor(
    readonly id: number,
    readonly name: string,
    readonly colorCss: string,
    readonly isPlayer: boolean,
    readonly visual: CarVisual,
    public ai: AIDriver | null,
  ) {}
}
