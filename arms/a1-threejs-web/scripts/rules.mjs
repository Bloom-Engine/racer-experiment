// DoD 3 (nitro), 5 (reset), 6 (checkpoints) scripted checks.
import { launch } from './browser.mjs';
const { browser, page } = await launch();
const r = await page.evaluate(() => {
  const g = window.__game;
  const t = g.track;
  const v = g.player.vehicle;
  const p = g.player.progress;
  const res = {};
  const idle = { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false };
  const gas = { throttle: 1, brake: 0, steer: 0, handbrake: false, nitro: false };
  const park = () => { for (const c of g.cars) if (!c.isPlayer) { c.vehicle.reset(-300, 0, 400, 0, 0); c.vehicle.ghostTime = 999; } };
  const placeBefore = (k, back = 10, speed = 30) => {
    const cp = t.checkpoints[k];
    const x = cp.position.x - cp.forward.x * back;
    const z = cp.position.z - cp.forward.z * back;
    t.sampleGround(x, cp.position.y + 2, z, v.ground);
    v.reset(x, v.ground.y, z, cp.yaw, speed);
    p.proj.index = -1;
  };
  const cross = (k) => { placeBefore(k); g.debugControls = gas; g.debugAdvance(0.8); };

  // ---------- checkpoints
  g.startRace(); g.debugAdvance(3.3); park();
  cross(0);
  res.afterStart = { cp: p.cpCount, next: p.nextCp, lap: p.lap };
  cross(0); // shortcut: straight back to the line without cp_01..15
  res.lineAgainNoLap = { lap: p.lap, next: p.nextCp };
  cross(1); cross(2); cross(5); cross(6); // skip 3,4
  res.skipped = { next: p.nextCp, cp: p.cpCount };
  for (let k = 7; k < 16; k++) cross(k);
  cross(0);
  res.skipLapCounted = p.lap;
  // reverse crossing of cp_03
  { const cp = t.checkpoints[3]; const x = cp.position.x + cp.forward.x * 8, z = cp.position.z + cp.forward.z * 8;
    t.sampleGround(x, cp.position.y + 2, z, v.ground); v.reset(x, v.ground.y, z, cp.yaw + Math.PI, 25); p.proj.index = -1; g.debugAdvance(0.8); }
  res.reverseCounted = p.nextCp !== 3;
  for (let k = 3; k < 16; k++) cross(k);
  cross(0);
  res.fullLap = { lap: p.lap, lapTimes: p.lapTimes.length };

  // ---------- auto reset off-track
  g.startRace(); g.debugAdvance(3.3); park();
  cross(0); cross(1); cross(2);
  // drop the car in the run-off beside the track, stationary
  const i = 60; const lx = t.ltz[i], lz = -t.ltx[i];
  const off = t.roomLeft[i] + 3;
  const ox = t.lx[i] + lx * off, oz = t.lz[i] + lz * off;
  t.sampleGround(ox, t.ly[i] + 2, oz, v.ground);
  res.offSurface = v.ground.surface;
  v.reset(ox, v.ground.y, oz, 0, 0); p.proj.index = -1;
  g.debugControls = idle;
  g.debugAdvance(2.5);
  res.resetsAt2_5s = g.player.resets;
  g.debugAdvance(1.0);
  res.resetsAt3_5s = g.player.resets;
  const cp2 = t.checkpoints[2];
  res.resetDistToCp2 = Math.hypot(v.pos.x - cp2.position.x, v.pos.z - cp2.position.z).toFixed(2);
  res.surfaceAfterReset = v.ground.surface;

  // ---------- nitro: drift fill
  g.startRace(); g.debugAdvance(3.3); park();
  placeBefore(0, -20, 33); v.nitro = 0;
  g.debugControls = { throttle: 1, brake: 0, steer: 1, handbrake: true, nitro: false };
  g.debugAdvance(0.3);
  g.debugControls = { throttle: 1, brake: 0, steer: 0.6, handbrake: false, nitro: false };
  let drifted = 0;
  for (let k = 0; k < 90; k++) { g.debugAdvance(1 / 60); if (v.drifting) drifted++; }
  res.driftFrames = drifted;
  res.nitroAfterDrift = v.nitro.toFixed(3);
  // ---------- nitro: slipstream fill (follow an AI car down the straight)
  g.startRace(); g.debugAdvance(3.3);
  const ai = g.cars[1].vehicle;
  for (const c of g.cars) if (c !== g.cars[1] && !c.isPlayer) { c.vehicle.reset(-300, 0, 400, 0, 0); c.vehicle.ghostTime = 999; }
  const s0 = t.checkpoints[15]; // long straight before the line
  t.sampleGround(s0.position.x, 2, s0.position.z, ai.ground);
  ai.reset(s0.position.x, ai.ground.y, s0.position.z, s0.yaw, 50);
  t.sampleGround(s0.position.x - s0.forward.x * 12, 2, s0.position.z - s0.forward.z * 12, v.ground);
  v.reset(s0.position.x - s0.forward.x * 12, v.ground.y, s0.position.z - s0.forward.z * 12, s0.yaw, 50);
  g.cars[1].progress.proj.index = -1; p.proj.index = -1; v.nitro = 0;
  g.debugControls = { throttle: 0.75, brake: 0, steer: 0, handbrake: false, nitro: false };
  let drafting = 0;
  for (let k = 0; k < 60; k++) { g.debugAdvance(1 / 60); if (g.player.drafting) drafting++; }
  res.draftFrames = drafting;
  res.nitroAfterDraft = v.nitro.toFixed(3);
  // ---------- nitro: fire on the main straight
  g.startRace(); g.debugAdvance(3.3); park();
  placeBefore(14, 0, 245 / 3.6);
  g.debugControls = gas; g.debugAdvance(1.0);
  const before = v.speed * 3.6;
  v.nitro = 1;
  g.debugControls = { ...gas, nitro: true };
  g.debugAdvance(1.0);
  res.boosting = v.boosting;
  g.debugAdvance(2.0);
  res.nitroSpeed = { before: before.toFixed(0), after3s: (v.speed * 3.6).toFixed(0), nitroLeft: v.nitro.toFixed(2) };
  // ---------- top speed without nitro
  placeBefore(14, 0, 200 / 3.6); g.debugControls = gas; g.debugAdvance(8);
  res.topSpeedNoNitro = (v.speed * 3.6).toFixed(1);
  g.debugControls = null;
  return res;
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
