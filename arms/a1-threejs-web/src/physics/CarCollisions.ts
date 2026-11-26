import { CAR } from '../core/config';
import type { Vehicle } from './Vehicle';

const INV_MASS = 1 / CAR.mass;
const INV_INERTIA = 1 / ((CAR.mass * (4.6 * 4.6 + 2.0 * 2.0)) / 12);
const ANG = 0.5;
const RESTITUTION = 0.3;
const FRICTION = 0.1;

export interface CarHit {
  a: number;
  b: number;
  dv: number;
  x: number;
  z: number;
}

/**
 * Car bodies are three circles each; for every pair we resolve the deepest
 * circle overlap with positional correction plus a two-body impulse (linear + yaw).
 */
export function collideCars(cars: Vehicle[], out: CarHit[]): void {
  const r = CAR.circleRadius;
  const offs = CAR.circleOffsets;
  for (let i = 0; i < cars.length; i++) {
    const A = cars[i];
    for (let j = i + 1; j < cars.length; j++) {
      const B = cars[j];
      if (A.ghostTime > 0 || B.ghostTime > 0) continue;
      const dx0 = A.pos.x - B.pos.x;
      const dz0 = A.pos.z - B.pos.z;
      if (dx0 * dx0 + dz0 * dz0 > 6 * 6 || Math.abs(A.pos.y - B.pos.y) > 2.5) continue;
      let best = 0;
      let nx = 0;
      let nz = 0;
      let cxB = 0;
      let czB = 0;
      for (const oa of offs) {
        const ax = A.pos.x - A.fx * oa;
        const az = A.pos.z - A.fz * oa;
        for (const ob of offs) {
          const bx = B.pos.x - B.fx * ob;
          const bz = B.pos.z - B.fz * ob;
          const dx = ax - bx;
          const dz = az - bz;
          const d2 = dx * dx + dz * dz;
          if (d2 >= 4 * r * r) continue;
          const d = Math.sqrt(d2) || 1e-4;
          const pen = 2 * r - d;
          if (pen > best) {
            best = pen;
            nx = dx / d;
            nz = dz / d;
            cxB = bx;
            czB = bz;
          }
        }
      }
      if (best <= 0) continue;
      // positional correction, split evenly
      A.pos.x += nx * best * 0.5;
      A.pos.z += nz * best * 0.5;
      B.pos.x -= nx * best * 0.5;
      B.pos.z -= nz * best * 0.5;
      // contact point: surface of B's circle towards A
      const px = cxB + nx * r;
      const pz = czB + nz * r;
      const raX = px - A.pos.x;
      const raZ = pz - A.pos.z;
      const rbX = px - B.pos.x;
      const rbZ = pz - B.pos.z;
      const vax = A.vx + A.yawRate * raZ;
      const vaz = A.vz - A.yawRate * raX;
      const vbx = B.vx + B.yawRate * rbZ;
      const vbz = B.vz - B.yawRate * rbX;
      const rvx = vax - vbx;
      const rvz = vaz - vbz;
      const vn = rvx * nx + rvz * nz;
      if (vn >= 0) continue;
      const rnA = raZ * nx - raX * nz;
      const rnB = rbZ * nx - rbX * nz;
      const denom = 2 * INV_MASS + (rnA * rnA + rnB * rnB) * INV_INERTIA * ANG;
      const J = (-(1 + RESTITUTION) * vn) / denom;
      A.vx += nx * J * INV_MASS;
      A.vz += nz * J * INV_MASS;
      A.yawRate += rnA * J * INV_INERTIA * ANG;
      B.vx -= nx * J * INV_MASS;
      B.vz -= nz * J * INV_MASS;
      B.yawRate -= rnB * J * INV_INERTIA * ANG;
      // a little tangential friction so side-swipes drag the cars together
      const tx = -nz;
      const tz = nx;
      const vt = rvx * tx + rvz * tz;
      let jt = -vt / (2 * INV_MASS);
      const jtMax = FRICTION * J;
      jt = Math.max(-jtMax, Math.min(jtMax, jt));
      A.vx += tx * jt * INV_MASS;
      A.vz += tz * jt * INV_MASS;
      B.vx -= tx * jt * INV_MASS;
      B.vz -= tz * jt * INV_MASS;
      const dv = J * INV_MASS;
      if (dv > A.impact) A.impact = dv;
      if (dv > B.impact) B.impact = dv;
      out.push({ a: i, b: j, dv, x: px, z: pz });
    }
  }
}
