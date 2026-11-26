/**
 * The three.js side: scene graph, lights, track and car meshes, camera. Plain three.js —
 * the Bloom bridge swaps WebGLRenderer for one that mirrors this scene into Bloom.
 */
import * as THREE from "three";
import { isMobile } from "@bloomengine/engine";
import { QualityPreset, setQualityPreset, setRenderScale, setAutoResolution } from "@bloomengine/engine/core";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { assetUrl } from "../paths.ts";
import type { Manifest } from "../track.ts";
import type { TriangleSoup } from "../physics/world.ts";

export function loadGltf(rel: string): Promise<GLTF> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().load(assetUrl(rel), resolve, undefined, reject);
  });
}

export function loadTexture(rel: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(assetUrl(rel), resolve, undefined, reject);
  });
}

/** World-space triangles of a (hidden) collider mesh, for the physics side. */
export function triangles(obj: THREE.Object3D): TriangleSoup {
  const positions: number[] = [];
  const indices: number[] = [];
  obj.updateWorldMatrix(true, true);
  const v = new THREE.Vector3();
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh !== true) return;
    const g = mesh.geometry as THREE.BufferGeometry;
    const pos = g.attributes.position as THREE.BufferAttribute;
    const base = positions.length / 3;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      positions.push(v.x, v.y, v.z);
    }
    if (g.index !== null) for (let i = 0; i < g.index.count; i++) indices.push(base + g.index.getX(i));
    else for (let i = 0; i < pos.count; i++) indices.push(base + i);
  });
  return { positions, indices };
}

const linear = (c: number[]): THREE.Color => new THREE.Color(c[0] ?? 1, c[1] ?? 1, c[2] ?? 1);

export class SceneView {
  readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(65, 16 / 9, 0.3, 2500);
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  /** sun direction towards the sun (for Bloom's procedural sky) */
  readonly sunTowards: THREE.Vector3;

  constructor(manifest: Manifest) {
    const env = manifest.environment;
    // phones: Bloom's Low preset (no shadows/SSAO/TAA) at 0.6 scale with 60 Hz dynamic resolution,
    // a shorter far plane, and no shadow map. RACER_QUALITY=medium keeps the desktop look.
    const mobileLook = isMobile() && (process.env["RACER_QUALITY"] ?? "low") === "low";
    if (mobileLook) {
      setQualityPreset(QualityPreset.Low);
      setRenderScale(0.6);
      setAutoResolution(60);
      this.camera.far = 1100;
    }
    this.renderer.shadowMap.enabled = !mobileLook;
    const fogC = env.fog.color_srgb;
    const fogColor = new THREE.Color().setRGB(fogC[0] ?? 0.7, fogC[1] ?? 0.8, fogC[2] ?? 0.9, THREE.SRGBColorSpace);
    this.scene.background = fogColor;
    this.scene.fog = new THREE.Fog(fogColor, env.fog.suggested_start_m, env.fog.suggested_end_m);

    const amb = env.ambient;
    this.scene.add(new THREE.HemisphereLight(linear(amb.sky_color_linear), linear(amb.ground_color_linear), amb.suggested_intensity_relative));
    const d = env.sun.direction;
    this.sunTowards = new THREE.Vector3(d[0] ?? 0, d[1] ?? 1, d[2] ?? 0).normalize();
    this.sun.color = linear(env.sun.color_linear);
    this.sun.intensity = env.sun.suggested_intensity_relative;
    this.sun.castShadow = true;
    this.sun.position.copy(this.sunTowards).multiplyScalar(200);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.scene.add(this.camera);   // its children (speed lines) are part of the scene
  }

  /** Keep the shadow-casting sun over the camera (the directional light only gives a direction). */
  followSun(target: THREE.Vector3): void {
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(this.sunTowards, 200);
  }

  render(): void { this.renderer.render(this.scene, this.camera); }
}

/** The track model: visual nodes stay in the scene, collision nodes are handed to physics. */
export interface TrackModel {
  root: THREE.Object3D;
  colRoad: TriangleSoup;
  colBarriers: TriangleSoup;
  colTerrain: TriangleSoup;
}

export function prepareTrack(gltf: GLTF): TrackModel {
  const root = gltf.scene;
  let colRoad: TriangleSoup = { positions: [], indices: [] };
  let colBarriers = colRoad, colTerrain = colRoad;
  const hide: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o.name === "col_road") colRoad = triangles(o);
    else if (o.name === "col_barriers") colBarriers = triangles(o);
    else if (o.name === "col_terrain") colTerrain = triangles(o);
    if (o.name.startsWith("col_") || o.userData["collider"] === true) hide.push(o);
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh === true) {
      const big = o.name === "road" || o.name === "terrain" || o.name === "kerbs";
      mesh.receiveShadow = true;
      mesh.castShadow = !big;
    }
  });
  for (const o of hide) o.visible = false;
  return { root, colRoad, colBarriers, colTerrain };
}

/** Car colours from the manifest variants (red = player). */
export const CAR_COLOURS = ["red", "blue", "yellow", "black"] as const;

export class CarView {
  readonly root: THREE.Object3D;
  readonly wheels: THREE.Object3D[] = [];
  readonly wheelRest: THREE.Vector3[] = [];
  private readonly brake: THREE.MeshStandardMaterial | null = null;
  private readonly brakeOff: THREE.Color;
  private readonly brakeOn: THREE.Color;
  private readonly brakeStrength: number;
  readonly flames: THREE.Mesh[] = [];
  private braking = false;

  constructor(template: THREE.Object3D, paint: THREE.Texture | null, manifest: Manifest) {
    this.root = template.clone(true);
    const bl = manifest.car.materials.brake_light;
    this.brakeOff = linear(bl.emissive_off);
    this.brakeOn = linear(bl.emissive_on);
    this.brakeStrength = bl.emissive_strength_on;
    const found: { brake: THREE.MeshStandardMaterial | null } = { brake: null };
    const names = ["wheel_FL", "wheel_FR", "wheel_RL", "wheel_RR"];
    this.root.traverse((o) => {
      const i = names.indexOf(o.name);
      if (i >= 0) { this.wheels[i] = o; this.wheelRest[i] = o.position.clone(); }
      if (o.name === "collider_body") o.visible = false;
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh !== true) return;
      mesh.castShadow = true;
      const m = mesh.material as THREE.MeshStandardMaterial;
      if (m.name === "car_paint_red" && paint !== null) {
        const own = m.clone();
        own.map = paint;
        mesh.material = own;
      } else if (m.name === "car_brake_light") {
        found.brake = m.clone();
        mesh.material = found.brake;
      }
    });
    this.brake = found.brake;
    if (this.brake !== null) { this.brake.emissive = this.brakeOff.clone(); this.brake.emissiveIntensity = 1; }

    // nitro flames: emissive cones at the tail pipes, pointing backwards (+Z)
    const flameGeo = new THREE.ConeGeometry(0.09, 0.7, 8, 1, true);
    flameGeo.rotateX(Math.PI / 2);      // tip towards +Z
    flameGeo.translate(0, 0, 0.35);
    for (const name of ["exhaust_L", "exhaust_R"]) {
      const at = this.root.getObjectByName(name);
      const flame = new THREE.Mesh(flameGeo, new THREE.MeshBasicMaterial({ color: 0x66aaff }));
      flame.visible = false;
      if (at !== undefined) at.add(flame); else this.root.add(flame);
      this.flames.push(flame);
    }
  }

  setBraking(on: boolean): void {
    if (on === this.braking || this.brake === null) return;
    this.braking = on;
    if (on) { this.brake.emissive.copy(this.brakeOn); this.brake.emissiveIntensity = this.brakeStrength; }
    else { this.brake.emissive.copy(this.brakeOff); this.brake.emissiveIntensity = 1; }
  }

  setNitro(on: boolean, t: number): void {
    for (let i = 0; i < this.flames.length; i++) {
      const f = this.flames[i]!;
      f.visible = on;
      if (on) {
        const k = 0.75 + 0.35 * Math.abs(Math.sin(t * 37 + i * 1.7));
        f.scale.set(1 + 0.2 * k, 1 + 0.2 * k, k * 1.6);
      }
    }
  }
}
