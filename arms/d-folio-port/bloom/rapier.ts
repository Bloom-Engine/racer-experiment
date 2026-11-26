/**
 * `@dimforge/rapier3d` for the Bloom build: the part of Rapier's API folio-2025 uses, on Bloom's Jolt
 * physics (@bloomengine/engine/physics). Rapier is Rust compiled to WebAssembly (wasm-bindgen glue
 * importing a .wasm module), which a Perry binary doesn't run (PORT_LOG.md, "Rapier").
 *
 * What maps how:
 *  - a RigidBody with its colliders -> one Jolt body (a static compound of the colliders' shapes),
 *    rebuilt while colliders are added. Rapier gives each collider a mass (density or setMass); Jolt
 *    derives mass from volume (1000 kg/m³) and has no mass setter. The facade keeps Rapier's masses
 *    and inertias: mass() answers in Rapier units, and every impulse is converted so that it changes
 *    the velocity exactly as in Rapier (linear by the mass ratio, angular through both inertias).
 *    Only contacts between bodies use Jolt's own masses.
 *  - collision groups -> Jolt object layers 3..6 with a collision matrix computed from the groups
 *    (one layer per body: a body's colliders share its first collider's groups).
 *  - setEnabled(false) -> the Jolt body is removed and recreated when enabled again.
 *  - contact-force events -> Jolt contact-added events, with the force estimated from the bodies'
 *    approach speed before the step (Rapier reports the solver's contact force).
 *  - DynamicRayCastVehicleController -> Rapier's ray-cast vehicle (itself Bullet's), ported below:
 *    Jolt raycasts for the suspension, the same spring/damper, friction and slip equations.
 */
import * as P from "@bloomengine/engine/physics";

interface V3 { x: number; y: number; z: number }
interface Q4 { x: number; y: number; z: number; w: number }

// ------------------------------------------------------------------ small math

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });
const add = (a: V3, b: V3): V3 => v(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a: V3, b: V3): V3 => v(a.x - b.x, a.y - b.y, a.z - b.z);
const scale = (a: V3, s: number): V3 => v(a.x * s, a.y * s, a.z * s);
const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: V3, b: V3): V3 => v(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const len = (a: V3): number => Math.sqrt(dot(a, a));
const norm = (a: V3): V3 => { const l = len(a); return l > 1e-12 ? scale(a, 1 / l) : v(0, 0, 0); };
function rotate(q: Q4, p: V3): V3 {
  // q * p * q^-1
  const ix = q.w * p.x + q.y * p.z - q.z * p.y, iy = q.w * p.y + q.z * p.x - q.x * p.z;
  const iz = q.w * p.z + q.x * p.y - q.y * p.x, iw = -q.x * p.x - q.y * p.y - q.z * p.z;
  return v(ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y, iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z, iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x);
}
const conj = (q: Q4): Q4 => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
function axisAngle(axis: V3, angle: number): Q4 { const s = Math.sin(angle / 2); return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(angle / 2) }; }
const quat = (q: Q4 | undefined | null): Q4 => q ? { x: q.x, y: q.y, z: q.z, w: q.w } : { x: 0, y: 0, z: 0, w: 1 };

// ------------------------------------------------------------------ enums

export const CoefficientCombineRule = { Average: 0, Min: 1, Multiply: 2, Max: 3 } as const;
export const ActiveEvents = { NONE: 0, COLLISION_EVENTS: 1, CONTACT_FORCE_EVENTS: 2 } as const;
export const RigidBodyType = { Dynamic: 0, Fixed: 1, KinematicPositionBased: 2, KinematicVelocityBased: 3 } as const;

// ------------------------------------------------------------------ descriptions

export class RigidBodyDesc {
  status: number;
  translation = v(0, 0, 0);
  rotation: Q4 = { x: 0, y: 0, z: 0, w: 1 };
  canSleep = true;
  sleeping = false;
  enabled = true;
  linearDamping = 0;
  angularDamping = 0;
  gravityScale = 1;
  constructor(status: number) { this.status = status; }
  static dynamic(): RigidBodyDesc { return new RigidBodyDesc(RigidBodyType.Dynamic); }
  static fixed(): RigidBodyDesc { return new RigidBodyDesc(RigidBodyType.Fixed); }
  static kinematicPositionBased(): RigidBodyDesc { return new RigidBodyDesc(RigidBodyType.KinematicPositionBased); }
  static kinematicVelocityBased(): RigidBodyDesc { return new RigidBodyDesc(RigidBodyType.KinematicVelocityBased); }
  setTranslation(x: number, y: number, z: number): this { this.translation = v(x, y, z); return this; }
  setRotation(q: Q4): this { this.rotation = quat(q); return this; }
  setCanSleep(b: boolean): this { this.canSleep = b; return this; }
  setSleeping(b: boolean): this { this.sleeping = b; return this; }
  setEnabled(b: boolean): this { this.enabled = b; return this; }
  setLinearDamping(d: number): this { this.linearDamping = d; return this; }
  setAngularDamping(d: number): this { this.angularDamping = d; return this; }
  setGravityScale(g: number): this { this.gravityScale = g; return this; }
}

type ShapeSpec =
  | { kind: "cuboid"; hx: number; hy: number; hz: number }
  | { kind: "ball"; r: number }
  | { kind: "cylinder"; hh: number; r: number }
  | { kind: "trimesh"; vertices: ArrayLike<number>; indices: ArrayLike<number> }
  | { kind: "hull"; points: ArrayLike<number> }
  | { kind: "heightfield"; nrows: number; ncols: number; heights: ArrayLike<number>; scale: V3 };

export class ColliderDesc {
  shape: ShapeSpec;
  translation = v(0, 0, 0);
  rotation: Q4 = { x: 0, y: 0, z: 0, w: 1 };
  density = 1;
  mass: number | null = null;
  centerOfMass: V3 | null = null;
  principalInertia: V3 | null = null;
  friction = 0.5;
  restitution = 0;
  groups = 0xffffffff;
  activeEvents = 0;
  forceThreshold = 0;
  constructor(shape: ShapeSpec) { this.shape = shape; }
  static cuboid(hx: number, hy: number, hz: number): ColliderDesc { return new ColliderDesc({ kind: "cuboid", hx, hy, hz }); }
  static ball(r: number): ColliderDesc { return new ColliderDesc({ kind: "ball", r }); }
  static cylinder(hh: number, r: number): ColliderDesc { return new ColliderDesc({ kind: "cylinder", hh, r }); }
  static trimesh(vertices: ArrayLike<number>, indices: ArrayLike<number>): ColliderDesc { return new ColliderDesc({ kind: "trimesh", vertices, indices }); }
  static convexHull(points: ArrayLike<number>): ColliderDesc | null { return points.length >= 9 ? new ColliderDesc({ kind: "hull", points }) : null; }
  static heightfield(nrows: number, ncols: number, heights: ArrayLike<number>, s: V3): ColliderDesc { return new ColliderDesc({ kind: "heightfield", nrows, ncols, heights, scale: v(s.x, s.y, s.z) }); }
  setTranslation(x: number, y: number, z: number): this { this.translation = v(x, y, z); return this; }
  setRotation(q: Q4): this { this.rotation = quat(q); return this; }
  setDensity(d: number): this { this.density = d; return this; }
  setMass(m: number): this { this.mass = m; this.centerOfMass = null; this.principalInertia = null; return this; }
  setMassProperties(m: number, com: V3, inertia: V3, _frame?: Q4): this { this.mass = m; this.centerOfMass = v(com.x, com.y, com.z); this.principalInertia = v(inertia.x, inertia.y, inertia.z); return this; }
  setFriction(f: number): this { this.friction = f; return this; }
  setFrictionCombineRule(_r: number): this { return this; }   // Jolt combines frictions itself (geometric mean)
  setRestitution(r: number): this { this.restitution = r; return this; }
  setRestitutionCombineRule(_r: number): this { return this; }
  setCollisionGroups(g: number): this { this.groups = g >>> 0; return this; }
  setSolverGroups(_g: number): this { return this; }
  setActiveEvents(e: number): this { this.activeEvents = e; return this; }
  setContactForceEventThreshold(t: number): this { this.forceThreshold = t; return this; }
  setSensor(_b: boolean): this { return this; }
}

// ------------------------------------------------------------------ collision groups -> object layers

/** Jolt object layers for distinct Rapier collision groups (3..15; 0..2 are Bloom's defaults). */
const layerOfGroups = new Map<number, number>();
const groupsOfLayer: number[] = [];
const VEHICLE_SHIFT = 100000;   // marks the vehicle's own layer in the map key

function collides(a: number, b: number): boolean {
  return ((a >>> 16) & (b & 0xffff)) !== 0 && ((b >>> 16) & (a & 0xffff)) !== 0;
}

function layerFor(world: World, groups: number, vehicle = false): number {
  const key = vehicle ? groups + VEHICLE_SHIFT * 65536 : groups;
  let layer = layerOfGroups.get(key);
  if (layer !== undefined) return layer;
  layer = 3 + layerOfGroups.size;
  if (layer >= P.MAX_OBJECT_LAYERS) { console.error("rapier on Jolt: more than 13 distinct collision groups"); layer = P.MAX_OBJECT_LAYERS - 1; }
  layerOfGroups.set(key, layer);
  groupsOfLayer[layer] = groups;
  for (let other = 0; other < P.MAX_OBJECT_LAYERS; other++) {
    const g = groupsOfLayer[other];
    P.setLayerCollides(world.handle, layer, other, g === undefined ? false : collides(groups, g));
  }
  return layer;
}

// ------------------------------------------------------------------ colliders

let nextColliderHandle = 1;

export class Collider {
  readonly handle: number;
  readonly desc: ColliderDesc;
  private readonly body: RigidBody;
  constructor(desc: ColliderDesc, body: RigidBody) { this.handle = nextColliderHandle++; this.desc = desc; this.body = body; }
  parent(): RigidBody { return this.body; }
  setFriction(f: number): void { this.desc.friction = f; this.body.syncMaterial(); }
  setRestitution(r: number): void { this.desc.restitution = r; this.body.syncMaterial(); }
  setActiveEvents(e: number): void { this.desc.activeEvents = e; }
  setContactForceEventThreshold(t: number): void { this.desc.forceThreshold = t; }
  setCollisionGroups(g: number): void { this.desc.groups = g >>> 0; this.body.rebuild(); }
  friction(): number { return this.desc.friction; }
  restitution(): number { return this.desc.restitution; }
  mass(): number { return this.body.colliderMass(this); }
  translation(): V3 { return add(this.body.translation(), rotate(this.body.rotation(), this.desc.translation)); }
}

interface MassInfo { mass: number; com: V3; inertia: V3 }

/** Volume, local centroid offset 0, and the unit-mass diagonal inertia of a shape (about its centroid, in its frame). */
function shapeGeometry(s: ShapeSpec, handle: number): { volume: number; unitInertia: V3 } {
  switch (s.kind) {
    case "cuboid": { const a = s.hx, b = s.hy, c = s.hz; return { volume: 8 * a * b * c, unitInertia: v((b * b + c * c) / 3, (a * a + c * c) / 3, (a * a + b * b) / 3) }; }
    case "ball": return { volume: (4 / 3) * Math.PI * s.r ** 3, unitInertia: v(0.4 * s.r * s.r, 0.4 * s.r * s.r, 0.4 * s.r * s.r) };
    case "cylinder": { const h = 2 * s.hh, r = s.r; const side = (3 * r * r + h * h) / 12; return { volume: Math.PI * r * r * h, unitInertia: v(side, 0.5 * r * r, side) }; }
    default: {
      if (handle === 0) return { volume: 0, unitInertia: v(0, 0, 0) };
      const b = P.shapeBounds(handle);
      const a = (b.max.x - b.min.x) / 2, bb = (b.max.y - b.min.y) / 2, c = (b.max.z - b.min.z) / 2;
      return { volume: P.shapeVolume(handle), unitInertia: v((bb * bb + c * c) / 3, (a * a + c * c) / 3, (a * a + bb * bb) / 3) };
    }
  }
}

function toVec3s(a: ArrayLike<number>): V3[] {
  const out: V3[] = [];
  for (let i = 0; i + 2 < a.length; i += 3) out.push(v(a[i] ?? 0, a[i + 1] ?? 0, a[i + 2] ?? 0));
  return out;
}

function makeShape(s: ShapeSpec, dynamic: boolean): number {
  switch (s.kind) {
    case "cuboid": { const r = Math.min(0.05, s.hx * 0.5, s.hy * 0.5, s.hz * 0.5); return P.boxShape(v(s.hx, s.hy, s.hz), r); }
    case "ball": return P.sphereShape(s.r);
    case "cylinder": return P.cylinderShape(s.hh, s.r, Math.min(0.05, s.hh * 0.5, s.r * 0.5));
    case "hull": return P.convexHullShape(toVec3s(s.points), 0.01);
    case "trimesh": {
      const verts = toVec3s(s.vertices);
      // Jolt meshes are for static bodies: a moving trimesh becomes its convex hull
      if (dynamic) return P.convexHullShape(verts, 0.01);
      const idx: number[] = []; for (let i = 0; i < s.indices.length; i++) idx.push(s.indices[i] ?? 0);
      return P.meshShape(verts, idx);
    }
    case "heightfield": {
      // Rapier: (nrows+1) x (ncols+1) heights, column-major (row i along z, column j along x), centred
      // on the body; Jolt: N x N samples, row-major by z, from `offset`, spaced by `scale`
      const n = s.nrows + 1;
      if (s.ncols + 1 !== n) console.error("rapier on Jolt: a non-square heightfield is cropped");
      const samples: number[] = new Array(n * n);
      for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) samples[z * n + x] = s.heights[z + x * n] ?? 0;
      const sx = s.scale.x / s.nrows, sz = s.scale.z / s.ncols;
      // Jolt wants the sample count to be a multiple of its block size (2, 4 or 8)
      const block = n % 4 === 0 ? 4 : n % 2 === 0 ? 2 : 0;
      if (block === 0) {
        // pad to an even count by repeating the last row/column
        const m = n + 1, padded: number[] = new Array(m * m);
        for (let z = 0; z < m; z++) for (let x = 0; x < m; x++) padded[z * m + x] = samples[Math.min(z, n - 1) * n + Math.min(x, n - 1)] ?? 0;
        return P.heightfieldShape(padded, m, v(-s.scale.x / 2, 0, -s.scale.z / 2), v(sx, s.scale.y, sz), 2);
      }
      return P.heightfieldShape(samples, n, v(-s.scale.x / 2, 0, -s.scale.z / 2), v(sx, s.scale.y, sz), block);
    }
  }
}

// ------------------------------------------------------------------ rigid bodies

const JOLT_DENSITY = 1000;
const TRACE = process.env["FOLIO_TRACE"] === "1";

export class RigidBody {
  readonly handle: number;
  readonly world: World;
  readonly desc: RigidBodyDesc;
  userData: unknown = undefined;
  readonly colliders: Collider[] = [];
  /** the Jolt body, 0 while disabled or without colliders */
  jolt = 0;
  private enabled: boolean;
  private shapes: number[] = [];
  private compound = 0;
  // state while there is no Jolt body
  private pos: V3;
  private rot: Q4;
  private _linvel = v(0, 0, 0);
  private _angvel = v(0, 0, 0);
  private sleeping: boolean;
  private linDamp: number;
  private angDamp: number;
  // Rapier mass properties (body frame) and Jolt's, for converting impulses
  rapier: MassInfo = { mass: 0, com: v(0, 0, 0), inertia: v(0, 0, 0) };
  joltInertia = v(1, 1, 1);
  joltMass = 1;
  layer = 0;
  vehicle = false;
  nextKinematic: V3 | null = null;
  nextKinematicRotation: Q4 | null = null;

  constructor(world: World, handle: number, desc: RigidBodyDesc) {
    this.world = world; this.handle = handle; this.desc = desc;
    this.pos = { ...desc.translation }; this.rot = quat(desc.rotation);
    this.enabled = desc.enabled; this.sleeping = desc.sleeping;
    this.linDamp = desc.linearDamping; this.angDamp = desc.angularDamping;
  }

  get dynamic(): boolean { return this.desc.status === RigidBodyType.Dynamic; }
  get kinematic(): boolean { return this.desc.status === RigidBodyType.KinematicPositionBased || this.desc.status === RigidBodyType.KinematicVelocityBased; }

  addCollider(c: Collider): void { this.colliders.push(c); this.rebuild(); }

  colliderMass(c: Collider): number {
    const d = c.desc;
    if (d.mass !== null) return d.mass;
    return d.density * shapeGeometry(d.shape, this.shapes[this.colliders.indexOf(c)] ?? 0).volume;
  }

  /** (Re)creates the Jolt body from the colliders, keeping the current state. */
  rebuild(): void {
    if (this.jolt !== 0) { this.capture(); this.world.forget(this); P.destroyBody(this.jolt); this.jolt = 0; }
    for (const s of this.shapes) P.releaseShape(s);
    if (this.compound !== 0) P.releaseShape(this.compound);
    this.shapes = []; this.compound = 0;
    if (this.colliders.length === 0) return;
    const moving = !this.kinematic && this.dynamic;
    this.shapes = this.colliders.map((c) => makeShape(c.desc.shape, moving || this.kinematic));
    this.computeMass();
    if (!this.enabled) return;
    this.create();
  }

  private computeMass(): void {
    // Rapier: each collider's mass (density x volume, or set), centre and inertia; Jolt: 1000 kg/m³ everywhere
    let mR = 0, mJ = 0; let cR = v(0, 0, 0), cJ = v(0, 0, 0);
    const parts = this.colliders.map((c, i) => {
      const g = shapeGeometry(c.desc.shape, this.shapes[i] ?? 0);
      const d = c.desc;
      const massR = d.mass !== null ? d.mass : d.density * g.volume;
      const comR = d.centerOfMass !== null ? add(d.translation, rotate(d.rotation, d.centerOfMass)) : d.translation;
      const inertiaR = d.principalInertia !== null ? d.principalInertia : scale(g.unitInertia, massR);
      const massJ = JOLT_DENSITY * g.volume;
      mR += massR; cR = add(cR, scale(comR, massR));
      mJ += massJ; cJ = add(cJ, scale(d.translation, massJ));
      return { massR, comR, inertiaR, massJ, unitInertia: g.unitInertia, pos: d.translation };
    });
    const comR = mR > 0 ? scale(cR, 1 / mR) : v(0, 0, 0);
    const comJ = mJ > 0 ? scale(cJ, 1 / mJ) : v(0, 0, 0);
    // both inertias about Rapier's centre of mass, which the Jolt body gets too (offset COM shape)
    let iR = v(0, 0, 0), iJ = v(0, 0, 0);
    for (const p of parts) {
      const dR = sub(p.comR, comR), dJ = sub(p.pos, comR);
      iR = add(iR, add(p.inertiaR, scale(v(dR.y * dR.y + dR.z * dR.z, dR.x * dR.x + dR.z * dR.z, dR.x * dR.x + dR.y * dR.y), p.massR)));
      iJ = add(iJ, add(scale(p.unitInertia, p.massJ), scale(v(dJ.y * dJ.y + dJ.z * dJ.z, dJ.x * dJ.x + dJ.z * dJ.z, dJ.x * dJ.x + dJ.y * dJ.y), p.massJ)));
    }
    this.rapier = { mass: mR, com: comR, inertia: iR };
    this.joltInertia = iJ;
    this.joltMass = mJ;
    this.comOffset = sub(comR, comJ);
  }
  private comOffset = v(0, 0, 0);

  private create(): void {
    const children = this.colliders.map((c, i) => ({ shape: this.shapes[i] ?? 0, local: { position: c.desc.translation, rotation: c.desc.rotation } })).filter((c) => c.shape !== 0);
    if (children.length === 0) return;
    let shape = this.compound = P.compoundShape(children);
    if (this.dynamic && len(this.comOffset) > 1e-4) shape = this.compound = P.offsetCenterOfMassShape(this.compound, this.comOffset);
    const motion = this.dynamic ? P.MotionType.DYNAMIC : this.kinematic ? P.MotionType.KINEMATIC : P.MotionType.STATIC;
    const first = this.colliders[0]!.desc;
    this.layer = layerFor(this.world, first.groups, this.vehicle);
    this.jolt = P.createBody(this.world.handle, shape, {
      motionType: motion, position: this.pos, rotation: this.rot, objectLayer: this.layer,
      linearVelocity: this._linvel, angularVelocity: this._angvel,
      friction: first.friction, restitution: first.restitution,
      linearDamping: this.linDamp, angularDamping: this.angDamp, gravityFactor: this.desc.gravityScale,
      allowSleeping: this.desc.canSleep, useCcd: this.dynamic && this.desc.canSleep === false,
    });
    if (this.jolt === 0) { console.error("rapier on Jolt: body creation failed"); return; }
    if (this.dynamic) { const m = P.getBodyMass(this.jolt); if (m > 0 && isFinite(m)) { const k = m / Math.max(1e-9, this.joltMass); this.joltInertia = scale(this.joltInertia, k); this.joltMass = m; } }
    if (this.sleeping) P.deactivateBody(this.jolt);
    this.world.remember(this);
  }

  private capture(): void {
    if (this.jolt === 0) return;
    this.pos = P.getBodyPosition(this.jolt); this.rot = P.getBodyRotation(this.jolt);
    this._linvel = P.getLinearVelocity(this.jolt); this._angvel = P.getAngularVelocity(this.jolt);
    this.sleeping = !P.isBodyActive(this.jolt);
  }

  syncMaterial(): void {
    if (this.jolt === 0) return;
    const first = this.colliders[0]?.desc;
    if (first === undefined) return;
    P.setFriction(this.jolt, first.friction); P.setRestitution(this.jolt, first.restitution);
  }

  // ---- Rapier API

  collider(i: number): Collider { return this.colliders[i]!; }
  numColliders(): number { return this.colliders.length; }
  bodyType(): number { return this.desc.status; }
  isDynamic(): boolean { return this.dynamic; }
  isFixed(): boolean { return this.desc.status === RigidBodyType.Fixed; }
  isKinematic(): boolean { return this.kinematic; }
  mass(): number { return this.dynamic ? this.rapier.mass : 0; }

  translation(target?: V3): V3 {
    const p = this.jolt !== 0 ? P.getBodyPosition(this.jolt) : this.pos;
    if (target) { target.x = p.x; target.y = p.y; target.z = p.z; return target; }
    return { x: p.x, y: p.y, z: p.z };
  }
  rotation(): Q4 { const r = this.jolt !== 0 ? P.getBodyRotation(this.jolt) : this.rot; return { x: r.x, y: r.y, z: r.z, w: r.w }; }
  linvel(): V3 { return this.jolt !== 0 ? P.getLinearVelocity(this.jolt) : { ...this._linvel }; }
  angvel(): V3 { return this.jolt !== 0 ? P.getAngularVelocity(this.jolt) : { ...this._angvel }; }
  /** World position of the centre of mass. */
  centerOfMass(): V3 { return add(this.translation(), rotate(this.rotation(), this.rapier.com)); }
  velocityAtPoint(p: V3): V3 { return add(this.linvel(), cross(this.angvel(), sub(p, this.centerOfMass()))); }

  setTranslation(t: V3, wake = true): void {
    this.pos = v(t.x, t.y, t.z);
    if (this.jolt !== 0) P.setBodyPosition(this.jolt, this.pos, wake);
  }
  setRotation(q: Q4, wake = true): void {
    this.rot = quat(q);
    if (this.jolt !== 0) P.setBodyRotation(this.jolt, this.rot, wake);
  }
  setLinvel(l: V3, wake = true): void {
    this._linvel = v(l.x, l.y, l.z);
    if (this.jolt !== 0 && !this.isFixed()) { P.setLinearVelocity(this.jolt, this._linvel); if (wake) P.activateBody(this.jolt); }
  }
  setAngvel(a: V3, wake = true): void {
    this._angvel = v(a.x, a.y, a.z);
    if (this.jolt !== 0 && !this.isFixed()) { P.setAngularVelocity(this.jolt, this._angvel); if (wake) P.activateBody(this.jolt); }
  }
  setNextKinematicTranslation(t: V3): void { this.nextKinematic = v(t.x, t.y, t.z); }
  setNextKinematicRotation(q: Q4): void { this.nextKinematicRotation = quat(q); }
  setLinearDamping(d: number): void { if (d === this.linDamp) return; this.linDamp = d; if (this.jolt !== 0) P.setLinearDamping(this.jolt, d); }
  setAngularDamping(d: number): void { if (d === this.angDamp) return; this.angDamp = d; if (this.jolt !== 0) P.setAngularDamping(this.jolt, d); }
  linearDamping(): number { return this.linDamp; }
  angularDamping(): number { return this.angDamp; }
  setGravityScale(g: number, _wake = true): void { this.desc.gravityScale = g; if (this.jolt !== 0) P.setGravityFactor(this.jolt, g); }
  gravityScale(): number { return this.desc.gravityScale; }

  isSleeping(): boolean { return this.jolt !== 0 ? !P.isBodyActive(this.jolt) : this.sleeping; }
  sleep(): void { this.sleeping = true; if (this.jolt !== 0) P.deactivateBody(this.jolt); }
  wakeUp(): void { this.sleeping = false; if (this.jolt !== 0) P.activateBody(this.jolt); }
  isEnabled(): boolean { return this.enabled; }
  setEnabled(b: boolean): void {
    if (b === this.enabled) return;
    this.enabled = b;
    if (!b) {
      if (this.jolt !== 0) { this.capture(); this.world.forget(this); P.destroyBody(this.jolt); this.jolt = 0; }
      if (this.compound !== 0) { P.releaseShape(this.compound); this.compound = 0; }
    } else if (this.colliders.length > 0) this.create();
  }
  resetForces(_wake = true): void {}   // Jolt clears accumulated forces every step
  resetTorques(_wake = true): void {}

  // impulses: Rapier units in, the same change of velocity out
  applyImpulse(j: V3, _wake = true): void {
    if (this.jolt === 0 || !this.dynamic || this.rapier.mass <= 0) return;
    P.addImpulse(this.jolt, scale(j, this.joltMass / this.rapier.mass));
  }
  applyTorqueImpulse(t: V3, _wake = true): void {
    if (this.jolt === 0 || !this.dynamic) return;
    P.addAngularImpulse(this.jolt, this.convertAngular(t));
  }
  applyImpulseAtPoint(j: V3, point: V3, wake = true): void {
    this.applyImpulse(j, wake);
    this.applyTorqueImpulse(cross(sub(point, this.centerOfMass()), j), wake);
  }
  addForce(f: V3, _wake = true): void { if (this.jolt !== 0 && this.rapier.mass > 0) P.addForce(this.jolt, scale(f, this.joltMass / this.rapier.mass)); }
  addTorque(t: V3, _wake = true): void { if (this.jolt !== 0) P.addTorque(this.jolt, this.convertAngular(t)); }

  /** A Rapier angular impulse (world frame) -> the Jolt one that changes the angular velocity alike. */
  private convertAngular(t: V3): V3 {
    const r = this.rotation();
    const local = rotate(conj(r), t);
    const iR = this.rapier.inertia, iJ = this.joltInertia;
    const k = (a: number, b: number): number => (a > 1e-9 ? b / a : 0);
    return rotate(r, v(local.x * k(iR.x, iJ.x), local.y * k(iR.y, iJ.y), local.z * k(iR.z, iJ.z)));
  }
  /** Rapier's inverse effective mass along `dir` at `point` (used by the vehicle). */
  impulseDenominator(point: V3, dir: V3): number {
    if (!this.dynamic || this.rapier.mass <= 0) return 0;
    const r = this.rotation();
    const c = rotate(conj(r), cross(sub(point, this.centerOfMass()), dir));
    const i = this.rapier.inertia;
    const inv = (a: number): number => (a > 1e-9 ? 1 / a : 0);
    return 1 / this.rapier.mass + c.x * c.x * inv(i.x) + c.y * c.y * inv(i.y) + c.z * c.z * inv(i.z);
  }
}

// ------------------------------------------------------------------ events

export class TempContactForceEvent {
  constructor(private readonly c1: number, private readonly c2: number, private readonly force: number, private readonly dir: V3) {}
  collider1(): number { return this.c1; }
  collider2(): number { return this.c2; }
  totalForce(): V3 { return scale(this.dir, this.force); }
  totalForceMagnitude(): number { return this.force; }
  maxForceDirection(): V3 { return this.dir; }
  maxForceMagnitude(): number { return this.force; }
}

export class EventQueue {
  forces: TempContactForceEvent[] = [];
  collisions: Array<[number, number, boolean]> = [];
  constructor(_autoDrain = true) {}
  drainContactForceEvents(f: (e: TempContactForceEvent) => void): void { const list = this.forces; this.forces = []; for (const e of list) f(e); }
  drainCollisionEvents(f: (h1: number, h2: number, started: boolean) => void): void { const list = this.collisions; this.collisions = []; for (const [a, b, s] of list) f(a, b, s); }
  clear(): void { this.forces = []; this.collisions = []; }
  free(): void {}
}

// ------------------------------------------------------------------ world

let worlds = 0;

export class World {
  readonly handle: number;
  gravity: V3;
  timestep = 1 / 60;
  private bodies: RigidBody[] = [];
  private byJolt = new Map<number, RigidBody>();
  private collidersByHandle = new Map<number, Collider>();
  private vehicles: DynamicRayCastVehicleController[] = [];
  private nextBody = 1;
  private optimized = false;

  constructor(gravity: V3) {
    this.gravity = v(gravity.x, gravity.y, gravity.z);
    this.handle = P.createWorld({ gravity: this.gravity, maxBodies: 8192 });
    worlds++;
  }

  remember(b: RigidBody): void { this.byJolt.set(b.jolt, b); this.optimized = false; }
  forget(b: RigidBody): void { this.byJolt.delete(b.jolt); }

  createRigidBody(desc: RigidBodyDesc): RigidBody {
    const b = new RigidBody(this, this.nextBody++, desc);
    this.bodies.push(b);
    return b;
  }
  createCollider(desc: ColliderDesc, parent: RigidBody): Collider {
    const c = new Collider(desc, parent);
    this.collidersByHandle.set(c.handle, c);
    parent.addCollider(c);
    return c;
  }
  getCollider(handle: number): Collider { return this.collidersByHandle.get(handle)!; }
  getRigidBody(handle: number): RigidBody | undefined { return this.bodies.find((b) => b.handle === handle); }
  removeRigidBody(b: RigidBody): void { b.setEnabled(false); this.bodies = this.bodies.filter((x) => x !== b); }
  createVehicleController(chassis: RigidBody): DynamicRayCastVehicleController {
    const c = new DynamicRayCastVehicleController(this, chassis);
    this.vehicles.push(c);
    return c;
  }
  debugRender(): { vertices: Float32Array; colors: Float32Array } { return { vertices: new Float32Array(0), colors: new Float32Array(0) }; }

  /** Closest hit along a ray, skipping the given layer (the vehicle's own). Rapier's cast_ray_and_get_normal. */
  castRayExcluding(origin: V3, dir: V3, maxToi: number, excludeLayer: number): { body: RigidBody | undefined; toi: number; normal: V3; point: V3 } | null {
    const length = len(dir);
    if (length < 1e-9) return null;
    const mask = (P.ALL_LAYERS_MASK & ~(1 << excludeLayer)) >>> 0;
    const hit = P.raycast(this.handle, origin, scale(dir, 1 / length), maxToi * length, mask);
    if (hit === null) return null;
    return { body: this.byJolt.get(hit.body), toi: hit.fraction * maxToi, normal: hit.normal, point: hit.point };
  }

  step(events?: EventQueue): void {
    const dt = this.timestep;
    if (!(dt > 0)) return;
    if (!this.optimized) { P.optimizeBroadphase(this.handle); this.optimized = true; }
    // kinematic bodies: move to their next pose, or stand still (Jolt keeps a kinematic body's velocity)
    for (const b of this.bodies) {
      if (!b.kinematic || b.jolt === 0) continue;
      if (b.nextKinematic !== null || b.nextKinematicRotation !== null) {
        P.moveKinematic(b.jolt, { position: b.nextKinematic ?? P.getBodyPosition(b.jolt), rotation: b.nextKinematicRotation ?? P.getBodyRotation(b.jolt) }, dt);
        b.nextKinematic = null; b.nextKinematicRotation = null;
      } else if (P.isBodyActive(b.jolt)) { P.setLinearVelocity(b.jolt, v(0, 0, 0)); P.setAngularVelocity(b.jolt, v(0, 0, 0)); }
    }
    // velocities before the step, for bodies that report contact forces
    const before = new Map<RigidBody, V3>();
    if (events) for (const b of this.byJolt.values()) if (b.colliders.some((c) => (c.desc.activeEvents & ActiveEvents.CONTACT_FORCE_EVENTS) !== 0)) before.set(b, b.linvel());
    P.stepVariable(this.handle, dt);
    const contacts = P.popContacts();
    if (!events || before.size === 0) return;
    for (const c of contacts) {
      if (c.event !== P.ContactEvent.ADDED) continue;
      // Jolt reports speculative contacts (not touching yet: negative depth) too; Rapier's force events need a touch
      if (!(c.penetrationDepth >= 0)) continue;
      const a = this.byJolt.get(c.bodyA), b = this.byJolt.get(c.bodyB);
      if (a === undefined || b === undefined) continue;
      if (!before.has(a) && !before.has(b)) continue;
      const va = before.get(a) ?? (a.dynamic ? a.linvel() : v(0, 0, 0));
      const vb = before.get(b) ?? (b.dynamic ? b.linvel() : v(0, 0, 0));
      const n = norm(c.normal);
      const approach = Math.abs(dot(sub(va, vb), n));
      const ma = a.mass(), mb = b.mass();
      const reduced = ma > 0 && mb > 0 ? (ma * mb) / (ma + mb) : Math.max(ma, mb);
      const force = (reduced * approach * (1 + c.combinedRestitution)) / dt;
      const threshold = Math.min(...[a, b].filter((x) => before.has(x)).map((x) => x.colliders[0]?.desc.forceThreshold ?? 0));
      if (force < threshold) continue;
      const c1 = a.colliders[0], c2 = b.colliders[0];
      if (c1 === undefined || c2 === undefined) continue;
      if (TRACE) console.error(`trace contact force ${force.toFixed(1)} depth ${c.penetrationDepth.toFixed(3)} bodies ${a.handle}/${b.handle} masses ${ma}/${mb}`);
      events.forces.push(new TempContactForceEvent(c1.handle, c2.handle, force, n));
    }
  }

  free(): void { P.destroyWorld(this.handle); }
}

// ------------------------------------------------------------------ ray-cast vehicle (Rapier's, from Bullet's btRaycastVehicle)

class Wheel {
  chassisConnectionPointCs = v(0, 0, 0);
  directionCs = v(0, -1, 0);
  axleCs = v(0, 0, 1);
  suspensionRestLength = 0.6;
  maxSuspensionTravel = 5;
  radius = 0.4;
  suspensionStiffness = 5.88;
  suspensionCompression = 0.83;   // damping while compressing
  suspensionRelaxation = 0.88;    // damping while extending
  frictionSlip = 10.5;
  sideFrictionStiffness = 1;
  maxSuspensionForce = 6000;
  rollInfluence = 0.1;
  steering = 0;
  engineForce = 0;
  brake = 0;
  rotation = 0;
  // ray-cast results
  center = v(0, 0, 0);
  directionWs = v(0, -1, 0);
  axleWs = v(0, 0, 1);
  isInContact = false;
  contactPointWs = v(0, 0, 0);
  contactNormalWs = v(0, 1, 0);
  suspensionLength = 0;
  groundObject: Collider | null = null;
  suspensionRelativeVelocity = 0;
  clippedInvContactDotSuspension = 1;
  wheelSuspensionForce = 0;
  skidInfo = 1;
}

export class DynamicRayCastVehicleController {
  private readonly world: World;
  private readonly chassis: RigidBody;
  private wheels: Wheel[] = [];
  private speed = 0;
  indexUpAxis = 1;
  indexForwardAxis = 0;

  constructor(world: World, chassis: RigidBody) {
    this.world = world; this.chassis = chassis;
    // the chassis gets a layer of its own (same collisions), so the wheels' rays can skip it
    chassis.vehicle = true;
    chassis.rebuild();
  }

  addWheel(chassisConnectionCs: V3, directionCs: V3, axleCs: V3, suspensionRestLength: number, radius: number): void {
    const w = new Wheel();
    w.chassisConnectionPointCs = v(chassisConnectionCs.x, chassisConnectionCs.y, chassisConnectionCs.z);
    w.directionCs = v(directionCs.x, directionCs.y, directionCs.z);
    w.axleCs = v(axleCs.x, axleCs.y, axleCs.z);
    w.suspensionRestLength = suspensionRestLength; w.radius = radius;
    this.wheels.push(w);
  }
  numWheels(): number { return this.wheels.length; }
  private w(i: number): Wheel { return this.wheels[i]!; }

  setWheelChassisConnectionPointCs(i: number, p: V3): void { this.w(i).chassisConnectionPointCs = v(p.x, p.y, p.z); }
  setWheelDirectionCs(i: number, d: V3): void { this.w(i).directionCs = v(d.x, d.y, d.z); }
  setWheelAxleCs(i: number, a: V3): void { this.w(i).axleCs = v(a.x, a.y, a.z); }
  setWheelSuspensionRestLength(i: number, l: number): void { this.w(i).suspensionRestLength = l; }
  setWheelMaxSuspensionTravel(i: number, t: number): void { this.w(i).maxSuspensionTravel = t; }
  setWheelRadius(i: number, r: number): void { this.w(i).radius = r; }
  setWheelSuspensionStiffness(i: number, s: number): void { this.w(i).suspensionStiffness = s; }
  setWheelSuspensionCompression(i: number, c: number): void { this.w(i).suspensionCompression = c; }
  setWheelSuspensionRelaxation(i: number, r: number): void { this.w(i).suspensionRelaxation = r; }
  setWheelFrictionSlip(i: number, f: number): void { this.w(i).frictionSlip = f; }
  setWheelSideFrictionStiffness(i: number, s: number): void { this.w(i).sideFrictionStiffness = s; }
  setWheelMaxSuspensionForce(i: number, f: number): void { this.w(i).maxSuspensionForce = f; }
  setWheelSteering(i: number, s: number): void { this.w(i).steering = s; }
  setWheelEngineForce(i: number, f: number): void { this.w(i).engineForce = f; }
  setWheelBrake(i: number, b: number): void { this.w(i).brake = b; }
  wheelSteering(i: number): number { return this.w(i).steering; }
  wheelRotation(i: number): number { return this.w(i).rotation; }
  wheelIsInContact(i: number): boolean { return this.w(i).isInContact; }
  wheelContactPoint(i: number): V3 { return { ...this.w(i).contactPointWs }; }
  wheelContactNormal(i: number): V3 { return { ...this.w(i).contactNormalWs }; }
  wheelSuspensionLength(i: number): number | null { return this.w(i).suspensionLength; }
  wheelSuspensionForce(i: number): number { return this.w(i).wheelSuspensionForce; }
  wheelGroundObject(i: number): Collider | null { return this.w(i).groundObject; }
  wheelChassisConnectionPointCs(i: number): V3 { return { ...this.w(i).chassisConnectionPointCs }; }
  wheelHardPoint(i: number): V3 { return { ...this.w(i).center }; }
  currentVehicleSpeed(): number { return this.speed; }

  private traced = 0;
  updateVehicle(dt: number): void {
    const chassis = this.chassis;
    if (TRACE && this.traced++ < 40) { const t = chassis.translation(), l = chassis.linvel(); console.error(`trace vehicle dt ${dt} jolt ${chassis.jolt} pos ${t.x},${t.y},${t.z} vel ${l.x},${l.y},${l.z} mass ${chassis.mass()} joltMass ${chassis.joltMass} inertiaR ${JSON.stringify(chassis.rapier.inertia)} inertiaJ ${JSON.stringify(chassis.joltInertia)} steps ${this.world.timestep}`); }
    if (chassis.jolt === 0) return;
    const rot = chassis.rotation(), pos = chassis.translation();
    const linvel = chassis.linvel();
    this.speed = len(linvel);
    const forwardW = rotate(rot, this.indexForwardAxis === 0 ? v(1, 0, 0) : this.indexForwardAxis === 1 ? v(0, 1, 0) : v(0, 0, 1));
    if (dot(forwardW, linvel) < 0) this.speed = -this.speed;

    for (const w of this.wheels) {
      // transforms
      w.isInContact = false;
      w.center = add(pos, rotate(rot, w.chassisConnectionPointCs));
      w.directionWs = rotate(rot, w.directionCs);
      const steer = axisAngle(scale(w.directionWs, -1), w.steering);
      w.axleWs = rotate(steer, rotate(rot, w.axleCs));
      // ray cast
      const rayLen = w.suspensionRestLength + w.radius;
      const rayVector = scale(w.directionWs, rayLen);
      w.contactPointWs = add(w.center, rayVector);
      w.groundObject = null;
      const hit = this.world.castRayExcluding(w.center, rayVector, 1, chassis.layer);
      if (hit !== null) {
        w.contactNormalWs = hit.toi === 0 ? scale(w.directionWs, -1) : norm(hit.normal);
        w.isInContact = true;
        w.groundObject = hit.body?.colliders[0] ?? null;
        const hitDistance = hit.toi * rayLen;
        w.suspensionLength = hitDistance - w.radius;
        const minLen = w.suspensionRestLength - w.maxSuspensionTravel, maxLen = w.suspensionRestLength + w.maxSuspensionTravel;
        if (w.suspensionLength < minLen) w.suspensionLength = minLen;
        if (w.suspensionLength > maxLen) { w.suspensionLength = maxLen; w.groundObject = null; }
        w.contactPointWs = add(w.center, scale(rayVector, hit.toi));
        const denominator = dot(w.contactNormalWs, w.directionWs);
        const projVel = dot(w.contactNormalWs, chassis.velocityAtPoint(w.contactPointWs));
        if (denominator >= -0.1) { w.suspensionRelativeVelocity = 0; w.clippedInvContactDotSuspension = 1 / 0.1; }
        else { const inv = -1 / denominator; w.suspensionRelativeVelocity = projVel * inv; w.clippedInvContactDotSuspension = inv; }
      } else {
        w.suspensionLength = w.suspensionRestLength;
        w.suspensionRelativeVelocity = 0;
        w.contactNormalWs = scale(w.directionWs, -1);
        w.clippedInvContactDotSuspension = 1;
      }
    }

    // suspension (Rapier units: the force is per unit of the chassis' Rapier mass)
    const chassisMass = chassis.mass();
    for (const w of this.wheels) {
      if (w.isInContact) {
        let force = w.suspensionStiffness * (w.suspensionRestLength - w.suspensionLength) * w.clippedInvContactDotSuspension;
        const rel = w.suspensionRelativeVelocity;
        force -= (rel < 0 ? w.suspensionCompression : w.suspensionRelaxation) * rel;
        w.wheelSuspensionForce = Math.max(0, force * chassisMass);
      } else w.wheelSuspensionForce = 0;
    }
    for (const w of this.wheels) {
      const f = Math.min(w.wheelSuspensionForce, w.maxSuspensionForce);
      chassis.applyImpulseAtPoint(scale(w.contactNormalWs, f * dt), w.contactPointWs, false);
    }

    this.updateFriction(dt);

    // wheel spin (visual)
    for (const w of this.wheels) {
      const vel = chassis.velocityAtPoint(w.center);
      if (w.isInContact) {
        const fwd = rotate(rot, v(1, 0, 0));
        const proj = dot(fwd, w.contactNormalWs);
        const f2 = sub(fwd, scale(w.contactNormalWs, proj));
        w.rotation += (dot(f2, vel) * dt) / w.radius;
      }
    }
  }

  private updateFriction(dt: number): void {
    const chassis = this.chassis;
    const n = this.wheels.length;
    const forwardWs: V3[] = new Array(n), axle: V3[] = new Array(n);
    const forwardImpulse: number[] = new Array(n).fill(0), sideImpulse: number[] = new Array(n).fill(0);
    let onGround = 0;
    for (const w of this.wheels) if (w.groundObject !== null) onGround++;

    for (let i = 0; i < n; i++) {
      const w = this.w(i);
      const nrm = w.contactNormalWs;
      let a = w.axleWs;
      a = norm(sub(a, scale(nrm, dot(a, nrm))));
      axle[i] = a;
      forwardWs[i] = norm(cross(nrm, a));
      if (w.groundObject !== null) {
        const ground = w.groundObject.parent();
        // resolve_single_bilateral: the impulse that cancels the sideways speed at the contact
        const p = w.contactPointWs;
        const vel1 = chassis.velocityAtPoint(p);
        const vel2 = ground.dynamic ? ground.velocityAtPoint(p) : v(0, 0, 0);
        const lhs = chassis.impulseDenominator(p, a) + (ground.dynamic ? ground.impulseDenominator(p, a) : 0);
        const relVel = dot(a, sub(vel1, vel2));
        sideImpulse[i] = (lhs !== 0 ? -relVel / lhs : 0) * w.sideFrictionStiffness;
      }
    }

    const sideFactor = 1, fwdFactor = 0.5;
    let sliding = false;
    for (let i = 0; i < n; i++) {
      const w = this.w(i);
      let rollingFriction = 0;
      if (w.groundObject !== null) {
        if (w.engineForce !== 0) rollingFriction = w.engineForce * dt;
        else {
          const maxImpulse = w.brake !== 0 ? w.brake : 0;
          const ground = w.groundObject.parent();
          const p = w.contactPointWs, dir = forwardWs[i]!;
          const denom = chassis.impulseDenominator(p, dir) + (ground.dynamic ? ground.impulseDenominator(p, dir) : 0);
          const jacInv = denom !== 0 ? 1 / denom : 0;
          const vrel = dot(dir, sub(chassis.velocityAtPoint(p), ground.dynamic ? ground.velocityAtPoint(p) : v(0, 0, 0)));
          rollingFriction = Math.max(-maxImpulse, Math.min(maxImpulse, (-vrel * jacInv) / Math.max(1, onGround)));
        }
      }
      forwardImpulse[i] = 0;
      w.skidInfo = 1;
      if (w.groundObject !== null) {
        const maxImp = w.wheelSuspensionForce * dt * w.frictionSlip;
        forwardImpulse[i] = rollingFriction;
        const x = forwardImpulse[i]! * fwdFactor, y = sideImpulse[i]! * sideFactor;
        const sq = x * x + y * y;
        if (sq > maxImp * maxImp) { sliding = true; w.skidInfo *= maxImp / Math.sqrt(sq); }
      }
    }
    if (sliding) {
      for (let i = 0; i < n; i++) {
        const w = this.w(i);
        if (sideImpulse[i] !== 0 && w.skidInfo < 1) { forwardImpulse[i] = forwardImpulse[i]! * w.skidInfo; sideImpulse[i] = sideImpulse[i]! * w.skidInfo; }
      }
    }

    const up = rotate(chassis.rotation(), this.indexUpAxis === 1 ? v(0, 1, 0) : this.indexUpAxis === 2 ? v(0, 0, 1) : v(1, 0, 0));
    const com = chassis.centerOfMass();
    for (let i = 0; i < n; i++) {
      const w = this.w(i);
      let point = w.contactPointWs;
      if (forwardImpulse[i] !== 0) chassis.applyImpulseAtPoint(scale(forwardWs[i]!, forwardImpulse[i]!), point, false);
      if (sideImpulse[i] !== 0) {
        const side = scale(axle[i]!, sideImpulse[i]!);
        point = sub(point, scale(up, dot(up, sub(point, com)) * (1 - w.rollInfluence)));
        chassis.applyImpulseAtPoint(side, point, false);
      }
    }
  }
}

// ------------------------------------------------------------------ module shape

/** Rapier's async init (the compat build); the module is ready as soon as it's imported. */
export function init(): Promise<void> { return Promise.resolve(); }
export const version = (): string => "0.19.3-bloom-jolt";
export default { World, RigidBodyDesc, ColliderDesc, EventQueue, CoefficientCombineRule, ActiveEvents, RigidBodyType, init, version };
