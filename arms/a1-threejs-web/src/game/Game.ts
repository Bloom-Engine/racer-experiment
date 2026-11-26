import * as THREE from 'three';
import type { Assets } from '../core/assets';
import { NITRO, RACE } from '../core/config';
import { clamp } from '../core/math';
import { Quality } from '../core/Quality';
import { Track } from '../track/Track';
import { Car } from './Car';
import { CarVisual, type CarTemplate } from './CarVisual';
import { AIDriver, type Personality } from '../ai/AIDriver';
import { collideCars, type CarHit } from '../physics/CarCollisions';
import { Input } from '../input/Input';
import { AudioManager } from '../audio/AudioManager';
import { CameraRig } from '../camera/CameraRig';
import { Hud } from '../ui/Hud';
import { Minimap, type MapDot } from '../ui/Minimap';
import { Screens, ordinal, type ResultRow } from '../ui/Screens';
import { SkidMarks } from '../fx/SkidMarks';
import { Particles } from '../fx/Particles';
import { SpeedLines } from '../fx/SpeedLines';
import { storage, type Difficulty } from './storage';
import type { ProgressEvent } from './RaceProgress';
import type { Controls } from '../physics/Vehicle';

type State = 'menu' | 'countdown' | 'racing' | 'finished';

interface DriverDef {
  name: string;
  variant: string;
  css: string;
  spawn: number;
  personality: Personality;
}

// Grid: AI on the first three slots, the player starts from the back.
const DRIVERS: DriverDef[] = [
  { name: 'YOU', variant: 'red', css: '#e3241b', spawn: 3, personality: { skill: 1, lane: 0, aggression: 0.5, nitroEagerness: 0.7, seed: 11 } },
  { name: 'VEX', variant: 'black', css: '#1d1f26', spawn: 0, personality: { skill: 0.985, lane: 0, aggression: 0.7, nitroEagerness: 0.6, seed: 3 } },
  { name: 'RIKA', variant: 'yellow', css: '#f7bd0a', spawn: 1, personality: { skill: 0.965, lane: 0.9, aggression: 0.45, nitroEagerness: 0.85, seed: 5 } },
  { name: 'KADE', variant: 'blue', css: '#1846c8', spawn: 2, personality: { skill: 0.95, lane: -0.9, aggression: 0.25, nitroEagerness: 0.5, seed: 9 } },
];

const DIFFICULTY: Record<Difficulty, number> = { easy: 0.92, normal: 0.985, hard: 1.03 };

const PHYS_DT = 1 / RACE.physicsHz;
const _v = new THREE.Vector3();
const _prev: THREE.Vector3[] = DRIVERS.map(() => new THREE.Vector3());
const _push: THREE.Vector3[] = DRIVERS.map(() => new THREE.Vector3());

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1600);
  readonly track: Track;
  readonly cars: Car[] = [];
  readonly player: Car;
  readonly input = new Input();
  readonly audio = new AudioManager();
  readonly rig: CameraRig;
  readonly hud = new Hud();
  readonly screens = new Screens();
  readonly minimap: Minimap;
  readonly quality: Quality;
  private readonly sun: THREE.DirectionalLight;
  private readonly sunDir: THREE.Vector3;
  private readonly skids = new SkidMarks();
  private readonly smoke = new Particles(260, false, 1.6, -0.6);
  private readonly sparks = new Particles(160, true, 0.8, 9.8);
  private readonly speedLines = new SpeedLines();

  state: State = 'menu';
  paused = false;
  raceTime = 0;
  private countdownT = 0;
  private countdownStep = -1;
  private acc = 0;
  private last = 0;
  private time = 0;
  private hits: CarHit[] = [];
  private events: { car: Car; ev: ProgressEvent }[] = [];
  private finishTimer = -1;
  private resultsShown = false;
  private sessionBest: number | null = null;
  private newRecord = false;
  private difficulty: Difficulty = storage.difficulty();
  private wasBoosting = false;
  private readonly gridCenter = new THREE.Vector3();
  private readonly mapDots: MapDot[] = [];
  private readonly fpsEl = document.getElementById('fps') as HTMLElement;
  private readonly showFps = /[?&]fps/.test(location.search);
  /** debug: let the AI drive the player car */
  autopilot = /[?&]autopilot/.test(location.search);
  /** debug: scripted controls for the player car (automated tests) */
  debugControls: Controls | null = null;
  private readonly autopilotAI = new AIDriver(DRIVERS[0].personality);

  constructor(canvas: HTMLCanvasElement, assets: Assets) {
    const mobile = this.input.isTouch;
    document.body.classList.toggle('touch', mobile);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.quality = new Quality(this.renderer, mobile);

    const m = assets.manifest;
    const env = m.environment;
    // ---- environment
    this.scene.background = assets.sky;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromEquirectangular(assets.skyEnv).texture;
    pmrem.dispose();
    this.scene.environmentIntensity = 0.75;
    const fogColor = new THREE.Color().setRGB(...env.fog.color_srgb, THREE.SRGBColorSpace);
    this.scene.fog = new THREE.Fog(fogColor, env.fog.suggested_start_m, env.fog.suggested_end_m);

    this.sunDir = new THREE.Vector3(...env.sun.direction).normalize();
    this.sun = new THREE.DirectionalLight(new THREE.Color(...env.sun.color_linear), env.sun.suggested_intensity_relative);
    this.sun.castShadow = true;
    const sm = mobile ? 1024 : 2048;
    this.sun.shadow.mapSize.set(sm, sm);
    const sc = this.sun.shadow.camera;
    sc.left = -38;
    sc.right = 38;
    sc.top = 38;
    sc.bottom = -38;
    sc.near = 1;
    sc.far = 220;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    const hemi = new THREE.HemisphereLight(
      new THREE.Color(...env.ambient.sky_color_linear),
      new THREE.Color(...env.ambient.ground_color_linear),
      env.ambient.suggested_intensity_relative * 0.6,
    );
    this.scene.add(hemi);

    // ---- track
    const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.track = new Track(assets.track.scene, m, assets.racingLine, aniso);
    this.scene.add(this.track.visual);

    // ---- cars
    const bl = m.car.materials.brake_light;
    const tpl: CarTemplate = {
      scene: assets.car.scene,
      brakeOff: new THREE.Color(...bl.emissive_off),
      brakeOn: new THREE.Color(...bl.emissive_on),
      brakeStrength: bl.emissive_strength_on,
      flameTexture: makeFlameTexture(),
    };
    DRIVERS.forEach((d, i) => {
      const vi = m.car.variants.findIndex((v) => v.name === d.variant);
      const vis = new CarVisual(tpl, assets.paints[vi]);
      const isPlayer = i === 0;
      const car = new Car(i, d.name, d.css, isPlayer, vis, isPlayer ? null : new AIDriver(d.personality));
      this.cars.push(car);
      this.scene.add(vis.root);
      this.mapDots.push({ x: 0, z: 0, heading: 0, color: d.css, player: isPlayer });
    });
    this.player = this.cars[0];
    for (const s of this.track.spawns) this.gridCenter.add(s.position);
    this.gridCenter.divideScalar(this.track.spawns.length);

    // ---- fx
    this.scene.add(this.skids.mesh, this.smoke.points, this.sparks.points);
    this.camera.add(this.speedLines.mesh);
    this.scene.add(this.camera);
    this.rig = new CameraRig(this.camera);

    // ---- UI
    this.minimap = new Minimap(document.getElementById('minimap') as HTMLCanvasElement, assets.minimap, m);
    this.input.bindTouch(document.getElementById('touch') as HTMLElement);
    this.bindUi();
    void this.audio.decode(assets.audio);

    window.addEventListener('resize', () => this.resize());
    window.visualViewport?.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && (this.state === 'racing' || this.state === 'countdown') && !this.paused) this.setPaused(true);
    });
    this.resize();
    this.placeOnGrid();
    this.toMenu();
    this.fpsEl.classList.toggle('hidden', !this.showFps);
    // Compile all shaders up-front to avoid hitches when effects first appear.
    this.renderer.compile(this.scene, this.camera);
  }

  // ------------------------------------------------------------------ UI wiring
  private bindUi(): void {
    const on = (id: string, fn: () => void): void => {
      const el = document.getElementById(id);
      el?.addEventListener('click', (e) => {
        e.preventDefault();
        this.audio.unlock();
        fn();
      });
    };
    on('btn-start', () => this.startRace());
    on('btn-resume', () => this.setPaused(false));
    on('btn-restart-p', () => this.startRace());
    on('btn-restart-f', () => this.startRace());
    on('btn-menu-p', () => this.toMenu());
    on('btn-menu-f', () => this.toMenu());
    on('btn-mute', () => this.screens.setMuteLabel(this.audio.toggleMute()));
    on('btn-pause', () => this.input.trigger('pause'));
    on('btn-camera', () => this.input.trigger('camera'));
    on('btn-reset', () => this.input.trigger('reset'));
    const diffBtns = document.querySelectorAll<HTMLButtonElement>('[data-diff]');
    const refresh = (): void => diffBtns.forEach((b) => b.classList.toggle('on', b.dataset.diff === this.difficulty));
    diffBtns.forEach((b) =>
      b.addEventListener('click', () => {
        this.difficulty = b.dataset.diff as Difficulty;
        storage.setDifficulty(this.difficulty);
        refresh();
      }),
    );
    refresh();
    this.screens.setMuteLabel(this.audio.isMuted);
    // keyboard shortcuts on menus
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Enter' && e.code !== 'Space') return;
      const s = this.screens.active;
      if (s === 'start' || (s === 'finish' && this.resultsShown)) {
        e.preventDefault();
        this.audio.unlock();
        this.startRace();
      }
    });
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.updateParticleScale();
    this.minimap.resize();
  }

  private updateParticleScale(): void {
    const hPx = this.renderer.domElement.height;
    this.smoke.setViewport(hPx, this.camera.fov);
    this.sparks.setViewport(hPx, this.camera.fov);
  }

  // ------------------------------------------------------------------ state changes
  private placeOnGrid(): void {
    this.cars.forEach((car, i) => {
      const sp = this.track.spawns[DRIVERS[i].spawn];
      this.track.sampleGround(sp.position.x, sp.position.y + 1, sp.position.z, car.vehicle.ground);
      car.vehicle.reset(sp.position.x, car.vehicle.ground.y, sp.position.z, sp.yaw, 0);
      car.vehicle.nitro = 0.35;
      car.vehicle.gear = 1;
      car.vehicle.ghostTime = 0;
      car.progress.reset();
      car.progress.updateMetrics(this.track, sp.position.x, sp.position.z);
      car.offTrackTime = car.upsideTime = car.stuckTime = 0;
      car.visual.update(car.vehicle, 1, 0.016, 0);
      car.visual.setGhost(false, 0);
      car.resets = 0;
    });
    this.rank();
  }

  toMenu(): void {
    this.state = 'menu';
    this.paused = false;
    this.audio.setPaused(false);
    this.audio.quiet();
    this.placeOnGrid();
    this.skids.clear();
    this.hud.show(false);
    this.hud.clearMessages();
    document.getElementById('touch')!.classList.add('hidden');
    this.screens.setStartBest(storage.bestLap());
    this.screens.show('start');
    this.input.clearActions();
  }

  startRace(): void {
    this.placeOnGrid();
    this.skids.clear();
    this.smoke.clear();
    this.sparks.clear();
    for (const c of this.cars) {
      if (c.ai) c.ai.difficulty = DIFFICULTY[this.difficulty];
    }
    this.autopilotAI.difficulty = 1;
    this.state = 'countdown';
    this.paused = false;
    this.audio.setPaused(false);
    this.raceTime = 0;
    this.countdownT = 0;
    this.countdownStep = -1;
    this.acc = 0;
    this.finishTimer = -1;
    this.resultsShown = false;
    this.sessionBest = null;
    this.newRecord = false;
    this.hud.clearMessages();
    this.hud.show(true);
    document.getElementById('touch')!.classList.toggle('hidden', !this.input.isTouch);
    this.screens.show('none');
    this.rig.snap();
    this.input.clearActions();
    this.audio.play('countdown', 0.8);
    this.quality.resetStats();
  }

  setPaused(p: boolean): void {
    if (this.state !== 'racing' && this.state !== 'countdown' && !(this.state === 'finished' && !this.resultsShown)) return;
    this.paused = p;
    this.audio.setPaused(p);
    this.screens.show(p ? 'pause' : 'none');
    this.last = performance.now();
  }

  // ------------------------------------------------------------------ main loop
  start(): void {
    this.last = performance.now();
    const loop = (now: number): void => {
      requestAnimationFrame(loop);
      const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      this.frame(dt);
    };
    requestAnimationFrame(loop);
  }

  private frame(dt: number): void {
    this.handleActions();
    const active = !this.paused;
    if (active) {
      this.time += dt;
      switch (this.state) {
        case 'menu':
          this.rig.orbit(dt, this.gridCenter);
          break;
        case 'countdown':
          this.updateCountdown(dt);
          break;
        case 'racing':
        case 'finished':
          this.updateRace(dt);
          break;
      }
      if (this.state !== 'menu') {
        const alpha = this.state === 'countdown' ? 1 : this.acc / PHYS_DT;
        for (const c of this.cars) {
          c.visual.update(c.vehicle, alpha, dt, this.time);
          c.visual.setGhost(c.vehicle.ghostTime > 0, this.time);
        }
        this.rig.update(dt, this.player.vehicle, this.player.visual);
        this.updateFx(dt);
        this.updateHud(dt);
        this.updateAudio();
      }
      this.updateSunShadow();
    }
    const scaled = this.quality.frame(dt, this.state === 'racing' || this.state === 'countdown');
    if (scaled) this.updateParticleScale();
    if (this.showFps) {
      const info = this.renderer.info.render;
      this.fpsEl.textContent = `${this.quality.fps.toFixed(0)} fps  avg ${this.quality.averageFps.toFixed(1)}\nscale ${this.quality.ratio.toFixed(2)}  calls ${info.calls}  tris ${(info.triangles / 1000).toFixed(0)}k`;
    }
    this.renderer.render(this.scene, this.camera);
  }

  private handleActions(): void {
    const i = this.input;
    if (i.consume('mute')) this.screens.setMuteLabel(this.audio.toggleMute());
    if (i.consume('pause')) {
      if (this.paused) this.setPaused(false);
      else this.setPaused(true);
    }
    if (this.paused) {
      i.consume('camera');
      i.consume('reset');
      return;
    }
    if (i.consume('camera')) this.rig.toggle();
    if (i.consume('reset') && this.state === 'racing' && !this.player.progress.finished) this.resetCar(this.player);
  }

  private updateCountdown(dt: number): void {
    this.countdownT += dt;
    const step = Math.floor(this.countdownT);
    if (step !== this.countdownStep) {
      this.countdownStep = step;
      if (step < RACE.countdownSeconds) this.hud.flash(String(RACE.countdownSeconds - step), 0.95);
    }
    const c = this.input.update(dt, 0);
    this.player.vehicle.idle(dt, c);
    for (const car of this.cars) {
      if (!car.isPlayer) car.vehicle.idle(dt, { throttle: 0.25 + 0.25 * Math.sin(this.time * 3 + car.id), brake: 0, steer: 0, handbrake: false, nitro: false });
    }
    if (this.countdownT >= RACE.countdownSeconds) {
      this.state = 'racing';
      this.hud.flash('GO!', 1.0, 'go');
      this.acc = 0;
    }
  }

  private updateRace(dt: number): void {
    // controls (once per frame)
    const pv = this.player.vehicle;
    const human = this.input.update(dt, pv.forwardSpeed);
    for (const car of this.cars) {
      if (car.isPlayer) {
        if (this.autopilot || car.progress.finished) {
          this.autopilotAI.gapToPlayer = 0;
          car.controls = this.autopilotAI.update(dt, car, this.cars, this.track);
        } else car.controls = this.debugControls ?? human;
      } else if (car.ai) {
        car.ai.gapToPlayer = car.progress.distance - this.player.progress.distance;
        car.controls = car.ai.update(dt, car, this.cars, this.track);
      }
    }

    // fixed-step physics
    this.acc += dt;
    let steps = 0;
    while (this.acc >= PHYS_DT && steps < 14) {
      this.simulate(PHYS_DT);
      this.acc -= PHYS_DT;
      steps++;
    }
    if (steps >= 14) this.acc = 0;

    this.postStep(dt);
  }

  private simulate(h: number): void {
    const vehicles = this.cars.map((c) => c.vehicle);
    this.cars.forEach((c, i) => {
      _prev[i].copy(c.vehicle.pos);
      c.vehicle.step(h, c.controls, this.track);
    });
    for (let i = 0; i < vehicles.length; i++) _push[i].copy(vehicles[i].pos);
    const before = this.hits.length;
    collideCars(vehicles, this.hits);
    if (this.hits.length > before) {
      // positional correction may have shoved a car towards a wall: sweep that move too
      for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i];
        if (v.pos.x !== _push[i].x || v.pos.z !== _push[i].z) v.resolveWallsAfterPush(this.track.walls, _push[i].x, _push[i].z);
      }
    }
    this.raceTime += h;
    this.cars.forEach((c, i) => {
      const ev = c.progress.checkGate(this.track, _prev[i], c.vehicle.pos, this.raceTime);
      if (ev !== 'none' && ev !== 'checkpoint') this.events.push({ car: c, ev });
    });
  }

  private postStep(dt: number): void {
    const track = this.track;
    // progress metrics + ranking
    for (const c of this.cars) c.progress.updateMetrics(track, c.vehicle.pos.x, c.vehicle.pos.z);
    this.rank();

    // events (laps / finish)
    for (const { car, ev } of this.events) this.onProgressEvent(car, ev);
    this.events.length = 0;

    // slipstream nitro + resets
    for (const c of this.cars) {
      const v = c.vehicle;
      c.drafting = false;
      if (v.speed > 22 && this.state !== 'menu') {
        for (const o of this.cars) {
          if (o === c) continue;
          _v.subVectors(o.vehicle.pos, v.pos);
          const along = _v.x * v.fx + _v.z * v.fz;
          const lat = Math.abs(_v.x * -v.fz + _v.z * v.fx);
          if (along > 3 && along < NITRO.draftDistance && lat < NITRO.draftLateral) {
            c.drafting = true;
            break;
          }
        }
      }
      if (c.drafting) v.nitro = Math.min(1, v.nitro + NITRO.draftFillPerSecond * dt);

      if (c.progress.finished && !c.isPlayer) continue;
      const off = v.ground.surface !== 'road';
      c.offTrackTime = off ? c.offTrackTime + dt : 0;
      c.upsideTime = v.upsideDown ? c.upsideTime + dt : 0;
      if (!c.isPlayer || this.autopilot) {
        c.stuckTime = v.speed < 2 ? c.stuckTime + dt : 0;
      }
      // wrong way (player HUD)
      const pi = c.progress.proj.index;
      const dot = v.fx * track.ltx[pi] + v.fz * track.ltz[pi];
      c.progress.wrongWayTime = dot < -0.3 && v.speed > 3 ? c.progress.wrongWayTime + dt : 0;
      if (
        c.offTrackTime > RACE.autoResetSeconds ||
        c.upsideTime > RACE.autoResetSeconds ||
        c.stuckTime > 6 ||
        v.pos.y < -40
      ) {
        c.lastResetReason = `${c.offTrackTime > RACE.autoResetSeconds ? 'off' : c.upsideTime > RACE.autoResetSeconds ? 'upside' : c.stuckTime > 6 ? 'stuck' : 'fell'}@${c.progress.proj.index}`;
        this.resetCar(c);
      }
    }

    // impacts
    for (const c of this.cars) {
      const v = c.vehicle;
      if (v.impact > 0.8) {
        const d = c.visual.root.position.distanceTo(this.camera.position);
        if (c.isPlayer) {
          this.rig.addShake(clamp(v.impact * 0.06, 0, 1));
          this.audio.impact(v.impact);
        } else if (d < 40) this.audio.impact(v.impact * (1 - d / 40));
        if (d < 120 && v.impact > 2.5) this.emitSparks(v.impactX || v.pos.x, v.pos.y + 0.5, v.impactZ || v.pos.z, v.impact);
      }
      if (c.isPlayer && v.landing > 3) this.rig.addShake(clamp(v.landing * 0.05, 0, 0.6));
      v.impact = 0;
      v.landing = 0;
    }
    this.hits.length = 0;

    // nitro start sound
    const pb = this.player.vehicle.boosting;
    if (pb && !this.wasBoosting) this.audio.play('nitro_whoosh', 0.9);
    this.wasBoosting = pb;

    // finish → results
    if (this.finishTimer >= 0) {
      this.finishTimer += dt;
      if (this.finishTimer > RACE.resultsDelay && !this.resultsShown) {
        this.resultsShown = true;
        this.screens.show('finish');
        document.getElementById('touch')!.classList.add('hidden');
        this.hud.clearMessages();
      }
      if (this.resultsShown) this.refreshResults();
    }
  }

  private rank(): void {
    const order = [...this.cars].sort((a, b) => {
      const pa = a.progress;
      const pb = b.progress;
      if (pa.finished !== pb.finished) return pa.finished ? -1 : 1;
      if (pa.finished) return pa.finishTime - pb.finishTime;
      return pb.rankKey - pa.rankKey;
    });
    order.forEach((c, i) => (c.place = i + 1));
  }

  private onProgressEvent(car: Car, ev: ProgressEvent): void {
    const p = car.progress;
    if (ev === 'finish') {
      p.finishPlace = this.cars.filter((c) => c.progress.finished).length;
    }
    if (!car.isPlayer) return;
    if (ev === 'lap' || ev === 'finish') {
      const t = p.lapTimes[p.lapTimes.length - 1];
      const record = storage.submitLap(t);
      if (record) this.newRecord = true;
      const prevBest = this.sessionBest;
      if (prevBest === null || t < prevBest) this.sessionBest = t;
      if (ev === 'lap') {
        if (p.lap === RACE.laps - 1) {
          this.hud.flash('FINAL LAP', 1.6, 'small');
          this.audio.play('beep_long', 0.5);
        }
        this.hud.message(record ? `NEW RECORD  ${fmt(t)}` : `LAP ${p.lap}  ${fmt(t)}`, 2.6);
      }
    }
    if (ev === 'finish') {
      this.state = 'finished';
      this.finishTimer = 0;
      this.hud.flash(p.finishPlace === 1 ? 'WINNER!' : `${ordinal(p.finishPlace)}`, 2.4, p.finishPlace === 1 ? 'go small' : 'small');
      this.audio.play('finish_fanfare', 0.9);
      this.autopilotAI.difficulty = 0.9;
    }
  }

  private refreshResults(): void {
    const sorted = [...this.cars].sort((a, b) => a.place - b.place);
    const rows: ResultRow[] = sorted.map((c) => ({
      name: c.name,
      color: c.colorCss,
      isPlayer: c.isPlayer,
      finished: c.progress.finished,
      totalTime: c.progress.finishTime,
      bestLap: c.progress.bestLap,
      lapsDone: c.progress.lap,
    }));
    const key = rows.map((r) => `${r.name}${r.finished}${r.lapsDone}`).join('|');
    if (key === this.lastResultsKey) return;
    this.lastResultsKey = key;
    const badge = this.newRecord ? `NEW LAP RECORD ${fmt(storage.bestLap())}` : '';
    this.screens.renderResults(rows, this.player.progress.finishPlace, badge, this.player.progress.lapTimes);
  }
  private lastResultsKey = '';

  /** Put a car back on the track at its last checkpoint (or its grid slot). */
  resetCar(car: Car): void {
    const t = this.track;
    const p = car.progress;
    let x: number;
    let z: number;
    let yaw: number;
    if (p.lastCp < 0) {
      const sp = t.spawns[DRIVERS[car.id].spawn];
      x = sp.position.x;
      z = sp.position.z;
      yaw = sp.yaw;
    } else {
      const cp = t.checkpoints[p.lastCp];
      x = cp.position.x;
      z = cp.position.z;
      yaw = cp.yaw;
    }
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    // choose a free lateral slot on asphalt
    const g = car.vehicle.ground;
    let bx = x;
    let bz = z;
    for (const off of [0, 3.5, -3.5, 6.5, -6.5]) {
      const cx = x + rx * off;
      const cz = z + rz * off;
      if (!t.sampleGround(cx, 20, cz, g) || g.surface !== 'road') continue;
      const blocked = this.cars.some((o) => o !== car && Math.hypot(o.vehicle.pos.x - cx, o.vehicle.pos.z - cz) < 6);
      bx = cx;
      bz = cz;
      if (!blocked) break;
    }
    t.sampleGround(bx, 20, bz, g);
    const proj = t.project(bx, bz, -1, { index: 0, s: 0, lateral: 0, dist: 0 });
    const speed = Math.min(14, t.lspeed[proj.index] * 0.6);
    car.vehicle.reset(bx, g.y, bz, yaw, p.lastCp < 0 ? 0 : speed);
    car.vehicle.ghostTime = 1.6;
    car.resets++;
    car.offTrackTime = car.upsideTime = car.stuckTime = 0;
    p.proj.index = -1;
    if (car.isPlayer) {
      this.rig.snap();
      this.hud.message('RESET', 1.0);
    }
  }

  // ------------------------------------------------------------------ per-frame presentation
  private emitSparks(x: number, y: number, z: number, strength: number): void {
    const n = Math.min(26, 6 + Math.floor(strength * 1.5));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 3 + Math.random() * 6 + strength * 0.4;
      this.sparks.emit(x, y, z, Math.cos(a) * s, 2 + Math.random() * 5, Math.sin(a) * s, 0.35 + Math.random() * 0.35, 0.16, -0.1, 1.0, 0.7, 0.3, 1);
    }
  }

  private updateFx(dt: number): void {
    const camPos = this.camera.position;
    for (const c of this.cars) {
      const v = c.vehicle;
      const fx = v.fx;
      const fz = v.fz;
      const rx = -fz;
      const rz = fx;
      const sliding = v.grounded && v.speed > 6 && (v.drifting || v.slip > 0.16 || (v.braking && v.speed > 25 && c.controls.handbrake));
      const strength = !sliding ? 0 : v.drifting ? 1 : clamp((v.slip - 0.1) * 3, 0.3, 1);
      const onRoad = v.ground.surface === 'road';
      const near = c.visual.root.position.distanceToSquared(camPos) < 90 * 90;
      for (let w = 0; w < 2; w++) {
        const side = w === 0 ? -0.83 : 0.83;
        const wx = v.pos.x + rx * side - fx * 1.35;
        const wz = v.pos.z + rz * side - fz * 1.35;
        this.skids.add(c.id * 2 + w, wx, v.pos.y, wz, rx, rz, onRoad ? strength : 0);
        if (near && (strength > 0.3 || (!onRoad && v.speed > 8)) && Math.random() < dt * (onRoad ? 26 : 18)) {
          const col = onRoad ? 0.85 : 0.62;
          this.smoke.emit(
            wx,
            v.pos.y + 0.25,
            wz,
            v.vx * 0.25 + (Math.random() - 0.5) * 1.5,
            0.6 + Math.random() * 0.8,
            v.vz * 0.25 + (Math.random() - 0.5) * 1.5,
            onRoad ? 1.3 : 0.9,
            0.8,
            2.6,
            col,
            col * (onRoad ? 1 : 0.88),
            col * (onRoad ? 1 : 0.72),
            onRoad ? 0.35 : 0.45,
          );
        }
      }
    }
    this.skids.flush();
    this.smoke.update(dt);
    this.sparks.update(dt);
    const pv = this.player.vehicle;
    const kmh = pv.speed * 3.6;
    const intensity = pv.boosting ? 1 : clamp((kmh - 215) / 80, 0, 0.45);
    this.speedLines.update(dt, intensity, pv.speed);
  }

  private updateSunShadow(): void {
    const target = this.state === 'menu' ? this.gridCenter : this.player.visual.root.position;
    // snap to shadow texels to avoid shimmering while moving
    const step = 76 / this.sun.shadow.mapSize.x;
    const tx = Math.round(target.x / step) * step;
    const tz = Math.round(target.z / step) * step;
    this.sun.target.position.set(tx, target.y, tz);
    this.sun.position.set(tx, target.y, tz).addScaledVector(this.sunDir, 100);
    this.sun.target.updateMatrixWorld();
  }

  private updateHud(dt: number): void {
    const p = this.player;
    const v = p.vehicle;
    const pr = p.progress;
    const racing = this.state === 'racing';
    const lapTime = this.state === 'countdown' ? 0 : pr.finished ? (pr.lapTimes[pr.lapTimes.length - 1] ?? 0) : this.raceTime - pr.lapStart;
    const stored = storage.bestLap();
    const best = stored === null ? this.sessionBest : this.sessionBest === null ? stored : Math.min(stored, this.sessionBest);
    this.hud.update(dt, {
      speedKmh: v.speed * 3.6,
      gear: v.gear,
      rpm: v.rpm,
      place: p.place,
      cars: this.cars.length,
      lap: pr.currentLapDisplay,
      laps: RACE.laps,
      lapTime,
      bestLap: best,
      nitro: v.nitro,
      boosting: v.boosting,
      drafting: racing && p.drafting,
      drifting: racing && v.drifting,
      wrongWay: racing && pr.wrongWayTime > 1.2,
      offTrack: racing && p.offTrackTime > 0.6 ? RACE.autoResetSeconds - p.offTrackTime : 0,
    });
    this.cars.forEach((c, i) => {
      const d = this.mapDots[i];
      d.x = c.visual.root.position.x;
      d.z = c.visual.root.position.z;
      d.heading = c.vehicle.heading;
    });
    this.minimap.draw(this.mapDots);
  }

  private updateAudio(): void {
    const v = this.player.vehicle;
    const c = this.player.controls;
    const throttle = this.state === 'countdown' ? this.input.controls.throttle : c.throttle;
    this.audio.updatePlayer({
      rpm: v.rpm,
      throttle,
      speed: v.speed,
      slip: v.drifting ? Math.max(v.slip, 0.4) : v.slip,
      grounded: v.grounded,
      boosting: v.boosting,
      shiftedUp: v.shiftedUp,
      offroad: v.ground.surface !== 'road',
    });
    v.shiftedUp = false;
    const cam = this.camera;
    const right = _v.set(1, 0, 0).applyQuaternion(cam.quaternion);
    let k = 0;
    for (const car of this.cars) {
      if (car.isPlayer) continue;
      const pos = car.visual.root.position;
      const dx = pos.x - cam.position.x;
      const dz = pos.z - cam.position.z;
      const dist = Math.hypot(dx, dz);
      const pan = dist > 0.1 ? (dx * right.x + dz * right.z) / dist : 0;
      this.audio.updateAI(k++, car.vehicle.rpm, dist, pan);
    }
  }

  // ------------------------------------------------------------------ debug helpers (used by automated tests)
  /** Run the simulation (same code paths as a real frame, minus rendering) for `seconds`. */
  debugAdvance(seconds: number, dt = 1 / 60, until?: () => boolean): void {
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) {
      this.time += dt;
      if (this.state === 'countdown') this.updateCountdown(dt);
      else if (this.state === 'racing' || this.state === 'finished') this.updateRace(dt);
      if (until && until()) break;
    }
  }

  debugState(): Record<string, unknown> {
    const p = this.player;
    return {
      state: this.state,
      raceTime: this.raceTime,
      speedKmh: p.vehicle.speed * 3.6,
      place: p.place,
      lap: p.progress.lap,
      nextCp: p.progress.nextCp,
      lapTimes: p.progress.lapTimes,
      nitro: p.vehicle.nitro,
      cars: this.cars.map((c) => ({
        name: c.name,
        place: c.place,
        lap: c.progress.lap,
        cp: c.progress.cpCount,
        finished: c.progress.finished,
        finishTime: c.progress.finishTime,
        speed: c.vehicle.speed * 3.6,
        pos: [c.vehicle.pos.x, c.vehicle.pos.y, c.vehicle.pos.z],
        resets: c.resets,
        resetReason: c.lastResetReason,
        nitro: c.vehicle.nitro,
      })),
      fps: this.quality.averageFps,
      fpsWorst: this.quality.worstWindowFps,
    };
  }
}

const fmt = (t: number | null): string => {
  if (t == null) return '';
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(3).padStart(6, '0')}`;
};

function makeFlameTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(160,220,255,0.9)');
  grd.addColorStop(0.6, 'rgba(60,120,255,0.35)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

