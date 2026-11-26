/**
 * The bridge's renderer (BloomRenderer, made for three.js's WebGLRenderer) as the WebGPURenderer
 * folio-2025 drives. The bridge draws `Mesh`es from `material.color` / `map` / `emissive`; this game
 * draws everything with TSL node materials and a few WebGPU-only renderer calls. The adapter:
 *
 *  1. adds the WebGPURenderer members the game calls (backend, sorts, compute, timestamps, features);
 *  2. ignores renders into render targets (tire tracks, noise and snow textures: the bridge has no
 *     render targets and would draw them into the frame, hiding the main scene's nodes);
 *  3. gives node materials the plain colour and map Bloom can draw, read off their colour node
 *     (`texture(palette).rgb`, `color(...)`, `uniform(color(...))`, ...);
 *  4. draws InstancedMesh: one scene node per instance for small, moving groups (physics props), the
 *     instances baked into one geometry for large static ones (foliage, flowers).
 */
import * as THREE from "@bloomengine/three/real/three";
import { BloomRenderer } from "@bloomengine/three";
import { StackNode, getCurrentStack, setCurrentStack } from "three/tsl";

// ------------------------------------------------------------------ node material -> colour and map

interface NodeLike { [k: string]: unknown; isNode?: boolean; isTextureNode?: boolean; value?: unknown }

/** The first texture and the first colour found in a node graph (depth first, the colour side first). */
function scanNode(root: unknown): { map: THREE.Texture | null; color: THREE.Color | null; scale: number } {
  let map: THREE.Texture | null = null, color: THREE.Color | null = null, scale = 1;
  const seen = new Set<unknown>();
  const visit = (n: unknown, depth: number): void => {
    if (n === null || typeof n !== "object" || seen.has(n) || depth > 24) return;
    seen.add(n);
    const node = n as NodeLike;
    if (scanLog !== null && scanLog.length < 60) scanLog.push(`${"  ".repeat(Math.min(depth, 12))}${String((node.constructor as { name?: string } | undefined)?.name)} value=${node.value !== null && typeof node.value === "object" ? String((node.value as { constructor?: { name?: string } }).constructor?.name) + ((node.value as { isColor?: boolean }).isColor ? "#" + (node.value as THREE.Color).getHexString() : "") : String(node.value)}`);
    if (node.isTextureNode === true && map === null) {
      const t = node.value as THREE.Texture | undefined;
      // a render target's texture (noise, tracks) is never drawn here: keep looking for a colour
      if (t !== undefined && (t as { isTexture?: boolean }).isTexture === true && (t as { isRenderTargetTexture?: boolean }).isRenderTargetTexture !== true) map = t;
    }
    const value = node.value;
    if (color === null && value !== null && typeof value === "object" && (value as { isColor?: boolean }).isColor === true) color = (value as THREE.Color).clone();
    if (node.isNode !== true) return;
    // a Fn(...) call: TSL runs its body when the shader is built; run it here (on a scratch stack) to see it
    if (node["isShaderCallNodeInternal"] === true) { const r = expandFnCall(node); if (r !== null) { visit(r.output, depth + 1); for (const n of r.stack) visit(n, depth + 1); } return; }
    // the operands of operators, swizzles, calls, mixes, uniforms, variables and assignments...
    for (const key of ["node", "aNode", "bNode", "cNode", "colorNode", "uvNode", "sourceNode", "value"]) visit(node[key], depth + 1);
    const params = node["params"]; if (Array.isArray(params)) for (const p of params) visit(p, depth + 1);
    const inputs = node["inputNodes"]; if (inputs !== null && typeof inputs === "object") for (const p of Object.values(inputs as object)) visit(p, depth + 1);
    // a constant multiplier (an emissive's intensity)
    if (node["op"] === "*" && typeof (node["bNode"] as NodeLike | undefined)?.value === "number") scale *= (node["bNode"] as NodeLike).value as number;
  };
  visit(root, 0);
  return { map, color, scale };
}

/** Every colour value (constants and uniforms, live) in a node graph. */
function collectColors(root: unknown): THREE.Color[] {
  const out: THREE.Color[] = [];
  const seen = new Set<unknown>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === null || typeof n !== "object" || seen.has(n)) continue;
    seen.add(n);
    const node = n as NodeLike;
    const value = node.value;
    if (value !== null && typeof value === "object" && (value as { isColor?: boolean }).isColor === true) out.push(value as THREE.Color);
    if (node.isNode !== true) continue;
    for (const key of ["node", "aNode", "bNode", "cNode"]) stack.push(node[key]);
    const params = node["params"]; if (Array.isArray(params)) for (const p of params) stack.push(p);
  }
  return out;
}

/** What a Fn call's body builds: its output node and the statements it pushed (assignments). */
const expanded = new WeakMap<object, { output: unknown; stack: unknown[] } | null>();
function expandFnCall(call: NodeLike): { output: unknown; stack: unknown[] } | null {
  const known = expanded.get(call);
  if (known !== undefined) return known;
  let result: { output: unknown; stack: unknown[] } | null = null;
  const shaderNode = call["shaderNode"] as { jsFunc?: (...a: unknown[]) => unknown; layout?: unknown } | undefined;
  const jsFunc = shaderNode?.jsFunc;
  if (typeof jsFunc === "function") {
    const previous = getCurrentStack();
    const stack = new (StackNode as unknown as new () => { nodes: unknown[] })();
    setCurrentStack(stack as never);
    try {
      const raw = call["rawInputs"] as unknown;
      const hasParameters = Array.isArray(raw) ? raw.length > 0 : raw !== null && raw !== undefined;
      const builder = {};
      const output = hasParameters || jsFunc.length > 1 ? jsFunc(raw, builder) : jsFunc(builder);
      result = { output, stack: [...(stack.nodes ?? [])] };
    } catch (e) {
      result = null;   // a body that needs a real shader build: no colour from it
      if (process.env["FOLIO_TRACE"] === "1") console.error(`trace Fn expansion failed: ${String(e)}\n${String(jsFunc).slice(0, 160)}`);
    } finally {
      setCurrentStack(previous as never);
    }
  }
  expanded.set(call, result);
  return result;
}

interface Translated { version: number }
const translated = new WeakMap<object, Translated>();

/**
 * Gives a node material the `color` and `map` its colour node computes, once (again when the material
 * changes). Meant for the bridge's syncMesh, which reads exactly those.
 */
function translateMaterial(m: THREE.Material): void {
  const node = m as unknown as { isNodeMaterial?: boolean; version: number; _colorNode?: unknown; colorNode?: unknown; outputNode?: unknown; color?: THREE.Color; map?: THREE.Texture | null; emissive?: THREE.Color };
  if (node.isNodeMaterial !== true) return;
  const done = translated.get(m);
  if (done !== undefined && done.version === node.version) return;
  translated.set(m, { version: node.version });
  const source = node._colorNode ?? node.colorNode ?? node.outputNode;
  if (source === undefined || source === null) return;
  const found = scanNode(source);
  if (found.map !== null && (node.map === null || node.map === undefined)) node.map = found.map;
  if (found.color !== null && node.color !== undefined) {
    const c = found.color;
    // normalised emissive colours (colour / luminance x intensity) can be far above 1: keep the hue
    const max = Math.max(c.r, c.g, c.b);
    if (max > 1) c.multiplyScalar(1 / max);
    node.color.copy(c);
  }
  // the bridge keys its material cache on these; a changed colour needs a new key
  translated.set(m, { version: node.version });
}

// ------------------------------------------------------------------ instanced meshes

/** The largest instance count drawn as separate scene nodes (moving props); above it, one baked geometry. */
const MAX_NODES_PER_INSTANCED_MESH = 96;

interface InstanceProxy { isMesh: true; visible: true; matrixWorld: THREE.Matrix4; material: THREE.Material | THREE.Material[]; geometry: THREE.BufferGeometry; castShadow: boolean; receiveShadow: boolean; children: never[]; userData: Record<string, unknown> }

interface Baked { proxy: InstanceProxy; key: string }

const instanceMatrix = new THREE.Matrix4();
const failed = new WeakSet<object>();
const warnedOnce = new Set<string>();
function warnOnce(what: string): void { if (!warnedOnce.has(what)) { warnedOnce.add(what); console.error("three.js on Bloom: " + what); } }
let scanLog: string[] | null = null;
const TRACE_MESH = process.env["FOLIO_TRACE_MESH"] ?? "";
const traced = new WeakSet<object>();

/** FOLIO_DUMP=<frame>: list what is drawn on that frame (diagnostics). */
const DUMP_FRAME = Number(process.env["FOLIO_DUMP"] ?? "0") || 0;
const dumpBox = new THREE.Box3(), dumpSize = new THREE.Vector3();
function dumpMesh(mesh: THREE.Mesh): void {
  const m = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as unknown as Record<string, unknown> & { type: string; color?: THREE.Color; map?: THREE.Texture | null };
  const g = mesh.geometry;
  if (g.boundingBox === null) g.computeBoundingBox();
  dumpBox.copy(g.boundingBox ?? dumpBox.makeEmpty()).applyMatrix4(mesh.matrixWorld).getSize(dumpSize);
  const ctr = dumpBox.getCenter(new THREE.Vector3());
  const hooks = ["vertexNode", "positionNode", "outputNode", "colorNode", "_colorNode", "opacityNode", "alphaTestNode"].filter((k) => m[k] !== null && m[k] !== undefined).join("+");
  let path = ""; for (let o: THREE.Object3D | null | undefined = mesh as unknown as THREE.Object3D; o !== null && o !== undefined && path.length < 80; o = o.parent) path = (o.name || o.type || "?") + (path ? "/" + path : "");
  console.error(`dump ${path} | ${m.type} ${hooks} | color ${m.color?.getHexString() ?? "-"} map ${m.map ? "yes" : "no"} transparent ${String(m["transparent"])} | size ${dumpSize.x.toFixed(1)}x${dumpSize.y.toFixed(1)}x${dumpSize.z.toFixed(1)} | at ${ctr.x.toFixed(1)},${ctr.y.toFixed(1)},${ctr.z.toFixed(1)} | verts ${g.attributes.position?.count ?? 0}`);
}

// ------------------------------------------------------------------ the renderer

type Visit = (o: THREE.Object3D) => void;
type SyncMesh = (m: THREE.Mesh) => void;

export class FolioRenderer extends BloomRenderer {
  readonly isWebGPURenderer = true;
  readonly backend = { isWebGPUBackend: false, isWebGLBackend: false, device: null, parameters: {} };
  library: Record<string, unknown> = {};
  inspector: unknown = null;
  private target: unknown = null;
  private proxies = new WeakMap<THREE.InstancedMesh, InstanceProxy[]>();
  private baked = new WeakMap<THREE.InstancedMesh, Baked>();

  constructor(parameters: { canvas?: unknown; antialias?: boolean; alpha?: boolean } = {}) {
    super(parameters);
    (this.info.render as Record<string, number>)["drawCalls"] = 0;
    // the bridge's private scene walk, wrapped: node materials and instanced meshes on the way
    const self = this as unknown as { visit: Visit; syncMesh: SyncMesh };
    const visit = self.visit.bind(this), syncMesh = self.syncMesh.bind(this);
    self.syncMesh = (mesh: THREE.Mesh): void => {
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      // a vertexNode places the geometry in the vertex shader (screen quads, speed and wind lines,
      // lightnings): its raw geometry would be drawn somewhere meaningless, so it isn't drawn
      if (material !== undefined && (material as unknown as { vertexNode?: unknown }).vertexNode) { warnOnce("a material with a vertexNode (shader-placed geometry) isn't drawn"); return; }
      if (material !== undefined) translateMaterial(material);
      if (TRACE_MESH !== "" && (mesh as { name?: string }).name === TRACE_MESH && !traced.has(mesh)) {
        traced.add(mesh);
        const m = material as unknown as Record<string, unknown>;
        const src = m["_colorNode"] ?? m["colorNode"];
        scanLog = []; const r = scanNode(src); console.error(scanLog.join("\n")); scanLog = null;
        const n = src as Record<string, unknown> | undefined;
        console.error(`trace mesh ${TRACE_MESH}: source ${String(n?.["type"] ?? n?.["constructor"] && (n["constructor"] as { name?: string }).name)} call ${String(n?.["isShaderCallNodeInternal"])} expand ${JSON.stringify(Object.keys((n !== undefined ? expandFnCall(n as NodeLike) : null) ?? {}))} found color ${r.color?.getHexString() ?? "-"} map ${r.map !== null}`);
        const e = n !== undefined ? expandFnCall(n as NodeLike) : null;
        const out = e?.output as Record<string, unknown> | undefined;
        console.error(`trace   output ${String((out?.["constructor"] as { name?: string } | undefined)?.name)} keys ${Object.keys(out ?? {}).slice(0, 20).join(",")} stack ${e?.stack.length}`);
      }
      // three's renderers compute bounding spheres while frustum culling; games rely on them existing after a frame
      const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
      if (geometry !== undefined && geometry.boundingSphere === null && (mesh as unknown as { isObject3D?: boolean }).isObject3D === true && geometry.attributes.position?.itemSize === 3) geometry.computeBoundingSphere();
      if (DUMP_FRAME > 0 && this.info.render.frame === DUMP_FRAME) dumpMesh(mesh);
      try { syncMesh(mesh); } catch (e) {
        if (!failed.has(mesh.geometry)) {
          failed.add(mesh.geometry);
          const attrs = Object.entries(mesh.geometry.attributes).map(([k, a]) => `${k}:${(a as THREE.BufferAttribute).itemSize}x${(a as THREE.BufferAttribute).count}${(a as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute ? "i" : ""}`).join(",");
          console.error(`three.js on Bloom: mesh "${(mesh as { name?: string }).name ?? ""}" isn't drawn (${String(e)}; ${attrs}; index ${mesh.geometry.index?.count ?? "none"}; drawRange ${mesh.geometry.drawRange.start}+${mesh.geometry.drawRange.count})`);
        }
      }
    };
    self.visit = (o: THREE.Object3D): void => {
      const inst = o as THREE.InstancedMesh;
      if (inst.isInstancedMesh === true && o.visible) {
        if (inst.boundingSphere === null && inst.geometry.attributes.position?.itemSize === 3) inst.computeBoundingSphere(); this.syncInstanced(inst, self.syncMesh); for (const c of o.children) self.visit(c); return; }
      visit(o);
    };
  }

  // WebGPURenderer API the game uses (and three's RendererUtils save/reset/restore state)
  opaque = true;
  transparent = true;
  private mrt: unknown = null;
  private renderObjectFunction: unknown = null;
  getMRT(): unknown { return this.mrt; }
  setMRT(mrt: unknown): this { this.mrt = mrt; return this; }
  getRenderObjectFunction(): unknown { return this.renderObjectFunction; }
  setRenderObjectFunction(f: unknown): void { this.renderObjectFunction = f; }
  getColorBufferType(): number { return THREE.HalfFloatType; }
  getOutputBufferType(): number { return THREE.HalfFloatType; }
  setOpaqueSort(_f: unknown): void {}
  setTransparentSort(_f: unknown): void {}
  hasFeature(_name: string): boolean { return false; }
  hasFeatureAsync(_name: string): Promise<boolean> { return Promise.resolve(false); }
  compute(_node: unknown): void {}
  computeAsync(_node: unknown): Promise<void> { return Promise.resolve(); }
  resolveTimestampsAsync(_type?: unknown): Promise<number> { return Promise.resolve(0); }
  renderAsync(scene: THREE.Object3D, camera: THREE.Camera): Promise<void> { this.render(scene, camera); return Promise.resolve(); }
  initRenderTarget(_t: unknown): void {}
  copyTextureToTexture(): void {}
  setOutputRenderTarget(_t: unknown): void {}
  getOutputRenderTarget(): null { return null; }
  get coordinateSystem(): number { return THREE.WebGLCoordinateSystem; }

  override setRenderTarget(target: unknown): void { this.target = target; }
  override getRenderTarget(): null { return this.target as null; }
  override render(scene: THREE.Object3D, camera: THREE.Camera): void {
    // offscreen passes (tracks, noises, snow) have no Bloom equivalent: drawing them would replace the frame
    if (this.target !== null && this.target !== undefined) return;
    // a node background (the day cycle's fog gradient) clears to the average of its colours
    const s = scene as unknown as { background?: unknown; backgroundNode?: unknown };
    if ((s.background === null || s.background === undefined) && s.backgroundNode) {
      const colors = collectColors(s.backgroundNode);
      if (colors.length > 0) {
        const c = new THREE.Color(0, 0, 0);
        for (const x of colors) c.add(x);
        this.setClearColor(c.multiplyScalar(1 / colors.length));
      }
    }
    if (DUMP_FRAME > 0 && this.info.render.frame + 1 === DUMP_FRAME) { const p = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld); const d = camera.getWorldDirection(new THREE.Vector3()); const pc = camera as THREE.PerspectiveCamera; console.error(`dump camera at ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} dir ${d.x.toFixed(2)},${d.y.toFixed(2)},${d.z.toFixed(2)} fov ${pc.fov} near ${pc.near} far ${pc.far}`); }
    super.render(scene, camera);
  }

  private syncInstanced(mesh: THREE.InstancedMesh, syncMesh: SyncMesh): void {
    const count = mesh.count;
    if (count <= 0) return;
    if (count <= MAX_NODES_PER_INSTANCED_MESH) {
      let list = this.proxies.get(mesh);
      if (list === undefined) { list = []; this.proxies.set(mesh, list); }
      for (let i = 0; i < count; i++) {
        let p = list[i];
        if (p === undefined) {
          p = { isMesh: true, visible: true, matrixWorld: new THREE.Matrix4(), material: mesh.material, geometry: mesh.geometry, castShadow: mesh.castShadow, receiveShadow: mesh.receiveShadow, children: [], userData: {} };
          list[i] = p;
        }
        p.material = mesh.material; p.geometry = mesh.geometry;
        mesh.getMatrixAt(i, instanceMatrix);
        p.matrixWorld.multiplyMatrices(mesh.matrixWorld, instanceMatrix);
        syncMesh(p as unknown as THREE.Mesh);
      }
      return;
    }
    // many instances: one geometry with the instances baked in, rebuilt when they change
    const key = mesh.geometry.uuid + ":" + String(mesh.instanceMatrix.version) + ":" + String(count);
    let b = this.baked.get(mesh);
    if (b === undefined || b.key !== key) {
      const geometry = bake(mesh, count);
      if (b !== undefined) b.proxy.geometry.dispose();
      b = { key, proxy: { isMesh: true, visible: true, matrixWorld: new THREE.Matrix4(), material: mesh.material, geometry, castShadow: mesh.castShadow, receiveShadow: mesh.receiveShadow, children: [], userData: {} } };
      this.baked.set(mesh, b);
    }
    b.proxy.material = mesh.material;
    b.proxy.matrixWorld.copy(mesh.matrixWorld);
    syncMesh(b.proxy as unknown as THREE.Mesh);
  }
}

/** An InstancedMesh's instances as one BufferGeometry (positions, normals, colours, uvs). */
function bake(mesh: THREE.InstancedMesh, count: number): THREE.BufferGeometry {
  const src = mesh.geometry.index !== null ? mesh.geometry.toNonIndexed() : mesh.geometry;
  const pos = src.attributes.position as THREE.BufferAttribute;
  const nor = src.attributes.normal as THREE.BufferAttribute | undefined;
  const uv = src.attributes.uv as THREE.BufferAttribute | undefined;
  const col = src.attributes.color as THREE.BufferAttribute | undefined;
  const n = pos.count;
  const P = new Float32Array(n * count * 3), N = new Float32Array(n * count * 3), U = new Float32Array(n * count * 2);
  const C = col !== undefined ? new Float32Array(n * count * 4) : null;
  const m = new THREE.Matrix4(), nm = new THREE.Matrix3(), p = new THREE.Vector3(), q = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    mesh.getMatrixAt(i, m);
    nm.getNormalMatrix(m);
    for (let j = 0; j < n; j++) {
      const k = i * n + j;
      p.fromBufferAttribute(pos, j).applyMatrix4(m);
      P[k * 3] = p.x; P[k * 3 + 1] = p.y; P[k * 3 + 2] = p.z;
      if (nor !== undefined) { q.fromBufferAttribute(nor, j).applyMatrix3(nm).normalize(); N[k * 3] = q.x; N[k * 3 + 1] = q.y; N[k * 3 + 2] = q.z; } else N[k * 3 + 1] = 1;
      if (uv !== undefined) { U[k * 2] = uv.getX(j); U[k * 2 + 1] = uv.getY(j); }
      if (C !== null && col !== undefined) { C[k * 4] = col.getX(j); C[k * 4 + 1] = col.getY(j); C[k * 4 + 2] = col.getZ(j); C[k * 4 + 3] = col.itemSize > 3 ? col.getW(j) : 1; }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(P, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(N, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(U, 2));
  if (C !== null) g.setAttribute("color", new THREE.BufferAttribute(C, 4));
  return g;
}

// ------------------------------------------------------------------ RenderPipeline

interface PassLike { isPassNode?: boolean; scene?: THREE.Object3D; camera?: THREE.Camera }

/** The scene pass inside a post-processing graph: its scene and camera are what the frame draws. */
function findPass(root: unknown): PassLike | null {
  const seen = new Set<unknown>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === null || typeof n !== "object" || seen.has(n)) continue;
    seen.add(n);
    const node = n as PassLike & Record<string, unknown>;
    if (node.isPassNode === true && node.scene !== undefined && node.camera !== undefined) return node;
    if ((node as { isNode?: boolean }).isNode !== true) continue;
    for (const key of ["node", "aNode", "bNode", "cNode", "inputNode", "textureNode", "passNode", "colorNode", "value"]) stack.push(node[key]);
    const params = node["params"]; if (Array.isArray(params)) for (const p of params) stack.push(p);
  }
  return null;
}

/**
 * three.js's post-processing pipeline (bloom, depth of field) runs node passes Bloom can't execute.
 * Bloom has its own post-processing (bloom, TAA) by quality preset; this draws the scene pass.
 */
export class RenderPipeline {
  readonly renderer: FolioRenderer;
  outputNode: unknown;
  outputColorTransform = true;
  needsUpdate = false;
  private pass: PassLike | null = null;
  constructor(renderer: FolioRenderer, outputNode?: unknown) { this.renderer = renderer; this.outputNode = outputNode; }
  render(): void {
    if (this.pass === null || this.needsUpdate) { this.pass = findPass(this.outputNode); this.needsUpdate = false; }
    const p = this.pass;
    if (p !== null && p.scene !== undefined && p.camera !== undefined) this.renderer.render(p.scene, p.camera);
  }
  renderAsync(): Promise<void> { this.render(); return Promise.resolve(); }
  dispose(): void {}
}
