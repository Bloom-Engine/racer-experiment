// Small allocation-light vector / quaternion helpers.
// Perry note: helpers deliberately use `if` statements rather than a single
// ternary-return body (see shooter docs/perry-quirks.md #8).

export interface V3 { x: number; y: number; z: number }
export interface Q4 { x: number; y: number; z: number; w: number }

export function v3(x: number, y: number, z: number): V3 {
  return { x: x, y: y, z: z };
}

export function clampN(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

export function lerpN(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate independent exponential smoothing factor. */
export function smoothK(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

export function moveTowards(cur: number, target: number, maxDelta: number): number {
  if (cur < target) {
    const n = cur + maxDelta;
    if (n > target) return target;
    return n;
  }
  const n = cur - maxDelta;
  if (n < target) return target;
  return n;
}

export function wrapAngle(a: number): number {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}

/** Rotate vector (x,y,z) by quaternion q, writing into out. */
export function qRotate(q: Q4, x: number, y: number, z: number, out: V3): V3 {
  // t = 2 * cross(q.xyz, v); v' = v + w*t + cross(q.xyz, t)
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  out.x = x + q.w * tx + (q.y * tz - q.z * ty);
  out.y = y + q.w * ty + (q.z * tx - q.x * tz);
  out.z = z + q.w * tz + (q.x * ty - q.y * tx);
  return out;
}

export function qFromYaw(yaw: number): Q4 {
  // rotation about +Y
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

export function qNlerp(a: Q4, b: Q4, t: number, out: Q4): Q4 {
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  if (a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
  const x = a.x + (bx - a.x) * t;
  const y = a.y + (by - a.y) * t;
  const z = a.z + (bz - a.z) * t;
  const w = a.w + (bw - a.w) * t;
  const l = Math.sqrt(x * x + y * y + z * z + w * w);
  let inv = 1;
  if (l > 1e-9) inv = 1 / l;
  out.x = x * inv; out.y = y * inv; out.z = z * inv; out.w = w * inv;
  return out;
}

/**
 * Column-major 4x4 from rotation quaternion + translation, written into m (16).
 */
export function mat4FromQT(q: Q4, px: number, py: number, pz: number, m: number[]): number[] {
  const x = q.x, y = q.y, z = q.z, w = q.w;
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  m[0] = 1 - 2 * (yy + zz); m[1] = 2 * (xy + wz);     m[2] = 2 * (xz - wy);     m[3] = 0;
  m[4] = 2 * (xy - wz);     m[5] = 1 - 2 * (xx + zz); m[6] = 2 * (yz + wx);     m[7] = 0;
  m[8] = 2 * (xz + wy);     m[9] = 2 * (yz - wx);     m[10] = 1 - 2 * (xx + yy); m[11] = 0;
  m[12] = px; m[13] = py; m[14] = pz; m[15] = 1;
  return m;
}

/** out = a * b (column-major 4x4). out must not alias a or b. */
export function mat4Mul(a: number[], b: number[], out: number[]): number[] {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

export function newMat4(): number[] {
  const m: number[] = new Array(16);
  for (let i = 0; i < 16; i++) m[i] = 0;
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  return m;
}
