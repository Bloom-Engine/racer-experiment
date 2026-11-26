/**
 * Deep imports of three's sources (`three/src/...`) would load a second copy of three.js next to the
 * build the rest of the game uses (and its own node classes): point them at the build instead.
 */
import { CubeRenderTarget, MathUtils } from "three/webgpu";
export const clamp = MathUtils.clamp;
export default CubeRenderTarget;
