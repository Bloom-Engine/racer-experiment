// Allocation-free physics calls for the per-step hot path (cars × wheels ×
// 60 Hz). Bloom's physics wrappers take and return fresh {x,y,z} objects;
// in the browser build Perry's wasm runtime never frees an object handle, so
// those temporaries piled up at ~10k/s and eventually crashed the tab. These
// call Bloom's native FFI (declared in Bloom's manifest) with scalars and
// write results into caller-owned objects. Behaviour is identical on native.
import { V3, Q4 } from "./util/math3d";

declare function bloom_physics_body_get_position(body: number, axis: number): number;
declare function bloom_physics_body_get_rotation(body: number, axis: number): number;
declare function bloom_physics_body_get_linear_velocity(body: number, axis: number): number;
declare function bloom_physics_body_get_angular_velocity(body: number, axis: number): number;
declare function bloom_physics_body_add_force(body: number, x: number, y: number, z: number): void;
declare function bloom_physics_body_add_torque(body: number, x: number, y: number, z: number): void;
declare function bloom_physics_body_add_force_at(body: number, fx: number, fy: number, fz: number, px: number, py: number, pz: number): void;
declare function bloom_physics_raycast(
  world: number, ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number, maxDist: number, layerMask: number,
): number;
declare function bloom_physics_ray_hit_body(i: number): number;
declare function bloom_physics_ray_hit_fraction(i: number): number;

export function bodyPosition(body: number, out: V3): void {
  out.x = bloom_physics_body_get_position(body, 0);
  out.y = bloom_physics_body_get_position(body, 1);
  out.z = bloom_physics_body_get_position(body, 2);
}
export function bodyRotation(body: number, out: Q4): void {
  out.x = bloom_physics_body_get_rotation(body, 0);
  out.y = bloom_physics_body_get_rotation(body, 1);
  out.z = bloom_physics_body_get_rotation(body, 2);
  out.w = bloom_physics_body_get_rotation(body, 3);
}
export function bodyLinearVelocity(body: number, out: V3): void {
  out.x = bloom_physics_body_get_linear_velocity(body, 0);
  out.y = bloom_physics_body_get_linear_velocity(body, 1);
  out.z = bloom_physics_body_get_linear_velocity(body, 2);
}
export function bodyAngularVelocity(body: number, out: V3): void {
  out.x = bloom_physics_body_get_angular_velocity(body, 0);
  out.y = bloom_physics_body_get_angular_velocity(body, 1);
  out.z = bloom_physics_body_get_angular_velocity(body, 2);
}
export function addForce(body: number, x: number, y: number, z: number): void {
  bloom_physics_body_add_force(body, x, y, z);
}
export function addTorque(body: number, x: number, y: number, z: number): void {
  bloom_physics_body_add_torque(body, x, y, z);
}
export function addForceAt(body: number, fx: number, fy: number, fz: number, px: number, py: number, pz: number): void {
  bloom_physics_body_add_force_at(body, fx, fy, fz, px, py, pz);
}
/** Closest hit; true if something was hit. Read it with rayHitBody/rayHitFraction. */
export function raycast(
  world: number, ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number, maxDist: number, layerMask: number,
): boolean {
  return bloom_physics_raycast(world, ox, oy, oz, dx, dy, dz, maxDist, layerMask) !== 0;
}
export function rayHitBody(): number { return bloom_physics_ray_hit_body(0); }
export function rayHitFraction(): number { return bloom_physics_ray_hit_fraction(0); }
