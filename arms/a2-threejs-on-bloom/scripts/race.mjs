// Full-race verification: autopilot player, simulated headlessly via debugAdvance.
import { launch } from './browser.mjs';
const diff = process.argv[2] ?? 'normal';
const skill = Number(process.argv[3] ?? 1);
const { browser, page, logs } = await launch({ url: 'http://localhost:5173/?autopilot' });
await page.evaluate((d) => localStorage.setItem('apexrush.v1.difficulty', d), diff);
await page.reload();
await page.waitForFunction(() => window.__game !== undefined);
const res = await page.evaluate(async (skill) => {
  const g = window.__game;
  g.autopilotAI.p.skill = skill;
  g.startRace();
  g.autopilotAI.difficulty = 1;
  const t0 = performance.now();
  const samples = [];
  for (let i = 0; i < 400 && !g.player.progress.finished; i++) {
    g.debugAdvance(1);
    if (i % 20 === 0) samples.push(g.debugState().cars.map((c) => `${c.name}:${c.place}/${c.lap}/${c.speed.toFixed(0)}`).join(' '));
  }
  g.debugAdvance(60, 1 / 60, () => g.cars.every((c) => c.progress.finished));
  return { wall: performance.now() - t0, state: g.debugState(), samples,
    laps: g.cars.map((c) => ({ n: c.name, laps: c.progress.lapTimes.map((t) => t.toFixed(2)), fin: c.progress.finishTime.toFixed(2), place: c.place, resets: c.resets, why: c.lastResetReason })) };
}, skill);
console.log(res.samples.join('\n'));
console.log(JSON.stringify(res.laps, null, 0));
console.log('wall ms', res.wall.toFixed(0), 'state', res.state.state);
console.log(logs.filter((l) => !l.includes('vite')).join('\n'));
await browser.close();
