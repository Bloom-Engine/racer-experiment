import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Manifest, RacingLinePoint } from './manifest';

/** Everything the game needs, loaded up-front from local files (no network beyond the static host). */
export interface Assets {
  manifest: Manifest;
  track: GLTF;
  car: GLTF;
  /** paint materials indexed like manifest.car.variants (from KHR_materials_variants) */
  paints: THREE.Material[];
  racingLine: RacingLinePoint[];
  minimap: HTMLImageElement;
  sky: THREE.Texture;
  skyEnv: THREE.Texture;
  audio: Record<string, ArrayBuffer>;
}

const url = (p: string): string => `${import.meta.env.BASE_URL}${p}`;

export async function loadAssets(onProgress: (f: number) => void): Promise<Assets> {
  const manifest = (await (await fetch(url('manifest.json'))).json()) as Manifest;

  let done = 0;
  const total = 7 + Object.keys(manifest.audio.sounds).length;
  const tick = <T>(p: Promise<T>): Promise<T> =>
    p.then((v) => {
      done++;
      onProgress(done / total);
      return v;
    });

  const gltfLoader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();
  const loadTex = (p: string): Promise<THREE.Texture> =>
    texLoader.loadAsync(url(p)).then((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    });
  const loadImage = (p: string): Promise<HTMLImageElement> =>
    new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = url(p);
    });

  // WAV everywhere: decodes on every browser (Safari's Vorbis support is patchy) and loops sample-exactly.
  const audioEntries = Object.entries(manifest.audio.sounds);
  const audioPromises = audioEntries.map(([name, def]) =>
    tick(
      fetch(url(def.wav))
        .then((r) => r.arrayBuffer())
        .then((b) => [name, b] as const),
    ),
  );

  const [track, car, racingLine, minimap, sky, skyEnv, fontOk] = await Promise.all([
    tick(gltfLoader.loadAsync(url(manifest.track.file))),
    tick(gltfLoader.loadAsync(url(manifest.car.file))),
    tick(fetch(url(manifest.track.racing_line.file)).then((r) => r.json() as Promise<RacingLinePoint[]>)),
    tick(loadImage(manifest.track.minimap.file)),
    tick(loadTex(manifest.environment.sky.background.file)),
    tick(loadTex(manifest.environment.sky.environment_lighting.file)),
    tick(loadFont(manifest.ui.font.family, url(manifest.ui.font.file))),
  ]);
  void fontOk;

  // Variant paint materials straight from the glTF (KHR_materials_variants lists them as regular materials).
  const matDefs = (car.parser.json as { materials: { name: string }[] }).materials;
  const paints = await Promise.all(
    manifest.car.variants.map(async (v) => {
      const idx = matDefs.findIndex((m) => m.name === v.material);
      if (idx < 0) throw new Error(`paint ${v.material} missing`);
      return (await car.parser.getDependency('material', idx)) as THREE.Material;
    }),
  );

  const audio: Record<string, ArrayBuffer> = {};
  for (const [name, buf] of await Promise.all(audioPromises)) audio[name] = buf;

  sky.mapping = THREE.EquirectangularReflectionMapping;
  skyEnv.mapping = THREE.EquirectangularReflectionMapping;
  return { manifest, track, car, paints, racingLine, minimap, sky, skyEnv, audio };
}

async function loadFont(family: string, src: string): Promise<boolean> {
  try {
    const face = new FontFace(family, `url(${src})`);
    await face.load();
    document.fonts.add(face);
    return true;
  } catch {
    return false;
  }
}
