/**
 * THE BOUNDARY between Bloom physics and three.js rendering.
 *
 * Physics (Bloom/Jolt, src/physics/*) owns where things are. three.js (src/render/*) owns how
 * they look. Once per frame, after the fixed physics steps, this module copies poses across:
 *
 *   Vehicle.state / prevPos / prevRot   ──►   CarView.root  (position, quaternion)
 *   wheel centres, spin, steer angle    ──►   CarView.wheels[i] (local position, rotation)
 *   braking / nitro flags               ──►   brake-light material, exhaust flames
 *
 * Nothing flows the other way: three.js objects are never read back into physics. Track
 * colliders go one way too, once, at load time (render/scene.ts `triangles()` → PhysicsWorld).
 */
import * as THREE from "three";
import type { Vehicle } from "./physics/vehicle.ts";
import type { CarView } from "./render/scene.ts";

const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
const inv = new THREE.Matrix4();
const local = new THREE.Vector3();
const euler = new THREE.Euler(0, 0, 0, "YXZ");

/** Copy one car's physics pose to its three.js object, interpolated by `alpha` between the last two steps. */
export function syncCar(car: Vehicle, view: CarView, alpha: number, time: number): void {
  const s = car.state, p = car.prevPos, r = car.prevRot;
  const root = view.root;
  root.position.set(
    p.x + (s.pos.x - p.x) * alpha,
    p.y + (s.pos.y - p.y) * alpha,
    p.z + (s.pos.z - p.z) * alpha,
  );
  qa.set(r.x, r.y, r.z, r.w);
  qb.set(s.rot.x, s.rot.y, s.rot.z, s.rot.w);
  root.quaternion.copy(qa).slerp(qb, alpha);
  root.updateMatrixWorld(true);

  // wheels: Jolt gives world-space wheel centres (suspension travel); we bring them into the
  // car's frame and apply our own steer + spin, using the model's convention (spin about +X,
  // rolling forward = negative angle, steer about +Y, positive = left)
  inv.copy(root.matrixWorld).invert();
  for (let i = 0; i < 4; i++) {
    const w = view.wheels[i];
    const rest = view.wheelRest[i];
    if (w === undefined || rest === undefined) continue;
    const wp = s.wheelPos[i]!;
    local.set(wp.x, wp.y, wp.z).applyMatrix4(inv);
    // keep x/z at the model's mounting point, take the suspension height from physics
    const y = Math.max(rest.y - 0.15, Math.min(rest.y + 0.12, local.y));
    w.position.set(rest.x, y, rest.z);
    euler.set(s.wheelSpin[i]! * WHEEL_SPIN_SIGN, i < 2 ? s.steerAngle : 0, 0, "YXZ");
    w.quaternion.setFromEuler(euler);
  }

  view.setBraking(s.braking);
  view.setNitro(s.nitroActive, time);
}

/** Jolt's wheel angular velocity is positive rolling forward; the model rolls forward about -X. */
export const WHEEL_SPIN_SIGN = -1;
