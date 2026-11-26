// A fake WebGPU implementation that records every call three.js makes.
// No Proxy and no Reflect: the harness must not depend on the features under test.
// It only answers enough for three.js's WebGPURenderer to believe it has a GPU.

export const writes = [];
export const rec = { on: true };
let phaseName = "init";
export function setPhase(n) { phaseName = n; }
function describe(data, off, size) {
  const bpe = data.BYTES_PER_ELEMENT ?? 1;
  const start = (data.byteOffset ?? 0) + (off ?? 0) * bpe;
  const len = size !== undefined ? size * bpe : (data.byteLength - (off ?? 0) * bpe);
  const f = new Float32Array(data.buffer ?? data, start, Math.floor(len / 4));
  const vals = [];
  for (let i = 0; i < f.length; i++) vals.push(Math.round(f[i] * 1e5) / 1e5);
  return "bytes=" + len + " [" + vals.join(",") + "]";
}
let rafQueue = [];
let clock = 0;   // a fake clock, so time-driven uniforms are identical in every run
export async function tickFrame(ms) { clock = ms; const q = rafQueue; rafQueue = []; for (const cb of q) await cb(ms); }
export const calls = new Map();      // "device.createBuffer" -> count (current phase)
export const shaders = [];           // { kind, code } in creation order
export const stats = { writeBufferBytes: 0, writeTextureBytes: 0, mapped: 0, dataHash: 2166136261 };
function hashBytes(data, offsetElems, sizeElems) {
  const bpe = data.BYTES_PER_ELEMENT ?? 1;
  const buf = data.buffer ?? data;
  const start = (data.byteOffset ?? 0) + (offsetElems ?? 0) * bpe;
  const len = sizeElems !== undefined ? sizeElems * bpe : (data.byteLength - (offsetElems ?? 0) * bpe);
  const u8 = new Uint8Array(buf, start, len);
  let h = stats.dataHash;
  for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = Math.imul(h, 16777619) >>> 0; }
  stats.dataHash = h;
}

function count(name) { if (rec.on) calls.set(name, (calls.get(name) ?? 0) + 1); }

export function snapshot() {
  const keys = [...calls.keys()].sort();
  const out = {};
  for (const k of keys) out[k] = calls.get(k);
  const s = { calls: out, total: [...calls.values()].reduce((a, b) => a + b, 0), writeBufferBytes: stats.writeBufferBytes, writeTextureBytes: stats.writeTextureBytes, dataHash: stats.dataHash.toString(16) };
  calls.clear(); stats.writeBufferBytes = 0; stats.writeTextureBytes = 0; stats.dataHash = 2166136261;
  return s;
}

// Default WebGPU limits (spec "core" tier), a few raised as a native adapter would.
const limits = {
  maxTextureDimension1D: 8192, maxTextureDimension2D: 8192, maxTextureDimension3D: 2048, maxTextureArrayLayers: 256,
  maxBindGroups: 4, maxBindGroupsPlusVertexBuffers: 24, maxBindingsPerBindGroup: 1000,
  maxDynamicUniformBuffersPerPipelineLayout: 8, maxDynamicStorageBuffersPerPipelineLayout: 4,
  maxSampledTexturesPerShaderStage: 16, maxSamplersPerShaderStage: 16, maxStorageBuffersPerShaderStage: 8,
  maxStorageTexturesPerShaderStage: 4, maxUniformBuffersPerShaderStage: 12,
  maxUniformBufferBindingSize: 65536, maxStorageBufferBindingSize: 134217728,
  minUniformBufferOffsetAlignment: 256, minStorageBufferOffsetAlignment: 256,
  maxVertexBuffers: 8, maxBufferSize: 268435456, maxVertexAttributes: 16, maxVertexBufferArrayStride: 2048,
  maxInterStageShaderVariables: 16, maxColorAttachments: 8, maxColorAttachmentBytesPerSample: 32,
  maxComputeWorkgroupStorageSize: 16384, maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256, maxComputeWorkgroupSizeY: 256, maxComputeWorkgroupSizeZ: 64,
  maxComputeWorkgroupsPerDimension: 65535,
};

const adapterFeatures = new Set(["core-features-and-limits", "depth-clip-control", "depth32float-stencil8",
  "texture-compression-bc", "timestamp-query", "indirect-first-instance", "shader-f16", "rg11b10ufloat-renderable",
  "bgra8unorm-storage", "float32-filterable", "float32-blendable", "clip-distances", "dual-source-blending"]);

let nextId = 1;
// Real classes, installed as globals, because three.js checks `instanceof GPURenderBundleEncoder`.
const classes = {};
for (const k of ["GPUBuffer", "GPUTexture", "GPUTextureView", "GPUSampler", "GPUShaderModule", "GPUBindGroupLayout", "GPUPipelineLayout",
  "GPUBindGroup", "GPURenderPipeline", "GPUComputePipeline", "GPUCommandEncoder", "GPURenderPassEncoder", "GPUComputePassEncoder",
  "GPURenderBundleEncoder", "GPURenderBundle", "GPUCommandBuffer", "GPUQuerySet", "GPUExternalTexture", "GPUDevice", "GPUAdapter", "GPUQueue"]) {
  classes[k] = class {};
}
export const gpuClasses = classes;
function obj(kind, label) { const o = new classes[kind](); o.__kind = kind; o.__id = nextId++; o.label = label ?? ""; return o; }

function makeBuffer(desc) {
  count("device.createBuffer");
  const b = obj("GPUBuffer", desc.label);
  b.size = desc.size; b.usage = desc.usage; b.mapState = desc.mappedAtCreation ? "mapped" : "unmapped";
  b.mapAsync = (mode, offset, size) => { count("buffer.mapAsync"); b.mapState = "mapped"; return Promise.resolve(undefined); };
  b.getMappedRange = (offset, size) => { count("buffer.getMappedRange"); return new ArrayBuffer(size ?? (b.size - (offset ?? 0))); };
  b.unmap = () => { count("buffer.unmap"); b.mapState = "unmapped"; };
  b.destroy = () => { count("buffer.destroy"); };
  return b;
}

function makeTexture(desc) {
  const t = obj("GPUTexture", desc.label);
  const size = desc.size;
  t.width = size.width ?? size[0] ?? 1; t.height = size.height ?? size[1] ?? 1;
  t.depthOrArrayLayers = size.depthOrArrayLayers ?? size[2] ?? 1;
  t.format = desc.format; t.usage = desc.usage; t.mipLevelCount = desc.mipLevelCount ?? 1;
  t.sampleCount = desc.sampleCount ?? 1; t.dimension = desc.dimension ?? "2d";
  t.createView = (d) => { count("texture.createView"); const v = obj("GPUTextureView", d?.label); v.texture = t; return v; };
  t.destroy = () => { count("texture.destroy"); };
  return t;
}

function makePass(kind) {
  const p = obj(kind);
  const names = kind === "GPUComputePassEncoder"
    ? ["setPipeline", "setBindGroup", "dispatchWorkgroups", "dispatchWorkgroupsIndirect", "pushDebugGroup", "popDebugGroup", "insertDebugMarker"]
    : ["setPipeline", "setBindGroup", "setVertexBuffer", "setIndexBuffer", "setViewport", "setScissorRect", "setBlendConstant",
       "setStencilReference", "draw", "drawIndexed", "drawIndirect", "drawIndexedIndirect", "executeBundles",
       "beginOcclusionQuery", "endOcclusionQuery", "pushDebugGroup", "popDebugGroup", "insertDebugMarker"];
  const prefix = kind === "GPUComputePassEncoder" ? "computePass." : kind === "GPURenderBundleEncoder" ? "bundle." : "renderPass.";
  for (const n of names) p[n] = () => { count(prefix + n); };
  p.end = () => { count(prefix + "end"); };
  if (kind === "GPURenderBundleEncoder") p.finish = () => { count("bundle.finish"); return obj("GPURenderBundle"); };
  return p;
}

function makeEncoder() {
  count("device.createCommandEncoder");
  const e = obj("GPUCommandEncoder");
  e.beginRenderPass = () => { count("encoder.beginRenderPass"); return makePass("GPURenderPassEncoder"); };
  e.beginComputePass = () => { count("encoder.beginComputePass"); return makePass("GPUComputePassEncoder"); };
  for (const n of ["copyBufferToBuffer", "copyBufferToTexture", "copyTextureToBuffer", "copyTextureToTexture", "clearBuffer",
    "resolveQuerySet", "pushDebugGroup", "popDebugGroup", "insertDebugMarker"]) e[n] = () => { count("encoder." + n); };
  e.finish = () => { count("encoder.finish"); return obj("GPUCommandBuffer"); };
  return e;
}

function pipeline(kind) {
  const p = obj(kind);
  p.getBindGroupLayout = (i) => { count("pipeline.getBindGroupLayout"); return obj("GPUBindGroupLayout"); };
  return p;
}

function makeDevice(desc) {
  const d = obj("GPUDevice");
  d.features = new Set(desc?.requiredFeatures ?? []);
  d.limits = { ...limits };
  d.lost = new Promise(() => {});
  d.onuncapturederror = null;
  d.addEventListener = () => {}; d.removeEventListener = () => {};
  d.queue = {
    __kind: "GPUQueue", label: "",
    writeBuffer: (buffer, offset, data, dataOffset, size) => {
      count("queue.writeBuffer");
      const bpe = data.BYTES_PER_ELEMENT ?? 1;
      stats.writeBufferBytes += size !== undefined ? size * bpe : (data.byteLength - (dataOffset ?? 0) * bpe);
      if (rec.on) hashBytes(data, dataOffset, size);
      if (rec.on) writes.push(phaseName + " buf" + buffer.__id + "(" + (buffer.label || "") + ") off=" + offset + " " + describe(data, dataOffset, size));
    },
    writeTexture: (dst, data, layout, size) => { count("queue.writeTexture"); stats.writeTextureBytes += data.byteLength ?? 0; },
    copyExternalImageToTexture: () => { count("queue.copyExternalImageToTexture"); },
    submit: (cmds) => { count("queue.submit"); },
    onSubmittedWorkDone: () => { count("queue.onSubmittedWorkDone"); return Promise.resolve(undefined); },
  };
  d.createBuffer = makeBuffer;
  d.createTexture = (t) => { count("device.createTexture"); return makeTexture(t); };
  d.createSampler = () => { count("device.createSampler"); return obj("GPUSampler"); };
  d.createShaderModule = (m) => { count("device.createShaderModule"); shaders.push(m.code); const s = obj("GPUShaderModule", m.label); s.getCompilationInfo = () => Promise.resolve({ messages: [] }); return s; };
  d.createBindGroupLayout = () => { count("device.createBindGroupLayout"); return obj("GPUBindGroupLayout"); };
  d.createPipelineLayout = () => { count("device.createPipelineLayout"); return obj("GPUPipelineLayout"); };
  d.createBindGroup = () => { count("device.createBindGroup"); return obj("GPUBindGroup"); };
  d.createRenderPipeline = () => { count("device.createRenderPipeline"); return pipeline("GPURenderPipeline"); };
  d.createRenderPipelineAsync = () => { count("device.createRenderPipelineAsync"); return Promise.resolve(pipeline("GPURenderPipeline")); };
  d.createComputePipeline = () => { count("device.createComputePipeline"); return pipeline("GPUComputePipeline"); };
  d.createComputePipelineAsync = () => { count("device.createComputePipelineAsync"); return Promise.resolve(pipeline("GPUComputePipeline")); };
  d.createCommandEncoder = makeEncoder;
  d.createRenderBundleEncoder = () => { count("device.createRenderBundleEncoder"); return makePass("GPURenderBundleEncoder"); };
  d.createQuerySet = (q) => { count("device.createQuerySet"); const s = obj("GPUQuerySet"); s.type = q.type; s.count = q.count; s.destroy = () => {}; return s; };
  d.importExternalTexture = () => { count("device.importExternalTexture"); return obj("GPUExternalTexture"); };
  d.pushErrorScope = () => { count("device.pushErrorScope"); };
  d.popErrorScope = () => { count("device.popErrorScope"); return Promise.resolve(null); };
  d.destroy = () => { count("device.destroy"); };
  return d;
}

const adapter = {
  __kind: "GPUAdapter", features: adapterFeatures, limits: { ...limits },
  info: { vendor: "fake", architecture: "", device: "", description: "fake WebGPU (call recorder)" },
  isFallbackAdapter: false,
  requestDevice: (desc) => { count("adapter.requestDevice"); return Promise.resolve(makeDevice(desc)); },
};

export const gpu = {
  requestAdapter: () => { count("gpu.requestAdapter"); return Promise.resolve(adapter); },
  getPreferredCanvasFormat: () => "bgra8unorm",
  wgslLanguageFeatures: new Set(["readonly_and_readwrite_storage_textures", "packed_4x8_integer_dot_product", "unrestricted_pointer_parameters", "pointer_composite_access"]),
};

export function makeCanvas(width, height) {
  let config = null;
  const canvas = {
    width, height, clientWidth: width, clientHeight: height,
    style: {}, isCanvas: true,
    addEventListener: () => {}, removeEventListener: () => {},
    setAttribute: () => {}, getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width, height }),
  };
  const context = {
    canvas,
    configure: (c) => { count("context.configure"); config = c; },
    unconfigure: () => { count("context.unconfigure"); },
    getConfiguration: () => config,
    getCurrentTexture: () => {
      count("context.getCurrentTexture");
      return makeTexture({ size: { width: canvas.width, height: canvas.height }, format: config?.format ?? "bgra8unorm", usage: 16 });
    },
  };
  canvas.getContext = (type) => (type === "webgpu" ? context : null);
  return canvas;
}

// The flag objects three.js reads as browser globals.
export function installGlobals() {
  const g = globalThis;
  g.GPUBufferUsage = { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
  g.GPUTextureUsage = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
  g.GPUMapMode = { READ: 1, WRITE: 2 };
  g.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  g.GPUColorWrite = { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 };
  for (const k of Object.keys(classes)) g[k] = classes[k];
  const nav = { gpu, userAgent: "Bloom (fake WebGPU)", language: "en", hardwareConcurrency: 8 };
  try { Object.defineProperty(g, "navigator", { value: nav, configurable: true, writable: true }); } catch (e) { g.navigator = nav; }
  if (g.self === undefined) g.self = g;
  const fakeNow = () => clock;
  try { Object.defineProperty(g.performance, "now", { value: fakeNow, configurable: true, writable: true }); } catch (e) { g.performance = { now: fakeNow }; }
  // a manual frame clock: the test calls tickFrame(ms) to run one browser frame
  g.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
  g.cancelAnimationFrame = () => {};
}
