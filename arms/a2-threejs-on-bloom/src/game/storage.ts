// Tiny localStorage wrapper. Every access is guarded: private mode / blocked storage must not break the game.
const PREFIX = 'apexrush.v1.';

function get(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}
function set(key: string, value: string): void {
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch {
    /* ignore */
  }
}

export type Difficulty = 'easy' | 'normal' | 'hard';

export const storage = {
  bestLap(): number | null {
    const v = Number(get('bestLap'));
    return v > 0 && isFinite(v) ? v : null;
  },
  /** Returns true if `t` is a new all-time record (and stores it). */
  submitLap(t: number): boolean {
    const best = this.bestLap();
    if (best === null || t < best) {
      set('bestLap', t.toFixed(4));
      return true;
    }
    return false;
  },
  difficulty(): Difficulty {
    const d = get('difficulty');
    return d === 'easy' || d === 'hard' ? d : 'normal';
  },
  setDifficulty(d: Difficulty): void {
    set('difficulty', d);
  },
};
