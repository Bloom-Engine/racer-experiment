// Scalar-argument scene-node material setter.
//
// Bloom's setSceneNodeMaterial(handle, material: PbrMaterial = {}) takes an
// object with a default parameter. In Perry's wasm build (0.5.1664) the object
// a game passes arrives with every field undefined, so the browser build
// silently got the default material (no sky emissive, no brake lights).
// Scalar arguments cross that boundary fine on every target.
import { setSceneNodeColor, setSceneNodePbr } from "bloom/scene";

// Bloom FFI (declared in Bloom's native manifest); there is no scalar
// emissive setter in Bloom's TS API.
declare function bloom_scene_set_material_emissive(handle: number, r: number, g: number, b: number): number;

/** color: 0-255 (Bloom's scale), emissive: linear multipliers. */
export function setNodeMaterial(
  node: number,
  r: number, g: number, b: number,
  roughness: number, metalness: number,
  er: number, eg: number, eb: number,
): void {
  setSceneNodeColor(node, r, g, b, 255);
  setSceneNodePbr(node, roughness, metalness);
  bloom_scene_set_material_emissive(node, er, eg, eb);
}
