// End-to-end on the production build: real-time lap fps, audio follows speed, finish screen, best-lap persistence.
import { launch } from './browser.mjs';
const out = process.argv[2];
const base = 'http://localhost:4173/';
const { browser, page, logs } = await launch({ url: `${base}?debug&autopilot&fps` });
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForFunction(() => window.__game !== undefined);
await page.click('#btn-start');
await page.waitForFunction(() => window.__game.state === 'racing');
await page.evaluate(() => window.__game.quality.resetStats());
const audio = [];
for (let i = 0; i < 400; i++) {
  await page.waitForTimeout(500);
  const s = await page.evaluate(() => {
    const g = window.__game; const v = g.player.vehicle; const e = g.audio.engine;
    return { lap: g.player.progress.lap, kmh: Math.round(v.speed * 3.6), gear: v.gear, rpm: Math.round(v.rpm),
      rates: e.map((l) => +l.src.playbackRate.value.toFixed(2)), gains: e.map((l) => +l.gain.gain.value.toFixed(2)), ctx: g.audio.ctx.state };
  });
  if (i % 6 === 0) audio.push(s);
  if (s.lap >= 1) break;
}
const perf = await page.evaluate(() => ({ avgFps: window.__game.quality.averageFps, worst2sWindow: window.__game.quality.worstWindowFps, scale: window.__game.quality.ratio, calls: window.__game.renderer.info.render.calls }));
await page.evaluate(() => { const g = window.__game; g.debugAdvance(400, 1 / 60, () => g.player.progress.finished); });
await page.waitForTimeout(3500);
await page.screenshot({ path: `${out}/finish.png` });
const fin = await page.evaluate(() => ({ screen: window.__game.screens.active, title: document.getElementById('finish-title').textContent, rows: [...document.querySelectorAll('#results-body tr')].map((r) => r.textContent), stored: localStorage.getItem('apexrush.v1.bestLap'), laps: window.__game.player.progress.lapTimes }));
await page.goto(base);
await page.waitForTimeout(2500);
const persisted = await page.evaluate(() => document.getElementById('start-best').textContent);
console.log(JSON.stringify({ perf, audio, fin, persisted }, null, 1));
console.log(logs.join('\n'));
await browser.close();
