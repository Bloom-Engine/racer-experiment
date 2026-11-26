/**
 * DRACOLoader and KTX2Loader decode in Web Workers running WebAssembly (draco_decoder.wasm,
 * basis_transcoder.wasm), which a Perry binary doesn't run (PORT_LOG.md).
 *  - Draco: stage.mjs decodes the Draco models once, so GLTFLoader never needs a decoder; the
 *    stand-in keeps the setup calls and fails loudly if a Draco mesh still arrives.
 *  - KTX2: the game ships a PNG next to every .ktx it loads directly (projects, lab, intro labels);
 *    the stand-in loads that PNG instead, oriented as a KTX texture (flipY off).
 */
import { TextureLoader, type Texture } from "three/webgpu";

class Unsupported {
  readonly what: string;
  constructor(what: string) { this.what = what; }
  setDecoderPath(_path: string): this { return this; }
  setDecoderConfig(_config: unknown): this { return this; }
  setTranscoderPath(_path: string): this { return this; }
  setWorkerLimit(_n: number): this { return this; }
  detectSupport(_renderer: unknown): this { return this; }
  preload(): this { return this; }
  dispose(): this { return this; }
  load(url: string, _onLoad: unknown, _onProgress: unknown, onError?: (e: Error) => void): void {
    const e = new Error(`${this.what}: ${url} needs a WebAssembly decoder, which the native build doesn't have`);
    if (onError) onError(e); else console.error(e.message);
  }
  loadAsync(url: string): Promise<never> { return Promise.reject(new Error(`${this.what}: ${url} needs a WebAssembly decoder`)); }
  // GLTFLoader's KHR_draco_mesh_compression path
  decodeDracoFile(): Promise<never> { return Promise.reject(new Error(`${this.what}: a Draco mesh reached the native build (run stage.mjs)`)); }
  decodeGeometry(): Promise<never> { return this.decodeDracoFile(); }
}

export class DRACOLoader extends Unsupported { constructor(_manager?: unknown) { super("DRACOLoader"); } }

export class KTX2Loader extends Unsupported {
  private readonly png = new TextureLoader();
  constructor(_manager?: unknown) { super("KTX2Loader"); }
  override load(url: string, onLoad?: (t: Texture) => void, onProgress?: unknown, onError?: (e: Error) => void): void {
    const png = url.replace(/\.ktx2?(\?.*)?$/, ".png$1");
    if (png === url) { super.load(url, onLoad, onProgress, onError); return; }
    this.png.load(png, (t) => { t.flipY = false; t.needsUpdate = true; onLoad?.(t); }, undefined, (e) => onError?.(e as Error));
  }
  override loadAsync(url: string): Promise<never> {
    return new Promise((resolve, reject) => this.load(url, resolve as (t: Texture) => void, undefined, reject)) as Promise<never>;
  }
}
