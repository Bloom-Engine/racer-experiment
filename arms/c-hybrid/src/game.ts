/**
 * Game state and the frame: menu → countdown → race → finish (+ pause), nitro, resets,
 * impacts. Orchestrates the modules; each frame:
 *
 *   input (Bloom) → AI → physics steps (Bloom/Jolt) → race rules → sync.ts (physics → three.js)
 *   → camera + effects (three.js) → render (bridge) → HUD (Bloom 2D) → audio (Bloom)
 */
import * as THREE from "three";
import * as P from "@bloomengine/engine/physics";
import { getFPS } from "@bloomengine/engine";
import { setProceduralSky, setSunDirection } from "@bloomengine/engine/models";
import { Track } from "./track.ts";
import { PhysicsWorld, Surface } from "./physics/world.ts";
import { Vehicle, makeChassisShape, PLAYER_TUNING, noControls, type CarTuning, type ChassisShape } from "./physics/vehicle.ts";
import { SceneView, CarView, prepareTrack, loadGltf, loadTexture, triangles } from "./render/scene.ts";
import { SpeedLines, SkidMarks, Particles } from "./render/effects.ts";
import { syncCar } from "./sync.ts";
import { CameraRig } from "./camera.ts";
import { Input, type InputFrame, type Rect } from "./input.ts";
import { Audio } from "./audio.ts";
import { Hud } from "./hud.ts";
import { Race, newRacer, LAPS, type Racer, type RaceEvent } from "./race.ts";
import { AIDriver } from "./ai.ts";
import { loadBestLap, saveBestLap } from "./storage.ts";

type Phase = "menu" | "countdown" | "race" | "paused" | "finished";

interface Car {
  vehicle: Vehicle;
  view: CarView;
  racer: Racer;
  ai: AIDriver | null;
  nitro: number;          // 0..1
  nitroOn: boolean;
  offTimer: number;
  flipTimer: number;
  stuckTimer: number;
  hitCooldown: number;
  drafting: boolean;
  spawn: number;
}

const NAMES = ["YOU", "AZURE", "VOLT", "SHADOW"];
/** Opponent skill (fraction of the racing line's speed profile). */
const SKILLS = [0, 0.95, 0.925, 0.9];
const PLAYER_SPAWN = 3;   // start from the back of the grid: work your way up

function inRect(r: Rect, x: number, y: number): boolean { return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }

export class Game {
  private track!: Track;
  private phys!: PhysicsWorld;
  private view!: SceneView;
  private rig!: CameraRig;
  private input = new Input();
  private audio!: Audio;
  private hud!: Hud;
  private race!: Race;
  private cars: Car[] = [];
  private speedLines!: SpeedLines;
  private skids!: SkidMarks;
  private sparks!: Particles;
  private smoke!: Particles;
  private phase: Phase = "menu";
  private phaseTime = 0;
  private lastCount = -1;
  private time = 0;
  private lastFrame = -1;
  private alpha = 0;
  private bestLap: number | null = null;
  private newRecord = false;
  private message = ""; private messageAge = 99;
  private buttons: Record<string, Rect> = {};
  private surfaces = new Map<number, number>();
  /** scripted test hooks (BLOOM_SCRIPT commands, see main.ts) */
  autopilot = false;
  log = (process.env["RACER_LOG"] ?? "") !== "";
  private frames = 0; private fpsAcc = 0; private fpsFrames = 0;
  private wallHits = 0;

  async init(): Promise<void> {
    this.track = new Track();
    const manifest = this.track.manifest;
    this.view = new SceneView(manifest);
    // Bloom's procedural atmosphere for the sky (the bridge clears to the fog colour and
    // can't draw an unlit textured dome); the sun direction from the manifest
    setProceduralSky(true, { groundAlbedo: 0.15 });
    setSunDirection({ x: this.view.sunTowards.x, y: this.view.sunTowards.y, z: this.view.sunTowards.z }, 1);

    this.rig = new CameraRig(this.view.camera);
    this.speedLines = new SpeedLines(this.view.camera);
    this.skids = new SkidMarks(this.view.scene);
    this.sparks = new Particles(this.view.scene, "spark", 40);
    this.smoke = new Particles(this.view.scene, "smoke", 36);
    this.hud = new Hud(this.track);
    this.audio = new Audio();
    this.bestLap = loadBestLap();

    const [trackGltf, carGltf] = await Promise.all([loadGltf("track/track.glb"), loadGltf("cars/car.glb")]);
    const paints: (THREE.Texture | null)[] = [null];
    for (const v of manifest.car.variants.slice(1)) {
      const t = await loadTexture(v.albedo_texture);
      t.flipY = false;                       // glTF uv convention, as the original texture
      t.colorSpace = THREE.SRGBColorSpace;
      paints.push(t);
    }

    // track: visuals into the scene, colliders into physics (the one-time handoff)
    const tm = prepareTrack(trackGltf);
    this.view.scene.add(tm.root);
    this.phys = new PhysicsWorld();
    this.surfaces.set(this.phys.addStatic(tm.colRoad, Surface.Road, 1.0), Surface.Road);
    this.surfaces.set(this.phys.addStatic(tm.colTerrain, Surface.Terrain, 0.55), Surface.Terrain);
    // slippery walls: a glancing hit slides along instead of stopping the car (arcade)
    this.surfaces.set(this.phys.addStatic(tm.colBarriers, Surface.Wall, 0.05), Surface.Wall);

    // cars: one chassis shape from the hidden convex collider, shared by all four
    const carRoot = carGltf.scene;
    const collider = carRoot.getObjectByName("collider_body");
    const soup = collider !== undefined ? triangles(collider) : { positions: [], indices: [] };
    const chassis = makeChassisShape(soup.positions, soup.indices);
    this.race = new Race(this.track);
    for (let i = 0; i < 4; i++) {
      const spawnIdx = i === 0 ? PLAYER_SPAWN : (i <= PLAYER_SPAWN ? i - 1 : i);
      const car = this.makeCar(i, spawnIdx, chassis, carRoot, paints[i] ?? null);
      this.cars.push(car);
    }
    this.phys.finish();
    this.resetRace();
    this.phase = "menu";
  }

  /** Hand the frame loop to three.js's renderer (the bridge drives it from Bloom's window). */
  start(): void { this.view.renderer.setAnimationLoop((t: number) => this.frame(t)); }

  private makeCar(i: number, spawnIdx: number, chassis: ChassisShape, template: THREE.Object3D, paint: THREE.Texture | null): Car {
    const sp = this.track.spawns[spawnIdx]!;
    const tuning: CarTuning = i === 0 ? PLAYER_TUNING : { ...PLAYER_TUNING, engineTorque: PLAYER_TUNING.engineTorque * 0.97 };
    const vehicle = new Vehicle(this.phys, chassis, sp.pos, sp.rot, tuning);
    const view = new CarView(template, paint, this.track.manifest);
    this.view.scene.add(view.root);
    const racer = newRacer(NAMES[i] ?? `CPU ${i}`, i === 0, sp.pos);
    this.race.add(racer);
    const ai = i === 0 ? null : new AIDriver(this.track, SKILLS[i] ?? 0.9, i);
    return { vehicle, view, racer, ai, nitro: 0, nitroOn: false, offTimer: 0, flipTimer: 0, stuckTimer: 0, hitCooldown: 0, drafting: false, spawn: spawnIdx };
  }

  private resetRace(): void {
    for (const c of this.cars) {
      const sp = this.track.spawns[c.spawn]!;
      c.vehicle.teleport(sp.pos, sp.rot);
      c.vehicle.controls = noControls();
      const fresh = newRacer(c.racer.name, c.racer.isPlayer, sp.pos);
      Object.assign(c.racer, fresh);
      c.racer.lineIndex = this.track.nearest(sp.pos.x, sp.pos.z, 0);
      c.nitro = 0.25; c.nitroOn = false; c.offTimer = 0; c.flipTimer = 0; c.stuckTimer = 0;
    }
    this.race.time = 0;
    this.race.finishedCount = 0;
    this.skids.clear(); this.sparks.clear(); this.smoke.clear();
    this.newRecord = false;
    this.rig.snap();
    this.audio.stopEngines();
  }

  private startCountdown(): void {
    this.resetRace();
    this.phase = "countdown"; this.phaseTime = 0; this.lastCount = -1;
    this.audio.startEngines(this.cars.length - 1);
  }

  private say(msg: string): void { this.message = msg; this.messageAge = 0; }

  // ------------------------------------------------------------------ frame

  frame(nowMs: number): void {
    const now = nowMs / 1000;
    let dt = this.lastFrame < 0 ? 1 / 60 : now - this.lastFrame;
    this.lastFrame = now;
    dt = Math.max(0.001, Math.min(dt, 0.1));
    this.time += dt;
    this.frames++;
    this.messageAge += dt;

    const racing = this.phase === "race" || this.phase === "countdown";
    const inp = this.input.poll(racing);
    this.touchMode = inp.touchMode;
    this.handleMenus(inp);

    const player = this.cars[0]!;
    if (this.phase !== "paused") {
      this.phaseTime += dt;
      if (this.phase === "countdown") this.countdown();
      // the race clock runs until the player finishes; AI keep racing for their results
      if (this.phase === "race" || this.phase === "finished") this.race.time += dt;

      this.driveCars(inp, dt);
      const frozen = this.phase === "countdown" || this.phase === "menu";
      this.alpha = this.phys.advance(dt,
        (h) => { for (const c of this.cars) c.vehicle.preStep(h, frozen); },
        () => { for (const c of this.cars) c.vehicle.postStep(); });
      this.contacts();
      if (this.phase === "race" || this.phase === "finished") this.raceRules(dt, inp);
    }

    // ---- physics → three.js (the boundary), then three.js-only work
    for (const c of this.cars) syncCar(c.vehicle, c.view, this.alpha, this.time);
    this.effects(dt);
    if (this.phase === "menu") this.attractCamera(dt);
    else this.rig.update(player.view.root, player.vehicle.state.speed, player.nitroOn, dt, this.time);
    this.view.followSun(player.view.root.position);
    this.view.render();

    this.drawHud();
    this.updateAudio();
    this.fpsAcc += dt; this.fpsFrames++;
    if (this.log && this.frames % 120 === 0) this.debugLog();
  }

  private countdown(): void {
    const n = 3 - Math.floor(this.phaseTime);
    if (n !== this.lastCount) {
      this.lastCount = n;
      if (n > 0) this.audio.play("beep_short");
      else { this.audio.play("beep_long"); this.phase = "race"; this.phaseTime = 0; this.race.time = 0; }
    }
  }

  private driveCars(inp: InputFrame, dt: number): void {
    const player = this.cars[0]!;
    const others = this.cars.map((c) => ({ state: c.vehicle.state, racer: c.racer }));
    for (const c of this.cars) {
      if (this.phase !== "race" && this.phase !== "finished") { c.vehicle.controls = noControls(); continue; }
      let ctl;
      if (c.ai !== null || this.autopilot || c.racer.finished) {
        const ai = c.ai ?? (this.playerAi ??= new AIDriver(this.track, Number(process.env["RACER_AUTOPILOT_SKILL"] ?? "0.95"), 7));
        ctl = ai.drive(c.vehicle.state, c.racer, others, c.ai === null ? null : player.racer, c.nitro, dt, this.time);
        if (c.racer.finished) { ctl.throttle *= 0.5; ctl.nitro = false; }
      } else {
        ctl = { throttle: inp.throttle, brake: inp.brake, steer: inp.steer, handbrake: inp.handbrake, nitro: inp.nitro };
      }
      // nitro: burns the bar; on while held and not empty
      c.nitroOn = ctl.nitro && c.nitro > 0.01;
      if (c.nitroOn) c.nitro = Math.max(0, c.nitro - dt / 3.2);
      ctl.nitro = c.nitroOn;
      c.vehicle.controls = ctl;
    }
  }
  private playerAi: AIDriver | null = null;

  private raceRules(dt: number, inp: InputFrame): void {
    const events: RaceEvent[] = [];
    for (const c of this.cars) {
      const s = c.vehicle.state;
      this.race.updateRacer(c.racer, s.pos, events);

      // nitro fill: drifting, and drafting close behind another car
      if (!c.nitroOn) {
        if (s.drifting && Math.abs(s.speed) > 12) c.nitro += dt * 0.22;
        c.drafting = false;
        for (const o of this.cars) {
          if (o === c) continue;
          const os = o.vehicle.state;
          const dx = os.pos.x - s.pos.x, dz = os.pos.z - s.pos.z;
          const ahead = dx * s.forward.x + dz * s.forward.z;
          const side = Math.abs(dx * s.right.x + dz * s.right.z);
          if (ahead > 2 && ahead < 22 && side < 2.8 && s.speed > 18) { c.drafting = true; break; }
        }
        if (c.drafting) c.nitro += dt * 0.12;
        c.nitro = Math.min(1, c.nitro);
      } else c.drafting = false;

      // auto reset: off the road or upside down for more than 3 s (and hopelessly stuck)
      const offRoad = s.surface !== Surface.Road;
      c.offTimer = offRoad ? c.offTimer + dt : 0;
      c.flipTimer = s.up.y < 0.3 ? c.flipTimer + dt : 0;
      const tryingToMove = c.ai !== null || inp.throttle > 0 || inp.brake > 0;
      c.stuckTimer = Math.abs(s.speed) < 1 && tryingToMove && !c.racer.finished ? c.stuckTimer + dt : 0;
      if (c.offTimer > 3 || c.flipTimer > 3 || c.stuckTimer > 6) this.resetCar(c, c.offTimer > 3 ? "off track" : c.flipTimer > 3 ? "flipped" : "stuck");
      c.hitCooldown = Math.max(0, c.hitCooldown - dt);
    }
    const player = this.cars[0]!;
    if (this.phase === "race" && inp.reset && !player.racer.finished) this.resetCar(player, "manual");
    this.race.rank();

    for (const e of events) {
      if (e.kind === "lap") {
        if (e.racer.isPlayer) {
          const record = this.bestLap === null || e.time < this.bestLap;
          if (record) { this.bestLap = e.time; this.newRecord = true; saveBestLap(e.time); }
          if (e.racer.lap < LAPS) this.say(record ? "NEW BEST LAP!" : e.racer.lap === LAPS - 1 ? "FINAL LAP" : `LAP ${e.racer.lap + 1}`);
          if (this.log) console.log(`[race] player lap ${e.racer.lapTimes.length} ${e.time.toFixed(3)}s${record ? " (record)" : ""}`);
        }
      } else if (e.kind === "finish") {
        if (this.log) console.log(`[race] ${e.racer.name} finished P${e.racer.finishPlace} in ${e.racer.finishTime.toFixed(3)}s laps ${e.racer.lapTimes.map((t) => t.toFixed(2)).join(",")}`);
        if (e.racer.isPlayer) {
          this.phase = "finished"; this.phaseTime = 0;
          this.audio.play("finish_fanfare");
        }
      } else if (e.kind === "missed" && e.racer.isPlayer) {
        this.say("MISSED CHECKPOINT — GO BACK");
        if (this.log) console.log(`[race] player skipped checkpoint, expected cp_${e.index}`);
      }
    }
  }

  /** Put a car back on the track at its last checkpoint, facing the race direction. */
  resetCar(c: Car, why: string): void {
    const cp = this.track.checkpoints[c.racer.started ? c.racer.lastCp : 0];
    let pos = { x: 0, y: 0, z: 0 }, rot = { x: 0, y: 0, z: 0, w: 1 };
    if (cp === undefined || !c.racer.started) {
      const sp = this.track.spawns[c.spawn]!;
      pos = { ...sp.pos }; rot = { ...sp.rot };
    } else {
      pos = { ...cp.pos }; rot = { ...cp.rot };
      // don't drop onto another car: try the centre, then either side
      for (const off of [0, -4.5, 4.5, -9, 9]) {
        const x = cp.pos.x + cp.right.x * off, z = cp.pos.z + cp.right.z * off;
        const clear = this.cars.every((o) => o === c || Math.hypot(o.vehicle.state.pos.x - x, o.vehicle.state.pos.z - z) > 5);
        if (clear) { pos = { x, y: cp.pos.y, z }; break; }
      }
      const probe = this.phys.probe(pos.x, pos.y + 6, pos.z, 12);
      if (probe.distance !== Infinity) pos.y = pos.y + 6 - probe.distance;
    }
    c.vehicle.teleport(pos, rot);
    c.racer.prev = { ...pos };
    c.offTimer = 0; c.flipTimer = 0; c.stuckTimer = 0;
    for (let w = 0; w < 4; w++) this.skids.lift(this.cars.indexOf(c) * 4 + w);
    if (c.racer.isPlayer) { this.rig.snap(); this.say("RESET"); }
    if (this.log) console.log(`[reset] ${c.racer.name} (${why}) to cp_${c.racer.lastCp}`);
  }

  /** Impacts from Jolt's contact queue: sounds, camera shake, sparks. */
  private contacts(): void {
    const list = P.popContacts();
    const player = this.cars[0]!;
    for (const k of list) {
      if (k.event !== P.ContactEvent.ADDED) continue;
      const a = this.cars.find((c) => c.vehicle.body === k.bodyA);
      const b = this.cars.find((c) => c.vehicle.body === k.bodyB);
      const car = a ?? b;
      if (car === undefined || car.hitCooldown > 0) continue;
      const other = a !== undefined ? k.bodyB : k.bodyA;
      const otherCar = a !== undefined ? b : a;
      const wall = this.surfaces.get(other) === Surface.Wall;
      if (!wall && otherCar === undefined) continue;   // road/terrain touches aren't impacts
      const va = P.getLinearVelocity(car.vehicle.body);
      const vb = otherCar !== undefined ? P.getLinearVelocity(otherCar.vehicle.body) : { x: 0, y: 0, z: 0 };
      const n = k.normal;
      const closing = Math.abs((va.x - vb.x) * n.x + (va.y - vb.y) * n.y + (va.z - vb.z) * n.z);
      if (closing < 1.5) continue;
      car.hitCooldown = 0.3;
      if (otherCar !== undefined) otherCar.hitCooldown = 0.3;
      const involvesPlayer = car === player || otherCar === player;
      const near = Math.hypot(car.vehicle.state.pos.x - player.vehicle.state.pos.x, car.vehicle.state.pos.z - player.vehicle.state.pos.z) < 60;
      if (wall && car === player) this.wallHits++;
      if (involvesPlayer || near) {
        const vol = Math.min(1, closing / 14) * (involvesPlayer ? 1 : 0.4);
        this.audio.play(closing > 8 ? "collision_heavy" : "collision_light", vol);
      }
      if (involvesPlayer) this.rig.impact(Math.min(1, closing / 12));
      const p = k.pointA;
      for (let i = 0; i < Math.min(14, 3 + closing); i++) this.sparks.emit(p.x, p.y + 0.4, p.z, va.x * 0.3, 2, va.z * 0.3, 5, 0.45);
      if (this.log && involvesPlayer) console.log(`[impact] ${wall ? "wall" : "car"} closing ${closing.toFixed(1)} m/s`);
    }
  }

  private effects(dt: number): void {
    const player = this.cars[0]!;
    const ps = player.vehicle.state;
    const kmh = Math.abs(ps.speed) * 3.6;
    this.speedLines.update(player.nitroOn ? 1 : Math.max(0, (kmh - 210) / 90) * 0.5, dt);
    for (let ci = 0; ci < this.cars.length; ci++) {
      const c = this.cars[ci]!;
      const s = c.vehicle.state;
      const sliding = !s.airborne && s.surface === Surface.Road && (Math.abs(s.slipAngle) > 0.16 || (c.vehicle.controls.handbrake && Math.abs(s.speed) > 6)) && Math.abs(s.speed) > 6;
      for (let w = 2; w < 4; w++) {
        const key = ci * 4 + w;
        const wp = s.wheelPos[w]!;
        if (sliding) {
          this.skids.add(key, wp.x - s.up.x * 0.32, wp.y - s.up.y * 0.32, wp.z - s.up.z * 0.32, s.right.x, s.right.z);
          if ((this.frames + w) % 4 === 0) this.smoke.emit(wp.x, wp.y - 0.2, wp.z, s.vel.x * 0.5, 0.3, s.vel.z * 0.5, 1.0, 0.6);
        } else this.skids.lift(key);
      }
    }
    this.skids.update(dt); this.sparks.update(dt); this.smoke.update(dt);
  }

  /** Menu: slow orbit around the grid. */
  private attractCamera(dt: number): void {
    const cam = this.view.camera;
    const c = this.cars[0]!.view.root.position;
    const a = this.time * 0.15;
    cam.position.set(c.x + Math.cos(a) * 12, c.y + 3.5, c.z + Math.sin(a) * 12);
    cam.fov = 55; cam.updateProjectionMatrix();
    cam.lookAt(c.x, c.y + 0.6, c.z);
    void dt;
  }

  // ------------------------------------------------------------------ UI

  private handleMenus(inp: InputFrame): void {
    const tap = (r: Rect | undefined): boolean => r !== undefined && inp.taps.some((t) => inRect(r, t.x, t.y));
    if (this.phase === "menu") {
      if (tap(this.buttons["start"]) || inp.confirm) this.startCountdown();
    } else if (this.phase === "race" || this.phase === "countdown") {
      if (inp.pause) { this.phase = "paused"; this.audio.setPaused(true); }
      if (inp.camera) this.rig.toggle();
    } else if (this.phase === "paused") {
      if (inp.pause || inp.confirm || tap(this.buttons["resume"])) { this.phase = this.race.time > 0 || this.lastCount === 0 ? "race" : "countdown"; }
      else if (tap(this.buttons["restart"])) this.startCountdown();
    } else if (this.phase === "finished") {
      if (inp.camera) this.rig.toggle();
      if ((tap(this.buttons["restart"]) || inp.confirm) && this.phaseTime > 1) this.startCountdown();
    }
  }

  private drawHud(): void {
    const player = this.cars[0]!;
    const s = player.vehicle.state;
    this.buttons = {};
    if (this.phase === "menu") {
      this.buttons["start"] = this.hud.drawStart(this.bestLap, this.isTouch());
      return;
    }
    const countdown = this.phase === "countdown" ? Math.max(1, 3 - Math.floor(this.phaseTime)) : (this.phase === "race" && this.phaseTime < 1 ? 0 : null);
    this.hud.drawRace({
      speedKmh: Math.abs(s.speed) * 3.6, gear: s.gear, rpm: s.rpm,
      player: player.racer, racers: this.race.racers,
      carPositions: this.cars.map((c) => ({ x: c.vehicle.state.pos.x, z: c.vehicle.state.pos.z })),
      lapTime: player.racer.finished ? (player.racer.lapTimes[player.racer.lapTimes.length - 1] ?? 0) : this.race.time - player.racer.lapStart,
      bestLap: this.bestLap,
      nitro: player.nitro, nitroActive: player.nitroOn, drifting: s.drifting, drafting: player.drafting,
      countdown, message: this.message, messageAge: this.messageAge,
      touch: this.isTouch() && this.phase !== "finished", held: this.input.held,
      fps: getFPS(),
    });
    if (this.phase === "paused") {
      const b = this.hud.drawPause();
      this.buttons["resume"] = b.resume; this.buttons["restart"] = b.restart;
    } else if (this.phase === "finished" && this.phaseTime > 1) {
      this.buttons["restart"] = this.hud.drawFinish(this.race.racers, this.bestLap, this.newRecord);
    }
  }

  private touchMode = false;
  private isTouch(): boolean { return this.touchMode; }

  private updateAudio(): void {
    const player = this.cars[0]!;
    const s = player.vehicle.state;
    const cam = this.view.camera;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    this.audio.listener(cam.position.x, cam.position.y, cam.position.z, fwd.x, fwd.y, fwd.z);
    if (this.phase === "paused") return;
    const slide = !s.airborne && s.surface === Surface.Road ? Math.min(1, Math.max(0, Math.abs(s.slipAngle) - 0.12) * 3) * Math.min(1, Math.abs(s.speed) / 15) : 0;
    this.audio.updatePlayer(s.rpm, Math.max(player.vehicle.controls.throttle, this.phase === "countdown" ? 0.3 : 0), slide, s.gear, this.time, player.nitroOn);
    if (player.nitroOn && !this.wasNitro) this.audio.play("nitro_whoosh", 0.9);
    this.wasNitro = player.nitroOn;
    for (let i = 1; i < this.cars.length; i++) {
      const c = this.cars[i]!;
      this.audio.updateOpponent(i - 1, c.vehicle.state.pos.x, c.vehicle.state.pos.y, c.vehicle.state.pos.z, c.vehicle.state.rpm);
    }
  }
  private wasNitro = false;

  // ------------------------------------------------------------------ tests / debug


  private debugLog(): void {
    const p = this.cars[0]!;
    const s = p.vehicle.state;
    const fps = this.fpsFrames / Math.max(1e-3, this.fpsAcc);
    this.fpsAcc = 0; this.fpsFrames = 0;
    console.log(`[t=${this.time.toFixed(1)}] ${this.phase} fps=${fps.toFixed(1)} v=${(s.speed * 3.6).toFixed(0)}km/h g=${s.gear} rpm=${s.rpm.toFixed(0)} surf=${s.surface} slip=${s.slipAngle.toFixed(2)} lap=${p.racer.lap} cp=${p.racer.nextCp} place=${p.racer.place} nitro=${p.nitro.toFixed(2)} pos=(${s.pos.x.toFixed(1)},${s.pos.y.toFixed(2)},${s.pos.z.toFixed(1)}) up=${s.up.y.toFixed(2)} tunnelSaves=${this.cars.map((c) => c.vehicle.tunnelSaves).join("/")} wallHits=${this.wallHits}`
      + " | " + this.cars.slice(1).map((c) => `${c.racer.name}:L${c.racer.lap}cp${c.racer.nextCp}P${c.racer.place} ${(c.vehicle.state.speed * 3.6).toFixed(0)}`).join(" "));
  }

  /** test hook: player car state */
  get playerCar(): Car { return this.cars[0]!; }
  get allCars(): Car[] { return this.cars; }
  get currentPhase(): Phase { return this.phase; }
  confirm(): void { if (this.phase === "menu") this.startCountdown(); }
  get physics(): PhysicsWorld { return this.phys; }
  get trackData(): Track { return this.track; }
}
