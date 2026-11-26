// Phone check: iPhone-12-sized landscape viewport, touch UI, real multi-touch via CDP.
import { launch } from './browser.mjs';
const out = process.argv[2];
const { browser, context, page, logs } = await launch({ width: 844, height: 390, mobile: true });
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/m-start.png` });
await page.tap('#btn-start');
await page.waitForTimeout(3400);
const cdp = await context.newCDPSession(page);
const center = async (sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, sel);
const L = await center('[data-touch="left"]');
const N = await center('[data-touch="nitro"]');
const B = await center('[data-touch="brake"]');
// no input: auto-accelerate
await page.waitForTimeout(1500);
const auto = await page.evaluate(() => ({ kmh: window.__game.player.vehicle.speed * 3.6, thr: window.__game.player.controls.throttle }));
// two fingers: steer left + nitro
await page.evaluate(() => { window.__game.player.vehicle.nitro = 1; });
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: L.x, y: L.y, id: 1 }] });
await page.waitForTimeout(150);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: L.x, y: L.y, id: 1 }, { x: N.x, y: N.y, id: 2 }] });
await page.waitForTimeout(500);
const both = await page.evaluate(() => { const g = window.__game; return { steer: g.player.controls.steer, nitro: g.player.controls.nitro, boosting: g.player.vehicle.boosting }; });
await page.screenshot({ path: `${out}/m-multitouch.png` });
// lift only the steering finger: nitro must stay
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: N.x, y: N.y, id: 2 }] });
await page.waitForTimeout(300);
const nitroOnly = await page.evaluate(() => { const g = window.__game; return { steer: g.player.controls.steer, nitro: g.player.controls.nitro }; });
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
// brake while steering at speed -> drift
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: L.x, y: L.y, id: 3 }, { x: B.x, y: B.y, id: 4 }] });
await page.waitForTimeout(300);
const drift = await page.evaluate(() => { const g = window.__game; return { handbrake: g.player.controls.handbrake, drifting: g.player.vehicle.drifting, kmh: g.player.vehicle.speed * 3.6 }; });
await page.screenshot({ path: `${out}/m-drift.png` });
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.waitForTimeout(200);
const released = await page.evaluate(() => { const g = window.__game; return { steer: g.player.controls.steer, nitro: g.player.controls.nitro, handbrake: g.player.controls.handbrake }; });
console.log(JSON.stringify({ auto, both, nitroOnly, drift, released }, null, 1));
console.log(logs.filter((l) => !l.includes('vite')).join('\n'));
await browser.close();
