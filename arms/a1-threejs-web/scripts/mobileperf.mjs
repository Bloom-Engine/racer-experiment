// Rough phone proxy: 844x390 @ DPR 3, 4x CPU throttle, autopilot racing for 40 s on the production build.
import { launch } from './browser.mjs';
const { browser, context, page } = await launch({ width: 844, height: 390, mobile: true, url: 'http://localhost:4173/?debug&autopilot' });
const cdp = await context.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
await page.tap('#btn-start');
await page.waitForFunction(() => window.__game.state === 'racing', null, { timeout: 30000 });
await page.evaluate(() => window.__game.quality.resetStats());
await page.waitForTimeout(40000);
console.log(JSON.stringify(await page.evaluate(() => { const g = window.__game; return { avgFps: +g.quality.averageFps.toFixed(1), worst2s: +g.quality.worstWindowFps.toFixed(1), renderScale: g.quality.ratio, canvas: [g.renderer.domElement.width, g.renderer.domElement.height], calls: g.renderer.info.render.calls }; })));
await browser.close();
