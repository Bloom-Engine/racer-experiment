// Shared Playwright launcher for the verification scripts (uses the system Chrome with GPU).
import { chromium } from 'playwright';

export async function launch({ width = 1280, height = 720, mobile = false, url = 'http://localhost:5173/' } = {}) {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: mobile ? 3 : 1,
    isMobile: mobile,
    hasTouch: mobile,
  });
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`); });
  await page.goto(url);
  await page.waitForFunction(() => window.__game !== undefined, null, { timeout: 60000 });
  return { browser, context, page, logs };
}
