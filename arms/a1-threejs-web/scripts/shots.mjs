// Visual capture of key moments (real-time rendering).
import { launch } from './browser.mjs';
const out = process.argv[2];
const { browser, page, logs } = await launch({ url: 'http://localhost:5173/?fps' });
await page.click('#btn-start');
await page.waitForTimeout(3300);
const set = (c) => page.evaluate((c) => { window.__game.debugControls = c; }, c);
await set({ throttle: 1, brake: 0, steer: 0, handbrake: false, nitro: false });
await page.waitForTimeout(3500);
// nitro
await page.evaluate(() => { window.__game.player.vehicle.nitro = 1; });
await set({ throttle: 1, brake: 0, steer: 0, handbrake: false, nitro: true });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/nitro.png` });
await set({ throttle: 1, brake: 0, steer: 0, handbrake: false, nitro: false });
await page.waitForTimeout(800);
// drift
await set({ throttle: 1, brake: 0, steer: 1, handbrake: true, nitro: false });
await page.waitForTimeout(350);
await set({ throttle: 1, brake: 0, steer: 0.7, handbrake: false, nitro: false });
await page.waitForTimeout(700);
await page.screenshot({ path: `${out}/drift.png` });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/after-drift.png` });
// hood cam
await page.keyboard.press('KeyC');
await set({ throttle: 1, brake: 0, steer: 0, handbrake: false, nitro: false });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/hood.png` });
await page.keyboard.press('KeyC');
console.log(JSON.stringify(await page.evaluate(() => window.__game.debugState().cars[0])));
console.log(logs.filter((l) => !l.includes('vite')).join('\n'));
await browser.close();
