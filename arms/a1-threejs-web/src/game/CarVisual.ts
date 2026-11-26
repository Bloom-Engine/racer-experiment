import * as THREE from 'three';
import { clamp, damp } from '../core/math';
import type { Vehicle } from '../physics/Vehicle';

export interface CarTemplate {
  scene: THREE.Object3D;
  brakeOff: THREE.Color;
  brakeOn: THREE.Color;
  brakeStrength: number;
  flameTexture: THREE.Texture;
}

const _m = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _z = new THREE.Vector3();
const _f = new THREE.Vector3();

/** Renderable car built from car.glb: body lean, wheel spin/steer, brake lights, nitro flames. */
export class CarVisual {
  readonly root = new THREE.Group();
  private readonly lean = new THREE.Group();
  private readonly wheels: { node: THREE.Object3D; front: boolean }[] = [];
  private readonly brakeMat: THREE.MeshStandardMaterial | null = null;
  private readonly flames: THREE.Sprite[] = [];
  readonly exhausts: THREE.Object3D[] = [];
  private roll = 0;
  private pitch = 0;
  private brakeLevel = 0;
  private flameLevel = 0;
  private readonly tpl: CarTemplate;

  constructor(tpl: CarTemplate, paint: THREE.Material) {
    this.tpl = tpl;
    const car = tpl.scene.clone(true);
    car.position.set(0, 0, 0);
    car.updateMatrixWorld(true);
    this.root.add(this.lean);
    this.lean.position.set(0, 0.45, 0);
    const inner = new THREE.Group();
    inner.position.set(0, -0.45, 0);
    this.lean.add(inner);

    const collider = car.getObjectByName('collider_body');
    collider?.removeFromParent();

    const body = car.getObjectByName('body');
    const brakes = car.getObjectByName('brake_lights') as THREE.Mesh | undefined;
    for (const name of ['wheel_FL', 'wheel_FR', 'wheel_RL', 'wheel_RR']) {
      const w = car.getObjectByName(name);
      if (!w) continue;
      this.root.add(w); // wheels stay on the chassis; only the body leans
      this.wheels.push({ node: w, front: name.includes('F') });
      w.traverse((o) => {
        (o as THREE.Mesh).castShadow = false;
      });
    }
    if (body) {
      inner.add(body);
      body.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.castShadow = true;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        mats.forEach((mat, i) => {
          if (mat.name.startsWith('car_paint')) {
            if (Array.isArray(m.material)) m.material[i] = paint;
            else m.material = paint;
          }
        });
      });
    }
    if (brakes) {
      inner.add(brakes);
      const mat = (brakes.material as THREE.MeshStandardMaterial).clone();
      brakes.material = mat;
      this.brakeMat = mat;
    }
    for (const name of ['exhaust_L', 'exhaust_R']) {
      const e = car.getObjectByName(name);
      if (!e) continue;
      inner.add(e);
      this.exhausts.push(e);
      const mat = new THREE.SpriteMaterial({
        map: tpl.flameTexture,
        color: 0x9fd0ff,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      });
      const s = new THREE.Sprite(mat);
      s.center.set(0.5, 0.5);
      s.visible = false;
      s.renderOrder = 5;
      e.add(s);
      this.flames.push(s);
    }
  }

  update(v: Vehicle, alpha: number, dt: number, time: number): void {
    // interpolated pose
    const p = v.renderPrevPos;
    this.root.position.set(
      p.x + (v.pos.x - p.x) * alpha,
      p.y + (v.pos.y - p.y) * alpha,
      p.z + (v.pos.z - p.z) * alpha,
    );
    let dh = v.heading - v.renderPrevHeading;
    if (dh > Math.PI) dh -= Math.PI * 2;
    if (dh < -Math.PI) dh += Math.PI * 2;
    const h = v.renderPrevHeading + dh * alpha;
    const up = v.up;
    _f.set(-Math.sin(h), 0, -Math.cos(h));
    _f.addScaledVector(up, -_f.dot(up)).normalize();
    _z.copy(_f).negate(); // local +Z = backwards
    _x.crossVectors(up, _z).normalize();
    _m.makeBasis(_x, up, _z);
    this.root.quaternion.setFromRotationMatrix(_m);

    // body lean from accelerations (visual only)
    const targetRoll = clamp(-v.latAccel * 0.0042, -0.09, 0.09);
    const targetPitch = clamp(v.longAccel * 0.0035, -0.05, 0.04);
    this.roll += (targetRoll - this.roll) * damp(8, dt);
    this.pitch += (targetPitch - this.pitch) * damp(8, dt);
    this.lean.rotation.set(this.pitch, 0, this.roll);

    // wheels: spin about +X, front wheels steer about +Y
    for (const w of this.wheels) {
      w.node.rotation.set(-v.wheelSpin, w.front ? v.steerAngle : 0, 0, 'YXZ');
    }

    // brake lights
    const b = v.braking ? 1 : 0;
    this.brakeLevel += (b - this.brakeLevel) * damp(18, dt);
    if (this.brakeMat) {
      this.brakeMat.emissive.copy(this.tpl.brakeOff).lerp(this.tpl.brakeOn, this.brakeLevel);
      this.brakeMat.emissiveIntensity = 1 + (this.tpl.brakeStrength - 1) * this.brakeLevel;
    }

    // nitro flames
    this.flameLevel += ((v.boosting ? 1 : 0) - this.flameLevel) * damp(v.boosting ? 20 : 8, dt);
    const show = this.flameLevel > 0.02;
    for (let i = 0; i < this.flames.length; i++) {
      const s = this.flames[i];
      s.visible = show;
      if (!show) continue;
      const flick = 0.75 + 0.25 * Math.sin(time * 60 + i * 2.1) + 0.15 * Math.sin(time * 37 + i);
      const len = (0.55 + 0.5 * flick) * this.flameLevel;
      s.scale.set(len * 1.1, len * 1.1, 1);
      s.position.set(0, 0, 0.15 + len * 0.25);
      (s.material as THREE.SpriteMaterial).opacity = 0.9 * this.flameLevel;
    }
  }

  setGhost(on: boolean, time: number): void {
    // blink while the car is in post-reset ghost mode
    this.root.visible = !on || Math.floor(time * 10) % 2 === 0;
  }
}
