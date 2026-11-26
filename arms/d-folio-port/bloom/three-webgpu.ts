/**
 * `three/webgpu` for the Bloom build. The bridge maps it to three.module.js (core + WebGL), which
 * has none of the WebGPU build's node materials, RenderPipeline, QuadMesh or storage attributes.
 * This is the real three.webgpu.js (same three.core.js as the bridge) with the Bloom renderer
 * (renderer.ts: the bridge's, plus what this game asks of a WebGPURenderer).
 */
export * from "folio-bloom/real/three-webgpu";
export { FolioRenderer as WebGPURenderer, FolioRenderer as WebGLRenderer, RenderPipeline, RenderPipeline as PostProcessing } from "./renderer.ts";
