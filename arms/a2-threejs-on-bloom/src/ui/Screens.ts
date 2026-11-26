import { formatTime } from '../core/math';

export type ScreenName = 'loading' | 'start' | 'pause' | 'finish' | 'none';

export interface ResultRow {
  name: string;
  color: string;
  isPlayer: boolean;
  finished: boolean;
  totalTime: number;
  bestLap: number | null;
  lapsDone: number;
}

const ORD = ['1ST', '2ND', '3RD', '4TH'];
export const ordinal = (n: number): string => ORD[n - 1] ?? `${n}TH`;

/** Menu / pause / results overlays. */
export class Screens {
  private current: ScreenName = 'loading';
  private readonly els: Record<Exclude<ScreenName, 'none'>, HTMLElement>;

  constructor() {
    const q = (id: string) => document.getElementById(id) as HTMLElement;
    this.els = {
      loading: q('screen-loading'),
      start: q('screen-start'),
      pause: q('screen-pause'),
      finish: q('screen-finish'),
    };
  }

  get active(): ScreenName {
    return this.current;
  }

  show(name: ScreenName): void {
    this.current = name;
    for (const [k, el] of Object.entries(this.els)) el.classList.toggle('show', k === name);
  }

  setLoading(f: number, text?: string): void {
    (document.getElementById('load-fill') as HTMLElement).style.width = `${Math.round(f * 100)}%`;
    if (text) (document.getElementById('load-text') as HTMLElement).textContent = text;
  }

  setStartBest(t: number | null): void {
    (document.getElementById('start-best') as HTMLElement).textContent = formatTime(t);
  }

  setMuteLabel(muted: boolean): void {
    (document.getElementById('btn-mute') as HTMLElement).textContent = muted ? 'SOUND: OFF' : 'SOUND: ON';
  }

  renderResults(rows: ResultRow[], playerPlace: number, badge: string, playerLaps: number[]): void {
    const title = document.getElementById('finish-title') as HTMLElement;
    title.textContent = playerPlace === 1 ? 'YOU WIN!' : `${ordinal(playerPlace)} PLACE`;
    (document.getElementById('finish-badge') as HTMLElement).textContent = badge;
    const leader = rows.find((r) => r.finished)?.totalTime ?? 0;
    const body = document.getElementById('results-body') as HTMLElement;
    body.innerHTML = '';
    rows.forEach((r, i) => {
      const tr = document.createElement('tr');
      if (r.isPlayer) tr.className = 'me';
      const time = r.finished
        ? i === 0
          ? formatTime(r.totalTime)
          : `+${(r.totalTime - leader).toFixed(3)}`
        : `RACING · LAP ${Math.min(3, r.lapsDone + 1)}`;
      const cells = [
        String(i + 1),
        `<span class="swatch" style="background:${r.color}"></span>${r.name}`,
        time,
        formatTime(r.bestLap),
      ];
      tr.innerHTML = cells.map((c) => `<td>${c}</td>`).join('');
      body.appendChild(tr);
    });
    (document.getElementById('finish-laps') as HTMLElement).textContent = playerLaps
      .map((t, i) => `L${i + 1} ${formatTime(t)}`)
      .join('   ');
  }
}
