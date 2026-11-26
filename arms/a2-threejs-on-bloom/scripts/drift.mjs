// Drift behaviour trace: enter with handbrake, hold steering, release.
import { launch } from './browser.mjs';
const { browser, page } = await launch();
const r = await page.evaluate(() => {
  const g = window.__game; const t = g.track; const v = g.player.vehicle;
  g.startRace(); g.debugAdvance(3.3);
  for (const c of g.cars) if (!c.isPlayer) { c.vehicle.reset(-300, 0, 400, 0, 0); c.vehicle.ghostTime = 999; }
  const out = [];
  const run = (label, steerIn, kmh) => {
    const cp = t.checkpoints[15];
    t.sampleGround(cp.position.x, 2, cp.position.z, v.ground);
    v.reset(cp.position.x - cp.forward.x * 60, v.ground.y, cp.position.z - cp.forward.z * 60, cp.yaw, kmh / 3.6);
    v.nitro = 0;
    const lines = [];
    const phases = [[0.25, { throttle: 1, brake: 0, steer: 1, handbrake: true, nitro: false }], [1.5, { throttle: 1, brake: 0, steer: steerIn, handbrake: false, nitro: false }], [1.0, { throttle: 1, brake: 0, steer: 0, handbrake: false, nitro: false }]];
    let time = 0; const h0 = v.heading;
    for (const [dur, ctl] of phases) {
      g.debugControls = ctl;
      for (let k = 0; k < Math.round(dur * 60); k++) {
        g.debugAdvance(1 / 60); time += 1 / 60;
        if (k % 12 === 0) lines.push(`${time.toFixed(2)}s kmh ${(v.speed * 3.6).toFixed(0)} slip ${(v.slip * 57.3).toFixed(0)}° yawTurned ${((v.heading - h0) * 57.3).toFixed(0)}° drift ${v.drifting} gear ${v.gear}`);
      }
    }
    out.push(`--- ${label}\n` + lines.join('\n') + `\nnitro gained ${v.nitro.toFixed(2)}`);
  };
  run('steer full into drift @120', 1, 120);
  run('steer half @120', 0.5, 120);
  run('counter-steer @150', -0.6, 150);
  g.debugControls = null;
  return out.join('\n');
});
console.log(r);
await browser.close();
