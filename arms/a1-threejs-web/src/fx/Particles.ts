import * as THREE from 'three';

const VERT = /* glsl */ `
attribute float size;
attribute vec4 rgba;
varying vec4 vColor;
uniform float uScale;
#include <fog_pars_vertex>
void main() {
  vColor = rgba;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * uScale / max(0.1, -mvPosition.z);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
varying vec4 vColor;
#include <fog_pars_fragment>
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d) * 4.0;
  if (r > 1.0) discard;
  gl_FragColor = vec4(vColor.rgb, vColor.a * (1.0 - r) * (1.0 - r));
  #include <fog_fragment>
}`;

/** CPU-simulated point sprites in one draw call (smoke puffs or sparks). */
export class Particles {
  readonly points: THREE.Points;
  private readonly max: number;
  private readonly p: Float32Array;
  private readonly v: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size0: Float32Array;
  private readonly grow: Float32Array;
  private readonly sizes: Float32Array;
  private readonly rgba: Float32Array;
  private readonly base: Float32Array;
  private cursor = 0;
  private readonly mat: THREE.ShaderMaterial;
  private readonly drag: number;
  private readonly gravity: number;

  constructor(max: number, additive: boolean, drag: number, gravity: number) {
    this.max = max;
    this.drag = drag;
    this.gravity = gravity;
    this.p = new Float32Array(max * 3);
    this.v = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.sizes = new Float32Array(max);
    this.rgba = new Float32Array(max * 4);
    this.base = new Float32Array(max * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.p, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('rgba', new THREE.BufferAttribute(this.rgba, 4).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: 400 } }]),
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: true,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
  }

  setViewport(heightPx: number, fovDeg: number): void {
    this.mat.uniforms.uScale.value = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    size: number,
    grow: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    this.p[i * 3] = x;
    this.p[i * 3 + 1] = y;
    this.p[i * 3 + 2] = z;
    this.v[i * 3] = vx;
    this.v[i * 3 + 1] = vy;
    this.v[i * 3 + 2] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size0[i] = size;
    this.grow[i] = grow;
    this.base[i * 4] = r;
    this.base[i * 4 + 1] = g;
    this.base[i * 4 + 2] = b;
    this.base[i * 4 + 3] = a;
  }

  update(dt: number): void {
    const dragK = Math.exp(-this.drag * dt);
    let alive = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        this.sizes[i] = 0;
        this.rgba[i * 4 + 3] = 0;
        continue;
      }
      alive++;
      this.life[i] -= dt;
      const t = 1 - Math.max(0, this.life[i]) / this.maxLife[i];
      const o = i * 3;
      this.v[o] *= dragK;
      this.v[o + 1] = this.v[o + 1] * dragK - this.gravity * dt;
      this.v[o + 2] *= dragK;
      this.p[o] += this.v[o] * dt;
      this.p[o + 1] += this.v[o + 1] * dt;
      this.p[o + 2] += this.v[o + 2] * dt;
      this.sizes[i] = this.size0[i] + this.grow[i] * t;
      this.rgba[i * 4] = this.base[i * 4];
      this.rgba[i * 4 + 1] = this.base[i * 4 + 1];
      this.rgba[i * 4 + 2] = this.base[i * 4 + 2];
      this.rgba[i * 4 + 3] = this.base[i * 4 + 3] * (1 - t);
    }
    const g = this.points.geometry;
    this.points.visible = alive > 0;
    if (alive > 0) {
      (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (g.getAttribute('size') as THREE.BufferAttribute).needsUpdate = true;
      (g.getAttribute('rgba') as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  clear(): void {
    this.life.fill(0);
  }
}
