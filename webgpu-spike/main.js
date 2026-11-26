// Step 0: run three.js's real WebGPURenderer on a TSL scene against a recording fake GPU.
// Same file under Node (reference) and Perry (native). Output is deterministic so the two can be diffed.
import "./setup.js";
import { calls, shaders, snapshot, makeCanvas, tickFrame, writes, setPhase, rec } from "./fakegpu.js";
import * as THREE from "three/webgpu";
import { Fn, uniform, positionLocal, vec3, vec4, sin, cos, time, instancedArray, instanceIndex, color, float, uv, mix, pass } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import fs from "node:fs";

const t0 = Date.now();
const log = (...a) => console.log(...a);
let step = "start";
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16).padStart(8, "0"); }

async function main() {
  step = "renderer";
  const canvas = makeCanvas(1280, 720);
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  renderer.setSize(1280, 720, false);
  renderer.shadowMap.enabled = true;
  step = "init";
  await renderer.init();
  log("backend:", renderer.backend.isWebGPUBackend ? "WebGPU" : "other");
  log("phase init", JSON.stringify(snapshot()));

  step = "scene";
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x203040);
  const camera = new THREE.PerspectiveCamera(60, 1280 / 720, 0.1, 100);
  camera.position.set(0, 3, 8); camera.lookAt(0, 0, 0);

  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(5, 10, 3); sun.castShadow = true;
  scene.add(sun, new THREE.HemisphereLight(0x8899ff, 0x332211, 0.6));

  // 1. TSL node material: Fn, uniform, swizzles (Proxy), time-animated vertex position
  const tint = uniform(new THREE.Color(0xff8844));
  const wavy = new THREE.MeshStandardNodeMaterial({ roughness: 0.4 });
  wavy.colorNode = Fn(() => {
    const p = positionLocal.xz.mul(0.5);
    return mix(tint, vec3(sin(p.x), cos(p.y), 0.5), uv().y);
  })();
  wavy.positionNode = positionLocal.add(vec3(0, sin(positionLocal.x.mul(2).add(time)).mul(0.2), 0));
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(10, 10, 32, 32).rotateX(-Math.PI / 2), wavy);
  ground.receiveShadow = true; scene.add(ground);

  // 2. a classic material (converted to a node material by the renderer) + a data texture
  const data = new Uint8Array(64 * 64 * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37) & 255;
  const tex = new THREE.DataTexture(data, 64, 64); tex.needsUpdate = true;
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ map: tex, metalness: 0.2 }));
  box.position.y = 1; box.castShadow = true; scene.add(box);

  // 3. InstancedMesh
  const inst = new THREE.InstancedMesh(new THREE.SphereGeometry(0.15, 12, 8), new THREE.MeshStandardMaterial({ color: 0x44aaff }), 200);
  const m = new THREE.Matrix4();
  for (let i = 0; i < 200; i++) { m.makeTranslation(Math.cos(i) * 4, 0.3 + (i % 5) * 0.2, Math.sin(i) * 4); inst.setMatrixAt(i, m); }
  scene.add(inst);

  // 4. GPU compute particles drawn as sprites (storage buffer + compute shader)
  const COUNT = 1024;
  const positions = instancedArray(COUNT, "vec3");
  const initParticles = Fn(() => {
    const p = positions.element(instanceIndex);
    const f = float(instanceIndex);
    p.assign(vec3(sin(f.mul(0.37)).mul(3), f.mul(0.002), cos(f.mul(0.37)).mul(3)));
  })().compute(COUNT);
  const updateParticles = Fn(() => {
    const p = positions.element(instanceIndex);
    p.y.addAssign(0.01);
  })().compute(COUNT);
  const spriteMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
  spriteMat.positionNode = positions.toAttribute();
  spriteMat.colorNode = vec4(color(0xffee88), 1);
  spriteMat.scaleNode = float(0.05);
  const sprites = new THREE.Sprite(spriteMat); sprites.count = COUNT; scene.add(sprites);

  // 5. Points and a line
  const pg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-2, 2, 0), new THREE.Vector3(0, 2.5, 0), new THREE.Vector3(2, 2, 0)]);
  scene.add(new THREE.Points(pg, new THREE.PointsNodeMaterial({ color: 0xff00ff, size: 4 })));
  scene.add(new THREE.Line(pg, new THREE.LineBasicNodeMaterial({ color: 0x00ff00 })));

  // 6. an offscreen render target used as a texture
  const rt = new THREE.RenderTarget(256, 256);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(2, 1.2), new THREE.MeshBasicNodeMaterial({ map: rt.texture }));
  screen.position.set(-3, 1.5, -1); scene.add(screen);

  // 7. post-processing: scene pass + bloom
  step = "pipeline";
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  const sceneColor = scenePass.getTextureNode("output");
  pipeline.outputNode = sceneColor.add(bloom(sceneColor, 0.8, 0.4, 0.2));

  step = "compute-init"; setPhase("compute-init");
  renderer.compute(initParticles);
  log("phase scene+compute-init", JSON.stringify(snapshot()));

  let frame = 0;
  renderer.setAnimationLoop(() => {
    frame++;
    tint.value.setHSL(frame / 10, 0.7, 0.5);
    box.rotation.y = frame * 0.3;
    renderer.compute(updateParticles);
    renderer.setRenderTarget(rt); renderer.render(scene, camera); renderer.setRenderTarget(null);
    pipeline.render();
  });
  for (let f = 1; f <= 4; f++) {
    step = "frame " + f; setPhase("frame" + f);
    await tickFrame(f * 16.6667);
    for (let i = 0; i < 5; i++) await Promise.resolve();   // let async pipeline/compile work settle
    log("phase frame" + f, JSON.stringify(snapshot()));
  }
  // steady-state CPU cost of three.js's renderer per frame (fake GPU: no GPU work at all)
  const B = Number(process.argv[3] ?? 300), b0 = Date.now();
  rec.on = false;   // no recording during the benchmark: measure three.js, not the harness
  const marks = [];
  for (let f = 5; f < 5 + B; f++) { await tickFrame(f * 16.6667); if ((f - 4) % Math.max(1, Math.floor(B / 5)) === 0) marks.push(Date.now() - b0); }
  rec.on = true;
  const perFrame = (Date.now() - b0) / B;
  const seg = marks.map((m, i) => ((m - (i ? marks[i - 1] : 0)) / Math.max(1, Math.floor(B / 5))).toFixed(2));
  log("bench per-fifth ms/frame: " + seg.join(" "));
  snapshot();
  log("bench: " + B + " frames, " + perFrame.toFixed(3) + " ms/frame (JS + fake GPU calls)");
  const s0 = Date.now(); const c0 = shaders.length;
  // shader build cost: a fresh material forces a new pipeline (TSL -> WGSL generation)
  const extra = new THREE.Mesh(new THREE.TorusKnotGeometry(0.5, 0.15, 64, 8), new THREE.MeshPhysicalNodeMaterial({ clearcoat: 1, sheen: 1, iridescence: 1 }));
  scene.add(extra); await tickFrame((5 + B) * 16.6667);
  log("new physical material: " + (shaders.length - c0) + " shader modules in " + (Date.now() - s0) + " ms");
  renderer.setAnimationLoop(null);

  step = "report";
  let all = "";
  for (const s of shaders) all += s + "\n//----\n";
  log("shader modules:", shaders.length, "chars:", all.length, "hash:", hash(all));
  const RUNTIME = process.argv[2] ?? "run";
  fs.mkdirSync("out/wgsl-" + RUNTIME, { recursive: true });
  fs.writeFileSync("out/shaders-" + RUNTIME + ".wgsl", all);
  fs.writeFileSync("out/writes-" + RUNTIME + ".txt", writes.join("\n") + "\n");
  for (let i = 0; i < shaders.length; i++) fs.writeFileSync("out/wgsl-" + RUNTIME + "/" + String(i).padStart(3, "0") + ".wgsl", shaders[i]);
  log("info.render:", JSON.stringify({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }));
  log("done in", Date.now() - t0, "ms");
}

main().then(() => process.exit(0), (e) => {
  console.log("FAILED at step", step + ":", e && e.message ? e.message : String(e));
  if (e && e.stack) console.log(String(e.stack).split("\n").slice(0, 12).join("\n"));
  process.exit(1);
});
