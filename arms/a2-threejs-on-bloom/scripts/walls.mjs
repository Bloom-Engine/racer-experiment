// DoD 4: hard wall impacts at top speed + nitro must never tunnel.
import { launch } from './browser.mjs';
const { browser, page } = await launch();
const res = await page.evaluate(() => {
  const g = window.__game;
  const t = g.track;
  g.startRace();
  g.debugAdvance(3.3);
  const v = g.player.vehicle;
  const out = [];
  let bad = 0;
  // 10 impacts: various sections, angles and sides; plus 10 extra randomised ones
  const cases = [];
  const idxs = [20, 60, 100, 140, 170, 200, 260, 300, 340, 400];
  idxs.forEach((i, k) => cases.push({ i, ang: [25, 45, 60, 75, 90][k % 5], side: k % 2 ? 1 : -1 }));
  for (let k = 0; k < 40; k++) cases.push({ i: Math.floor(Math.random() * t.n), ang: 15 + Math.random() * 75, side: Math.random() < 0.5 ? 1 : -1 });
  for (const c of cases) {
    const tyaw = Math.atan2(-t.ltx[c.i], -t.ltz[c.i]);
    const yaw = tyaw + c.side * (c.ang * Math.PI) / 180;
    g.track.sampleGround(t.lx[c.i], t.ly[c.i] + 1, t.lz[c.i], v.ground);
    v.reset(t.lx[c.i], v.ground.y, t.lz[c.i], yaw, 300 / 3.6);
    v.nitro = 1;
    g.player.progress.proj.index = -1;
    g.debugControls = { throttle: 1, brake: 0, steer: 0, handbrake: false, nitro: true };
    let maxImpact = 0;
    let escaped = false;
    let minSpeedAtHit = 999;
    const n = { x: 0, z: 0 };
    let px = v.pos.x;
    let pz = v.pos.z;
    for (let f = 0; f < 90; f++) {
      g.debugAdvance(1 / 60);
      // the car centre's path this frame must never cross a wall segment
      if (t.walls.sweep(px, pz, v.pos.x, v.pos.z, n) >= 0) escaped = true;
      px = v.pos.x;
      pz = v.pos.z;
      if (v.impact > maxImpact) maxImpact = v.impact;
      // inside test: path from nearest racing-line point to the car must not cross a wall
      const pr = t.project(v.pos.x, v.pos.z, -1, { index: 0, s: 0, lateral: 0, dist: 0 });
      const lp = t.pointAt(pr.s, 0, new v.pos.constructor());
      if (t.walls.sweep(lp.x, lp.z, v.pos.x, v.pos.z, n) >= 0) escaped = true;
    }
    if (escaped) bad++;
    if (out.length < 12 || escaped) out.push({ i: c.i, ang: Math.round(c.ang), side: c.side, escaped, finalKmh: Math.round(v.speed * 3.6) });
  }
  g.debugControls = null;
  return { out, total: cases.length, bad };
});
console.table(res.out);
console.log('impacts:', res.total, 'tunnelled:', res.bad);
await browser.close();
