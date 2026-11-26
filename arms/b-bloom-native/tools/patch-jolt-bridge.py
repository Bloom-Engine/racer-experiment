#!/usr/bin/env python3
"""Fix Bloom's web physics bridge (native/web/jolt_bridge.js) for JoltPhysics.js.

The bridge targets an API surface the npm/CDN JoltPhysics.js build does not
have, which breaks this game in the browser (crash on the first compound shape,
every body aliasing the last one created, mass 0, contacts crashing, raycast
masks ignored). tools/build-web.sh applies this to the COPY in dist/web, so the
engine checkout is left alone. Each fix is idempotent and fails loudly if the
bridge source has changed shape (then re-check against upstream Bloom).

Usage: patch-jolt-bridge.py <jolt_bridge.js> [more copies...]
"""
import sys

MARK = "/* bloom-racer web patches applied */"


def rep(s, old, new, what):
    if s.count(old) != 1:
        raise SystemExit(f"patch-jolt-bridge: cannot apply '{what}' (pattern found {s.count(old)}x)")
    return s.replace(old, new)


def between(s, start, end, new, what):
    i = s.find(start)
    j = s.find(end, i + 1) if i >= 0 else -1
    if i < 0 or j < 0:
        raise SystemExit(f"patch-jolt-bridge: cannot apply '{what}'")
    return s[:i] + new + s[j:]


def patch(s):
    # 1. BodyLockRead/BodyLockWrite are not bound by JoltPhysics.js.
    s = rep(s, """  JoltModule = await joltFactory();
  return JoltModule;
}
""", """  JoltModule = await joltFactory();
  installBodyLockShim(JoltModule);
  return JoltModule;
}

// JoltPhysics.js binds BodyLockInterface.TryGetBody but not the RAII
// BodyLockRead/BodyLockWrite classes. JS drives Jolt single-threaded and never
// touches a body during a step, so a lock-free stand-in is equivalent.
function installBodyLockShim(J) {
  if (typeof J.BodyLockRead === 'function' && typeof J.BodyLockWrite === 'function') return;
  class BodyLockShim {
    constructor(lockInterface, bodyId) {
      const body = lockInterface.TryGetBody(bodyId);
      this.body = body && J.getPointer(body) !== 0 ? body : null;
    }
    Succeeded() { return this.body !== null; }
    SucceededAndIsInBroadPhase() { return this.body !== null && this.body.IsInBroadPhase(); }
    GetBody() { return this.body; }
    ReleaseLock() { this.body = null; }
  }
  if (typeof J.BodyLockRead !== 'function') J.BodyLockRead = BodyLockShim;
  if (typeof J.BodyLockWrite !== 'function') J.BodyLockWrite = BodyLockShim;
}
""", "body lock shim")
    s = s.replace("GetMotionPropertiesUnchecked()", "GetMotionProperties()")

    # 2. Contact callbacks get raw heap pointers, not wrapped objects.
    s = rep(s, """  listener.OnContactAdded     = (b1, b2, m, s) => pushContact(0, b1, b2, m, s);
  listener.OnContactPersisted = (b1, b2, m, s) => pushContact(1, b1, b2, m, s);
  listener.OnContactRemoved   = (pair) => {
    const b1 = pair.GetBody1ID();""", """  const wrapContact = (event, b1, b2, m, s) => pushContact(
    event,
    J.wrapPointer(b1, J.Body), J.wrapPointer(b2, J.Body),
    m ? J.wrapPointer(m, J.ContactManifold) : null,
    s ? J.wrapPointer(s, J.ContactSettings) : null,
  );
  listener.OnContactAdded     = (b1, b2, m, s) => wrapContact(0, b1, b2, m, s);
  listener.OnContactPersisted = (b1, b2, m, s) => wrapContact(1, b1, b2, m, s);
  listener.OnContactRemoved   = (pairPtr) => {
    const pair = J.wrapPointer(pairPtr, J.SubShapeIDPair);
    const b1 = pair.GetBody1ID();""", "contact pointer wrapping")

    # 3. Native exposes only the latest step's contact events.
    s = rep(s, """  const steps = Math.max(1, collisionSteps | 0);
  w.jolt.Step(dt, steps);""", """  const steps = Math.max(1, collisionSteps | 0);
  state.contacts.length = 0;  // per-step events, as native (else unbounded growth)
  w.jolt.Step(dt, steps);""", "contact queue per step")
    s = rep(s, """  const w = state.worlds.get(h); if (!w) return 1;
  const st = stepState(w);""", """  const w = state.worlds.get(h); if (!w) return 1;
  const st = stepState(w);
  state.contacts.length = 0;""", "contact queue per fixed batch")

    # 4. Value-returned BodyIDs are a shared emscripten temporary: copy them.
    s = rep(s, "function resolveBody(h) { return state.bodies.get(h); }",
            "function resolveBody(h) { return state.bodies.get(h); }\n"
            "function ownBodyId(id) { return new JoltModule.BodyID(id.GetIndexAndSequenceNumber()); }",
            "ownBodyId helper")
    s = rep(s, "const bodyId = w.bodyInterface.CreateAndAddBody(settings, J.EActivation_Activate);",
            "const bodyId = ownBodyId(w.bodyInterface.CreateAndAddBody(settings, J.EActivation_Activate));",
            "body id copy")
    s = rep(s, "const bodyId = w.bodyInterface.CreateAndAddSoftBody(bcs, J.EActivation_Activate);",
            "const bodyId = ownBodyId(w.bodyInterface.CreateAndAddSoftBody(bcs, J.EActivation_Activate));",
            "soft body id copy")
    s = rep(s, "const chassisId = w.bodyInterface.CreateAndAddBody(chassisSettings, J.EActivation_Activate);",
            "const chassisId = ownBodyId(w.bodyInterface.CreateAndAddBody(chassisSettings, J.EActivation_Activate));",
            "chassis id copy")

    # 5. BodyInterface has no GetInverseMass in JoltPhysics.js.
    s = rep(s, """  const inv = bi.GetInverseMass ? bi.GetInverseMass(b.bodyId) : 0;
  return inv > 0 ? 1 / inv : 0;""", """  const w = state.worlds.get(b.world);
  const body = w.system.GetBodyLockInterfaceNoLock().TryGetBody(b.bodyId);
  if (!body || JoltModule.getPointer(body) === 0 || body.IsStatic()) return 0;
  const inv = body.GetMotionProperties().GetInverseMass();
  return inv > 0 ? 1 / inv : 0;""", "body mass")

    # 6. *ShapeSettings / AddShape take ShapeSettings; the bridge holds Shapes.
    s = rep(s, """  const settings = new JoltModule.ScaledShapeSettings(inner, vec3(sx, sy, sz));
  const result = settings.Create();
  return result.IsValid() ? registerShape(result.Get()) : 0;""",
            "  return registerShape(new JoltModule.ScaledShape(inner, vec3(sx, sy, sz)));", "scaled shape")
    s = rep(s, """  const settings = new JoltModule.OffsetCenterOfMassShapeSettings(vec3(ox, oy, oz), inner);
  const result = settings.Create();
  return result.IsValid() ? registerShape(result.Get()) : 0;""",
            "  return registerShape(new JoltModule.OffsetCenterOfMassShape(inner, vec3(ox, oy, oz)));", "offset COM shape")
    s = rep(s, "settings.AddShape(vec3(c.px, c.py, c.pz), quat(c.rx, c.ry, c.rz, c.rw), c.shape, 0);",
            "settings.AddShapeShape(vec3(c.px, c.py, c.pz), quat(c.rx, c.ry, c.rz, c.rw), c.shape, 0);",
            "compound child")

    # 7. AddForce overloads are (id, force, activation) and (id, force, point,
    #    activation): the 3-argument point call hit the first one, so every
    #    force acted at the centre of mass (no yaw from tyre forces: cars could
    #    not steer). Pass the activation mode explicitly everywhere.
    s = rep(s, "if (bi) bi.AddForce(b.bodyId, vec3(x, y, z)); }",
            "if (bi) bi.AddForce(b.bodyId, vec3(x, y, z), JoltModule.EActivation_Activate); }", "AddForce activation")
    s = rep(s, "if (bi) bi.AddTorque(b.bodyId, vec3(x, y, z)); }",
            "if (bi) bi.AddTorque(b.bodyId, vec3(x, y, z), JoltModule.EActivation_Activate); }", "AddTorque activation")
    s = rep(s, ": bi.AddForce(b.bodyId,   vec3(fx, fy, fz), rvec3(px, py, pz)); }",
            ": bi.AddForce(b.bodyId,   vec3(fx, fy, fz), rvec3(px, py, pz), JoltModule.EActivation_Activate); }",
            "AddForce at point")

    # 9. vec3()/rvec3()/quat() allocated a new object on Jolt's emscripten heap
    #    for every call argument and never freed it: with 4 cars at 60 Hz the
    #    heap aborted with OOM after ~5 min. Every use is a temporary that Jolt
    #    copies (by-value args, settings fields, push_back), so hand out
    #    entries from small rings of reused objects instead.
    s = rep(s, """function vec3(x, y, z) { return new JoltModule.Vec3(x, y, z); }
function rvec3(x, y, z) { return new JoltModule.RVec3(x, y, z); }
function quat(x, y, z, w) { return new JoltModule.Quat(x, y, z, w); }""", """const TMP_RING = 64;
const tmpRings = { v: [], r: [], q: [], vi: 0, ri: 0, qi: 0 };
function vec3(x, y, z) {
  const R = tmpRings;
  if (R.v.length < TMP_RING) { const o = new JoltModule.Vec3(x, y, z); R.v.push(o); return o; }
  const o = R.v[R.vi]; R.vi = (R.vi + 1) % TMP_RING; o.Set(x, y, z); return o;
}
function rvec3(x, y, z) {
  const R = tmpRings;
  if (R.r.length < TMP_RING) { const o = new JoltModule.RVec3(x, y, z); R.r.push(o); return o; }
  const o = R.r[R.ri]; R.ri = (R.ri + 1) % TMP_RING; o.Set(x, y, z); return o;
}
function quat(x, y, z, w) {
  const R = tmpRings;
  if (R.q.length < TMP_RING) { const o = new JoltModule.Quat(x, y, z, w); R.q.push(o); return o; }
  const o = R.q[R.qi]; R.qi = (R.qi + 1) % TMP_RING; o.Set(x, y, z, w); return o;
}""", "temp vector rings")

    # 8. raycast: honour the layer mask (native: bit 1 << objectLayer) and
    #    return the real surface normal.
    s = between(s, "export function raycast(worldH, ox, oy, oz, dx, dy, dz, maxDist, layerMask) {",
                "export function raycastAll(", """export function raycast(worldH, ox, oy, oz, dx, dy, dz, maxDist, layerMask) {
  state.rayHits.length = 0;
  const w = state.worlds.get(worldH); if (!w) return 0;
  const J = JoltModule;
  const dir = vec3(dx, dy, dz);
  if (dir.LengthSq() === 0) return 0;
  const len = Math.sqrt(dir.LengthSq());
  const sx = dx / len * maxDist, sy = dy / len * maxDist, sz = dz / len * maxDist;
  const ray = new J.RRayCast(rvec3(ox, oy, oz), vec3(sx, sy, sz));
  const qf = queryFilters(w, worldH, 1);
  const rcSettings = new J.RayCastSettings();
  // Subclassing ObjectLayerFilter traps on the npm builds, so a masked query
  // collects all hits and keeps the closest one whose layer is in the mask.
  const mask = layerMask >>> 0;
  const masked = mask !== 0 && mask !== 0xffffffff;
  const collector = masked ? new J.CastRayAllHitCollisionCollector() : new J.CastRayClosestHitCollisionCollector();
  w.system.GetNarrowPhaseQuery().CastRay(ray, rcSettings, collector, qf.bp, qf.obj, qf.body, qf.shape);
  let best = null;
  if (masked) {
    const hits = collector.mHits;
    const n = hits.size();
    for (let i = 0; i < n; i++) {
      const r = hits.at(i);
      if (best !== null && r.mFraction >= best.mFraction) continue;
      const layer = w.bodyInterface.GetObjectLayer(r.mBodyID);
      if (layer < 32 && (mask & (1 << layer)) === 0) continue;
      best = r;
    }
  } else if (collector.HadHit()) {
    best = collector.mHit;
  }
  let found = 0;
  if (best !== null) {
    const bodyId = best.mBodyID;
    const key = bodyId.GetIndexAndSequenceNumber();
    let bodyHandle = 0;
    for (const [h, b] of state.bodies) { if (b.world === worldH && b.bodyId.GetIndexAndSequenceNumber() === key) { bodyHandle = h; break; } }
    const fraction = best.mFraction;
    const px = ox + sx * fraction, py = oy + sy * fraction, pz = oz + sz * fraction;
    let normal = [0, 1, 0];
    const body = w.system.GetBodyLockInterfaceNoLock().TryGetBody(bodyId);
    if (body && J.getPointer(body) !== 0) {
      const nrm = body.GetWorldSpaceSurfaceNormal(best.mSubShapeID2, rvec3(px, py, pz));
      normal = [nrm.GetX(), nrm.GetY(), nrm.GetZ()];
    }
    state.rayHits.push({ body: bodyHandle, point: [px, py, pz], normal, fraction, subShapeId: 0 });
    found = 1;
  }
  J.destroy(collector); J.destroy(rcSettings); J.destroy(ray);
  return found;
}
""", "raycast")
    return MARK + "\n" + s


for path in sys.argv[1:]:
    src = open(path).read()
    if src.startswith(MARK):
        continue
    open(path, "w").write(patch(src))
    print(f"patched {path}")
