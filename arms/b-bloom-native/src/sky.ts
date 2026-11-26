// Sky dome helper: Bloom has no equirect sky-background API (setEnvClearFromHdr
// only averages an .hdr into a clear colour), so we build an inward-facing
// sphere with the manifest's equirect mapping and show the sky texture as
// emissive. The dome follows the camera.
import { createMeshExplicit } from "bloom/models";
import { loadTexture } from "bloom/textures";
import {
  createSceneNode, attachModelToNode, setSceneNodeTransform,
  setSceneNodeMaterialTextureHandles, setSceneNodeCastShadow, setSceneNodeReceiveShadow,
} from "bloom/scene";
import { setNodeMaterial } from "./material";

let node = 0;
export let FLIP = true; // Bloom culls the other winding for createMesh geometry
export function setSkyFlip(f: boolean): void { FLIP = f; }
const RADIUS = 900;
const m: number[] = [RADIUS, 0, 0, 0, 0, RADIUS, 0, 0, 0, 0, RADIUS, 0, 0, 0, 0, 1];

export function createSky(): void {
  const cols = 48, rows = 24;
  // Preallocated arrays + index writes (not multi-argument push): Perry's
  // wasm build mis-builds arrays filled with push(a, b, c, ...), which turned
  // the dome into stray triangles slicing through the browser scene.
  const vcount = (rows + 1) * (cols + 1);
  const icount = rows * cols * 6;
  const verts: number[] = new Array(vcount * 12);
  const idx: number[] = new Array(icount);
  let vi = 0;
  for (let r = 0; r <= rows; r++) {
    const v = r / rows;
    const elev = (0.5 - v) * Math.PI;           // v = 0.5 - asin(d.y)/pi
    const cy = Math.sin(elev), ce = Math.cos(elev);
    for (let c = 0; c <= cols; c++) {
      const u = c / cols;
      const az = (u - 0.5) * Math.PI * 2;      // u = 0.5 + atan2(d.z, d.x)/2pi
      const x = Math.cos(az) * ce, z = Math.sin(az) * ce;
      // unit sphere; normal points inward
      verts[vi] = x; verts[vi + 1] = cy; verts[vi + 2] = z;
      verts[vi + 3] = -x; verts[vi + 4] = -cy; verts[vi + 5] = -z;
      verts[vi + 6] = 1; verts[vi + 7] = 1; verts[vi + 8] = 1; verts[vi + 9] = 1;
      verts[vi + 10] = u; verts[vi + 11] = v;
      vi += 12;
    }
  }
  let ii = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c;
      const b = a + cols + 1;
      // winding: faces must point towards the centre (viewer inside)
      if (FLIP) {
        idx[ii] = a; idx[ii + 1] = b; idx[ii + 2] = a + 1;
        idx[ii + 3] = a + 1; idx[ii + 4] = b; idx[ii + 5] = b + 1;
      } else {
        idx[ii] = a; idx[ii + 1] = a + 1; idx[ii + 2] = b;
        idx[ii + 3] = a + 1; idx[ii + 4] = b + 1; idx[ii + 5] = b;
      }
      ii += 6;
    }
  }
  const mesh = createMeshExplicit(verts, vcount, idx, icount);
  const tex = loadTexture("assets/sky/sky_equirect_2048x1024.png");
  node = createSceneNode();
  attachModelToNode(node, mesh.handle, 0);
  setNodeMaterial(node, 255, 255, 255, 1, 0, 1, 1, 1);
  setSceneNodeMaterialTextureHandles(node, { baseColor: tex.handle, emissive: tex.handle });
  setSceneNodeCastShadow(node, false);
  setSceneNodeReceiveShadow(node, false);
  setSceneNodeTransform(node, m);
}

export function updateSky(cx: number, cy: number, cz: number): void {
  if (node === 0) return;
  m[12] = cx; m[13] = cy; m[14] = cz;
  setSceneNodeTransform(node, m);
}
