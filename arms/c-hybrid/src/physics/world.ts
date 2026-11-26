/**
 * The Jolt world (Bloom physics): static track colliders and the fixed-step clock.
 * Knows nothing about three.js — it gets plain triangle arrays from the loader.
 */
import * as P from "@bloomengine/engine/physics";

export const Surface = { None: 0, Road: 1, Terrain: 2, Wall: 3, Car: 4 } as const;
export type Surface = number;

export interface TriangleSoup { positions: number[] /* xyz world */; indices: number[] }

export const FIXED_DT = 1 / 60;
/**
 * The track lives on its own object layer, NOT Layer.NON_MOVING: Bloom's vehicle shim builds its
 * wheel-ray tester as a NON_MOVING object, and the shim's broadphase filter lets NON_MOVING
 * objects see only the MOVING broadphase — so wheel rays never hit static bodies on layer 0.
 * Any layer other than 0 lands in the MOVING broadphase, where both the wheel rays and the
 * chassis collide with it. (HYBRID_FRICTION.md, "vehicle wheels fall through layer-0 ground".)
 */
export const TRACK_LAYER = 3;
/** Layer mask for the track (our own probes and the tunnelling guard). */
export const STATIC_MASK = 1 << TRACK_LAYER;

export class PhysicsWorld {
  readonly world: P.WorldHandle;
  private readonly surfaces = new Map<number, Surface>();
  private accumulator = 0;

  constructor() {
    this.world = P.createWorld({ gravity: { x: 0, y: -9.81, z: 0 } });
  }

  addStatic(soup: TriangleSoup, surface: Surface, friction: number): P.BodyHandle {
    const verts: P.Vec3[] = [];
    const p = soup.positions;
    for (let i = 0; i < p.length; i += 3) verts.push({ x: p[i]!, y: p[i + 1]!, z: p[i + 2]! });
    const shape = P.meshShape(verts, soup.indices);
    const body = P.createBody(this.world, shape, {
      motionType: P.MotionType.STATIC, objectLayer: TRACK_LAYER, friction, restitution: 0.05,
    });
    this.surfaces.set(body, surface);
    return body;
  }

  tagBody(body: P.BodyHandle, s: Surface): void { this.surfaces.set(body, s); }
  surfaceOf(body: P.BodyHandle): Surface { return this.surfaces.get(body) ?? Surface.None; }

  finish(): void { P.optimizeBroadphase(this.world); }

  /**
   * Advance in whole fixed steps. `beforeStep` runs before each one (per-step forces: the
   * arcade assists must be applied per solver step, not per frame). Returns the interpolation
   * alpha for rendering.
   */
  advance(dt: number, beforeStep: (h: number) => void, afterStep: () => void): number {
    this.accumulator += Math.min(dt, 0.1);
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < 4) {
      beforeStep(FIXED_DT);
      P.stepVariable(this.world, FIXED_DT);
      afterStep();
      this.accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === 4) this.accumulator = 0;
    return this.accumulator / FIXED_DT;
  }

  /** Down-probe against static geometry. */
  probe(x: number, y: number, z: number, length: number): { surface: Surface; distance: number } {
    const hit = P.raycast(this.world, { x, y, z }, { x: 0, y: -1, z: 0 }, length, STATIC_MASK);
    if (hit === null) return { surface: Surface.None, distance: Infinity };
    return { surface: this.surfaceOf(hit.body), distance: hit.fraction * length };
  }

  /** Does the segment a->b cross a wall? (anti-tunnelling guard) */
  wallBetween(a: P.Vec3, b: P.Vec3): boolean {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-4) return false;
    const hits = P.raycastAll(this.world, a, { x: dx / len, y: dy / len, z: dz / len }, len, 8, STATIC_MASK);
    for (const h of hits) if (this.surfaceOf(h.body) === Surface.Wall) return true;
    return false;
  }
}
