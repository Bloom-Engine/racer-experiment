// Bloom Racer — entry point, game-state machine and main loop.
//
// Loop: poll input -> phase logic -> fixed 60 Hz physics steps (forces,
// Jolt step, race rules) -> interpolate visuals -> camera/audio -> render 3D
// (retained scene graph) -> 2D HUD.
import {
  initWindow, windowShouldClose, beginDrawing, endDrawing, clearBackground,
  beginMode3D, endMode3D, setTargetFPS, getDeltaTime, getFPS, takeScreenshot,
  getPlatform, Platform, runGame, readFile, fileExists, setQualityPreset, QualityPreset, setFog, setCameraClipPlanes,
  setShadowsEnabled, setSsaoEnabled, setBloomEnabled, setMotionBlurEnabled,
} from "bloom/core";
import { setAmbientLight, setDirectionalLight } from "bloom/models";
import * as physics from "bloom/physics";
import {
  SUN_LIGHT_DIR, SUN_COLOR, AMBIENT_SKY, FOG_COLOR_SRGB, FOG_END_M, CAR_VARIANT_NAMES,
} from "./generated/trackData";
import { loadTrackVisuals, loadTrackCollision, initRacingLine, TrackBodies } from "./track";
import { Car, loadCarAssets } from "./vehicle";
import { Race, Phase } from "./race";
import { initAI, driveAI, setAISkill } from "./ai";
import { initInput, pollInput, controls } from "./input";
import { RaceCamera, CamMode } from "./camera";
import {
  initGameAudio, startEngines, updateAudio, beepShort, beepLong, fanfare, setMuted, isMuted,
} from "./audio";
import {
  initHud, drawRaceHud, drawCountdown, drawMenu, drawPause, drawFinish, drawSpeedLines,
  drawImpactFlash, showBanner, MenuAction, formatTime,
} from "./hud";
import { updateCrashTest, crashDone } from "./debug/crashtest";
import { updateSelftest, selftestDone } from "./debug/selftest";
import { createSky, updateSky, setSkyFlip } from "./sky";
import { clampN, lerpN, smoothK } from "./util/math3d";
import * as C from "./config";

// ---------------------------------------------------------------- CLI flags
// --autopilot   AI drives the player car (soak/regression testing)
// --autostart   skip the start screen
// --frames N    quit after N frames;  --shot PATH  screenshot near the end
// --bench       log frame-time statistics per lap
let shotPath = "";
let maxFrames = 0;
let autopilot = false;
let autostart = false;
let bench = false;
let showFps = false;
let crashTest = false;
let noFog = false;
let noSky = false;
let selftest = false;
let saveBestFlag = false;
let playerSkill = 0;
// Web has no argv: the page (tools/build-web.sh) stores the URL query
// (?autopilot&frames=600 → "--autopilot --frames 600") in Bloom's
// localStorage-backed file "flags".
function webArgs(): string[] {
  const out: string[] = [];
  if (!fileExists("flags")) return out;
  const text = readFile("flags");
  let cur = "";
  for (let i = 0; i <= text.length; i++) {
    const ch = i < text.length ? text.charAt(i) : " ";
    if (ch === " ") { if (cur.length > 0) out.push(cur); cur = ""; } else cur += ch;
  }
  return out;
}
const argv: string[] = getPlatform() === Platform.WEB ? webArgs() : process.argv;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--shot" && i + 1 < argv.length) shotPath = argv[i + 1];
  if (a === "--frames" && i + 1 < argv.length) maxFrames = Number(argv[i + 1]);
  if (a === "--autopilot") autopilot = true;
  if (a === "--autostart") autostart = true;
  if (a === "--bench") { bench = true; showFps = true; }
  if (a === "--fps") showFps = true;
  if (a === "--nofog") noFog = true;
  if (a === "--nosky") noSky = true;
  if (a === "--savebest") saveBestFlag = true;
  if (a === "--playerskill" && i + 1 < argv.length) playerSkill = Number(argv[i + 1]);
  if (a === "--selftest") { selftest = true; autostart = true; }
  if (a === "--skyflip") setSkyFlip(false);
  if (a === "--crashtest") { crashTest = true; autostart = true; }
}

// ---------------------------------------------------------------- init
// macOS .app bundle: Bloom resolves asset paths against the working directory
// (identity resolver on desktop), and Finder launches apps with cwd "/".
// Run from Contents/Resources when we are inside a bundle.
if (getPlatform() === Platform.MACOS) {
  const exe = process.execPath;
  const marker = ".app/Contents/MacOS/";
  const k = exe.indexOf(marker);
  if (k > 0 && getPlatform() === Platform.MACOS) process.chdir(exe.substring(0, k) + ".app/Contents/Resources");
}
initWindow(1280, 720, "Bloom Racer");
setTargetFPS(60);
const isIOS = getPlatform() === Platform.IOS;
if (isIOS) {
  // iPhone 12 class: keep the frame cheap.
  setQualityPreset(QualityPreset.Low);
  setShadowsEnabled(true);
} else {
  setQualityPreset(QualityPreset.Medium);
}
setSsaoEnabled(false);
setMotionBlurEnabled(false);
setBloomEnabled(true);
setCameraClipPlanes(0.2, 3000);
initInput();

const world = physics.createWorld({ gravity: { x: 0, y: -9.81, z: 0 } });
loadTrackVisuals();
const bodies: TrackBodies = loadTrackCollision(world);
initRacingLine();
loadCarAssets();
if (!noSky) createSky();
physics.optimizeBroadphase(world);
initGameAudio();
initHud();

const race = new Race();
race.persistBest = (!autopilot || saveBestFlag) && !crashTest && !selftest;
console.log("best lap on record at startup: " + race.bestLapEver);
for (let i = 0; i < C.NUM_CARS; i++) race.cars.push(new Car(world, i, i, i === 0));
initAI(C.NUM_CARS);
if (playerSkill > 0) setAISkill(0, playerSkill);
race.setupGrid();
const camera = new RaceCamera();

let acc = 0;
let frame = 0;
let simTime = 0;
let lastCountInt = 4;
let finishTimer = 0;
let exitAtFrame = 0;
let flash = 0;
let speedFx = 0;

function startRace(): void {
  race.setupGrid();
  race.startCountdown();
  race.paused = false;
  lastCountInt = 4;
  finishTimer = 0;
  camera.snap();
  startEngines(race.cars);
}

if (autostart) startRace();

// frame-time stats for --bench
let benchFrames = 0;
let benchSum = 0;
let benchWorst = 0;
let benchLap = 1;

// ---------------------------------------------------------------- loop
// One frame. Returns false to quit. `ownFrame`: this call brackets the frame
// with beginDrawing/endDrawing itself (native); on the web Bloom's
// requestAnimationFrame driver already does that around the runGame callback.
function tick(rawDt: number, ownFrame: boolean): boolean {
  let dt = rawDt;
  if (dt > 0.1) dt = 0.1;
  frame++;
  const inRace = race.phase === Phase.Countdown || race.phase === Phase.Racing;
  pollInput(inRace && !race.paused);

  // ---- phase logic ----
  if (inRace && controls.pause) race.paused = !race.paused;
  if (inRace && !race.paused) {
    if (controls.camera) camera.toggle();
    if (controls.reset && race.phase === Phase.Racing) race.resetCar(race.player());
  }
  if (race.phase === Phase.Countdown && !race.paused) {
    race.countdown -= dt;
    const ci = Math.ceil(race.countdown);
    if (ci !== lastCountInt) {
      lastCountInt = ci;
      if (ci >= 1 && ci <= 3) beepShort();
    }
    if (race.countdown <= 0) {
      race.phase = Phase.Racing;
      beepLong();
    }
  }

  // ---- fixed-step simulation ----
  const simulate = !race.paused;
  if (simulate) acc += dt;
  let steps = 0;
  while (simulate && acc >= C.PHYSICS_DT && steps < 4) {
    const racing = race.phase === Phase.Racing || race.phase === Phase.Finished;
    const player = race.player();
    for (let i = 0; i < race.cars.length; i++) {
      const car = race.cars[i];
      if (!racing) {
        car.input.throttle = 0; car.input.brake = 0; car.input.steer = 0;
        car.input.handbrake = true; car.input.nitro = false;
        if (race.phase === Phase.Countdown && car.isPlayer) car.input.throttle = controls.throttle; // rev
      } else if (crashTest && car.isPlayer) {
        // input set by updateCrashTest
      } else if (selftest) {
        // inputs set by updateSelftest (opponents idle unless a test drives them)
      } else if (!car.isPlayer || autopilot || car.finished) {
        const gap = (race.progress(player) - race.progress(car)) * 0.00138;
        driveAI(car, race.cars, simTime, gap, C.PHYSICS_DT);
      } else {
        car.input.throttle = controls.throttle;
        car.input.brake = controls.brake;
        car.input.steer = controls.steer;
        car.input.handbrake = controls.handbrake;
        car.input.nitro = controls.nitro;
      }
      car.applyForces(C.PHYSICS_DT, bodies.road, bodies.terrain);
    }
    physics.stepVariable(world, C.PHYSICS_DT);
    for (let i = 0; i < race.cars.length; i++) race.cars[i].readState();
    race.stepRules(C.PHYSICS_DT);
    const p = race.player();
    if (p.impact > 0) {
      camera.addImpact(p.impact);
      if (p.impact > 6) flash = Math.min(1, flash + p.impact * 0.05);
    }
    if (race.events.lapCompleted) {
      if (race.events.newBest) showBanner("NEW BEST LAP  " + formatTime(p.lastLapTime), 2.5);
      else showBanner("LAP  " + formatTime(p.lastLapTime), 2.0);
      if (p.lap === C.TOTAL_LAPS && !p.finished) showBanner("FINAL LAP", 2.0);
    }
    if (race.events.playerFinished) {
      fanfare();
      finishTimer = 0;
      console.log("PLAYER FINISHED pos=" + race.playerPosition + " time=" + p.finishTime);
    }
    simTime += C.PHYSICS_DT;
    acc -= C.PHYSICS_DT;
    steps++;
  }
  if (steps >= 4) acc = 0;
  const alpha = clampN(acc / C.PHYSICS_DT, 0, 1);

  // ---- scripted self-test, --selftest ----
  if (selftest && race.phase === Phase.Racing) {
    updateSelftest(race, dt, () => { race.resetCar(race.player()); });
    if (selftestDone) return false;
  }
  // ---- crash test (DoD #4: no tunnelling), --crashtest ----
  if (crashTest && race.phase === Phase.Racing) {
    updateCrashTest(race.player(), world, bodies.barriers, dt);
    if (crashDone) return false;
  }

  // ---- visuals ----
  for (let i = 0; i < race.cars.length; i++) race.cars[i].updateVisuals(alpha);
  const p = race.player();
  if (race.phase === Phase.Menu) {
    camera.orbit(p.pos.x, p.pos.y, p.pos.z, 9, 2.6, dt);
  } else {
    camera.update(p, alpha, dt);
  }
  const cam = camera.cam;
  updateSky(cam.position.x, cam.position.y, cam.position.z);
  let fx = cam.target.x - cam.position.x, fy = cam.target.y - cam.position.y, fz = cam.target.z - cam.position.z;
  const fl = Math.sqrt(fx * fx + fy * fy + fz * fz) + 1e-6;
  fx /= fl; fy /= fl; fz /= fl;
  const audioActive = race.phase !== Phase.Menu && !race.paused;
  updateAudio(race.cars, cam.position.x, cam.position.y, cam.position.z, fx, fy, fz, audioActive, dt);

  let fxTarget = 0;
  if (race.phase === Phase.Racing && !race.paused) {
    if (p.nitroActive) fxTarget = 1;
    else if (p.kmh() > 200) fxTarget = (p.kmh() - 200) / 120;
  }
  speedFx = lerpN(speedFx, fxTarget, smoothK(6, dt));
  flash = Math.max(0, flash - dt * 3);

  // ---- render ----
  if (ownFrame) beginDrawing();
  clearBackground({ r: 150, g: 190, b: 230, a: 255 });
  setAmbientLight({ r: Math.floor(AMBIENT_SKY[0] * 255), g: Math.floor(AMBIENT_SKY[1] * 255), b: Math.floor(AMBIENT_SKY[2] * 255), a: 255 }, 0.6);
  setDirectionalLight({ x: SUN_LIGHT_DIR[0], y: SUN_LIGHT_DIR[1], z: SUN_LIGHT_DIR[2] },
    { r: Math.floor(SUN_COLOR[0] * 255), g: Math.floor(SUN_COLOR[1] * 255), b: Math.floor(SUN_COLOR[2] * 255), a: 255 }, 3.0);
  if (!noFog) setFog(FOG_COLOR_SRGB[0], FOG_COLOR_SRGB[1], FOG_COLOR_SRGB[2], 1.2 / FOG_END_M, 0, 0.03);
  beginMode3D(cam);
  endMode3D();

  if (race.phase === Phase.Menu) {
    const act = drawMenu(race.bestLapEver, isMuted());
    if (act === MenuAction.Start) startRace();
    if (act === MenuAction.Mute) setMuted(!isMuted());
  } else {
    if (camera.mode === CamMode.Bumper || camera.mode === CamMode.Chase) drawSpeedLines(speedFx);
    drawImpactFlash(flash);
    if (race.phase !== Phase.Finished) drawRaceHud(race, dt, getFPS(), showFps);
    if (race.phase === Phase.Countdown) drawCountdown(race.countdown);
    if (race.phase === Phase.Racing && race.raceTime < 0.8) drawCountdown(0);
    if (race.phase === Phase.Finished) {
      finishTimer += dt;
      if (finishTimer > 1.2) {
        const act = drawFinish(race);
        if (act === MenuAction.Restart) startRace();
      } else {
        drawRaceHud(race, dt, getFPS(), showFps);
      }
    }
    if (race.paused) {
      const act = drawPause();
      if (act === MenuAction.Resume) race.paused = false;
      if (act === MenuAction.Restart) startRace();
    }
  }
  if (ownFrame) endDrawing();

  // ---- diagnostics ----
  if (bench && race.phase === Phase.Racing) {
    benchFrames++;
    benchSum += dt;
    if (dt > benchWorst) benchWorst = dt;
    if (p.lap !== benchLap) {
      console.log("BENCH lap " + benchLap + ": frames=" + benchFrames + " avgFps=" + Math.round(benchFrames / benchSum * 10) / 10 + " worstMs=" + Math.round(benchWorst * 1000));
      benchLap = p.lap; benchFrames = 0; benchSum = 0; benchWorst = 0;
    }
  }
  if (frame % 600 === 0) {
    let s = "t=" + Math.round(simTime) + " fps=" + Math.round(getFPS()) + " phase=" + race.phase;
    for (let i = 0; i < race.cars.length; i++) {
      const c = race.cars[i];
      s += " | " + CAR_VARIANT_NAMES[i] + " L" + c.lap + " cp" + c.nextCp + " " + Math.round(c.kmh()) + " P" + c.position + (c.finished ? " FIN " + Math.round(c.finishTime * 10) / 10 : "");
    }
    console.log(s);
  }
  if (shotPath.length > 0 && maxFrames > 0 && frame === maxFrames - 5) takeScreenshot(shotPath);
  if (maxFrames > 0 && frame >= maxFrames) return false;
  if (autopilot && exitAtFrame === 0 && race.phase === Phase.Finished && finishTimer > 30) {
    let s = "RESULT";
    const st = race.standings();
    for (let i = 0; i < st.length; i++) s += " " + (i + 1) + "." + CAR_VARIANT_NAMES[st[i].index] + (st[i].finished ? "(" + Math.round(st[i].finishTime * 10) / 10 + ")" : "(dnf)");
    console.log(s);
    if (shotPath.length > 0) takeScreenshot(shotPath);
    exitAtFrame = frame + 5; // let the screenshot frame render
  }
  if (exitAtFrame > 0 && frame >= exitAtFrame) return false;
  return true;
}

if (getPlatform() === Platform.WEB) {
  // Browsers cannot block in a loop: hand the frame to Bloom's rAF driver.
  runGame((dt: number) => { tick(dt, false); });
} else {
  while (!windowShouldClose()) {
    if (!tick(getDeltaTime(), true)) break;
  }
}
