"""Small procedural-geometry toolkit (numpy only).

All coordinates are glTF conventions: right-handed, +Y up, metres.
A Mesh is an indexed triangle list with optional normals / uvs / vertex colours.
Triangles are counter-clockwise when seen from the front (glTF front face).
"""
from __future__ import annotations

import math
import numpy as np


class Mesh:
    def __init__(self, pos, idx, uv=None, col=None, nrm=None):
        self.pos = np.asarray(pos, dtype=np.float64).reshape(-1, 3)
        self.idx = np.asarray(idx, dtype=np.int64).reshape(-1, 3)
        self.uv = None if uv is None else np.asarray(uv, dtype=np.float64).reshape(-1, 2)
        self.col = None if col is None else np.asarray(col, dtype=np.float64).reshape(-1, 4)
        self.nrm = None if nrm is None else np.asarray(nrm, dtype=np.float64).reshape(-1, 3)

    # ------------------------------------------------------------------ basics
    @property
    def tri_count(self) -> int:
        return int(len(self.idx))

    def copy(self) -> "Mesh":
        return Mesh(self.pos.copy(), self.idx.copy(),
                    None if self.uv is None else self.uv.copy(),
                    None if self.col is None else self.col.copy(),
                    None if self.nrm is None else self.nrm.copy())

    def transformed(self, m: np.ndarray) -> "Mesh":
        out = self.copy()
        p = np.c_[self.pos, np.ones(len(self.pos))] @ m.T
        out.pos = p[:, :3]
        if self.nrm is not None:
            nm = np.linalg.inv(m[:3, :3]).T
            n = self.nrm @ nm.T
            out.nrm = _normalize(n)
        if np.linalg.det(m[:3, :3]) < 0:   # mirrored: keep front faces CCW
            out.idx = out.idx[:, ::-1].copy()
        return out

    def with_color(self, rgba) -> "Mesh":
        out = self.copy()
        out.col = np.tile(np.asarray(rgba, dtype=np.float64).reshape(1, 4), (len(self.pos), 1))
        return out

    def flipped(self) -> "Mesh":
        out = self.copy()
        out.idx = out.idx[:, ::-1].copy()
        if out.nrm is not None:
            out.nrm = -out.nrm
        return out

    def drop_degenerate(self, eps=1e-10) -> "Mesh":
        a, b, c = (self.pos[self.idx[:, i]] for i in range(3))
        area2 = np.linalg.norm(np.cross(b - a, c - a), axis=1)
        out = self.copy()
        out.idx = self.idx[area2 > eps]
        return out

    # ----------------------------------------------------------------- normals
    def smooth_normals(self) -> "Mesh":
        a, b, c = (self.pos[self.idx[:, i]] for i in range(3))
        fn = np.cross(b - a, c - a)            # area weighted
        n = np.zeros_like(self.pos)
        for i in range(3):
            np.add.at(n, self.idx[:, i], fn)
        out = self.copy()
        out.nrm = _normalize(n)
        return out

    def flat(self) -> "Mesh":
        """Unweld so every triangle has its own vertices, then facet normals."""
        flat_idx = self.idx.reshape(-1)
        out = Mesh(self.pos[flat_idx], np.arange(len(flat_idx)).reshape(-1, 3),
                   None if self.uv is None else self.uv[flat_idx],
                   None if self.col is None else self.col[flat_idx])
        a, b, c = (out.pos[out.idx[:, i]] for i in range(3))
        fn = _normalize(np.cross(b - a, c - a))
        out.nrm = np.repeat(fn, 3, axis=0)
        return out

    def ensure_normals(self) -> "Mesh":
        return self if self.nrm is not None else self.smooth_normals()

    def bounds(self):
        return self.pos.min(axis=0), self.pos.max(axis=0)


def _normalize(v):
    v = np.asarray(v, dtype=np.float64)
    ln = np.linalg.norm(v, axis=-1, keepdims=True)
    bad = (ln[..., 0] < 1e-12)
    ln[bad] = 1.0
    out = v / ln
    if np.any(bad):
        out[bad] = (0.0, 1.0, 0.0)
    return out


normalize = _normalize


def merge(meshes) -> Mesh:
    meshes = [m for m in meshes if m is not None and m.tri_count > 0]
    if not meshes:
        raise ValueError("merge of empty list")
    has_uv = any(m.uv is not None for m in meshes)
    has_col = any(m.col is not None for m in meshes)
    meshes = [m.ensure_normals() for m in meshes]
    pos, idx, uv, col, nrm = [], [], [], [], []
    off = 0
    for m in meshes:
        pos.append(m.pos)
        nrm.append(m.nrm)
        idx.append(m.idx + off)
        if has_uv:
            uv.append(m.uv if m.uv is not None else np.zeros((len(m.pos), 2)))
        if has_col:
            col.append(m.col if m.col is not None else np.ones((len(m.pos), 4)))
        off += len(m.pos)
    return Mesh(np.vstack(pos), np.vstack(idx),
                np.vstack(uv) if has_uv else None,
                np.vstack(col) if has_col else None,
                np.vstack(nrm))


# --------------------------------------------------------------------- matrices
def T(x=0.0, y=0.0, z=0.0):
    m = np.eye(4)
    m[:3, 3] = (x, y, z)
    return m


def S(x=1.0, y=None, z=None):
    y = x if y is None else y
    z = x if z is None else z
    return np.diag([x, y, z, 1.0])


def Rx(a):
    c, s = math.cos(a), math.sin(a)
    m = np.eye(4)
    m[1, 1], m[1, 2], m[2, 1], m[2, 2] = c, -s, s, c
    return m


def Ry(a):
    c, s = math.cos(a), math.sin(a)
    m = np.eye(4)
    m[0, 0], m[0, 2], m[2, 0], m[2, 2] = c, s, -s, c
    return m


def Rz(a):
    c, s = math.cos(a), math.sin(a)
    m = np.eye(4)
    m[0, 0], m[0, 1], m[1, 0], m[1, 1] = c, -s, s, c
    return m


def chain(*ms):
    out = np.eye(4)
    for m in ms:
        out = out @ m
    return out


def quat_from_yaw(yaw):
    """Quaternion [x,y,z,w] for rotation `yaw` radians about +Y."""
    return [0.0, math.sin(yaw / 2), 0.0, math.cos(yaw / 2)]


def yaw_for_forward(dx, dz):
    """Yaw (about +Y) that turns the local forward axis -Z into direction (dx, dz)."""
    # Ry(a) * (0,0,-1) = (-sin a, 0, -cos a)
    return math.atan2(-dx, -dz)


# ------------------------------------------------------------------- primitives
def box(sx, sy, sz, center=(0, 0, 0), uv_scale=None) -> Mesh:
    """Axis aligned box, flat shaded, per-face planar UVs (metres * uv_scale)."""
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    faces = [  # normal, u axis, v axis
        ((1, 0, 0), (0, 0, -1), (0, 1, 0)),
        ((-1, 0, 0), (0, 0, 1), (0, 1, 0)),
        ((0, 1, 0), (1, 0, 0), (0, 0, -1)),
        ((0, -1, 0), (1, 0, 0), (0, 0, 1)),
        ((0, 0, 1), (1, 0, 0), (0, 1, 0)),
        ((0, 0, -1), (-1, 0, 0), (0, 1, 0)),
    ]
    h = np.array([hx, hy, hz])
    pos, nrm, uv, idx = [], [], [], []
    for n, u, v in faces:
        n, u, v = np.array(n, float), np.array(u, float), np.array(v, float)
        c = n * h
        eu, ev = u * h, v * h
        corners = [c - eu - ev, c + eu - ev, c + eu + ev, c - eu + ev]
        base = len(pos)
        for k, p in enumerate(corners):
            pos.append(p + np.array(center))
            nrm.append(n)
            su = np.abs(eu).sum() * 2
            sv = np.abs(ev).sum() * 2
            uu = [0, 1, 1, 0][k]
            vv = [1, 1, 0, 0][k]
            if uv_scale:
                uv.append((uu * su * uv_scale, vv * sv * uv_scale))
            else:
                uv.append((uu, vv))
        idx += [(base, base + 1, base + 2), (base, base + 2, base + 3)]
    return Mesh(pos, idx, uv, None, nrm)


def grid_surface(P, closed_u=False, closed_v=False, uv=None) -> Mesh:
    """Quad-grid surface from P[nv, nu, 3] (v rows, u columns). Front face is
    the side where (dP/du x dP/dv) points."""
    nv, nu = P.shape[:2]
    pos = P.reshape(-1, 3)
    cu = nu if closed_u else nu - 1
    cv = nv if closed_v else nv - 1
    ii, jj = np.meshgrid(np.arange(cv), np.arange(cu), indexing="ij")
    a = ii * nu + jj
    b = ii * nu + (jj + 1) % nu
    c = ((ii + 1) % nv) * nu + (jj + 1) % nu
    d = ((ii + 1) % nv) * nu + jj
    a, b, c, d = (x.reshape(-1) for x in (a, b, c, d))
    # quad a(u0,v0) b(u1,v0) c(u1,v1) d(u0,v1): CCW in (u,v) means normal = du x dv
    idx = np.r_[np.c_[a, b, c], np.c_[a, c, d]]
    if uv is None:
        U, V = np.meshgrid(np.linspace(0, 1, nu), np.linspace(0, 1, nv))
        uv = np.c_[U.reshape(-1), V.reshape(-1)]
    return Mesh(pos, idx, np.asarray(uv).reshape(-1, 2))


def lathe(profile, segments, axis="y", closed=True, u_range=(0, 1)) -> Mesh:
    """Revolve a 2D profile [(r, h), ...] around an axis. Normal points away
    from the axis if the profile goes in +h direction."""
    prof = np.asarray(profile, float)
    ang = np.linspace(0, 2 * math.pi, segments + 1)[:-1] if closed else np.linspace(0, 2 * math.pi, segments)
    P = np.zeros((len(prof), len(ang), 3))
    for i, (r, h) in enumerate(prof):
        cx, cz = r * np.cos(ang), r * np.sin(ang)
        if axis == "y":
            P[i] = np.c_[cx, np.full_like(cx, h), -cz]
        elif axis == "x":
            P[i] = np.c_[np.full_like(cx, h), cx, cz]
        else:
            raise ValueError(axis)
    U, V = np.meshgrid(np.linspace(u_range[0], u_range[1], len(ang)), np.linspace(0, 1, len(prof)))
    m = grid_surface(P, closed_u=closed, uv=np.c_[U.reshape(-1), V.reshape(-1)])
    return m


def cylinder(r, h, seg=12, caps=True, r_top=None) -> Mesh:
    """Cylinder/frustum along +Y from y=0 to y=h, smooth sides, flat caps."""
    r_top = r if r_top is None else r_top
    side = lathe([(r, 0), (r_top, h)], seg, axis="y").smooth_normals()
    parts = [side]
    if caps:
        for y, rr, up in ((0, r, False), (h, r_top, True)):
            if rr <= 1e-6:
                continue
            parts.append(disk(rr, seg, y, up))
    return merge(parts)


def disk(r, seg, y=0.0, up=True) -> Mesh:
    ang = np.linspace(0, 2 * math.pi, seg + 1)[:-1]
    pos = np.r_[[[0, y, 0]], np.c_[r * np.cos(ang), np.full(seg, y), -r * np.sin(ang)]]
    # vertices go CCW seen from +Y (x=cos, z=-sin), so (0, i, i+1) faces up
    idx = np.array([(0, 1 + i, 1 + (i + 1) % seg) for i in range(seg)])
    if not up:
        idx = idx[:, ::-1]
    uv = np.r_[[[0.5, 0.5]], np.c_[0.5 + 0.5 * np.cos(ang), 0.5 + 0.5 * np.sin(ang)]]
    return Mesh(pos, idx, uv, None, np.tile([0, 1 if up else -1, 0], (seg + 1, 1)))


def cone(r, h, seg=10, base=True) -> Mesh:
    return cylinder(r, h, seg, caps=base, r_top=0.0)


def icosphere(r=1.0, subdiv=1) -> Mesh:
    t = (1 + 5 ** 0.5) / 2
    v = [(-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0), (0, -1, t), (0, 1, t), (0, -1, -t), (0, 1, -t),
         (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)]
    f = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11), (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6),
         (7, 1, 8), (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9), (4, 9, 5), (2, 4, 11), (6, 2, 10),
         (8, 6, 7), (9, 8, 1)]
    verts = [np.array(p, float) / np.linalg.norm(p) for p in v]
    faces = list(f)
    for _ in range(subdiv):
        cache = {}

        def mid(a, b):
            key = (min(a, b), max(a, b))
            if key not in cache:
                p = verts[a] + verts[b]
                verts.append(p / np.linalg.norm(p))
                cache[key] = len(verts) - 1
            return cache[key]
        nf = []
        for a, b, c in faces:
            ab, bc, ca = mid(a, b), mid(b, c), mid(c, a)
            nf += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
        faces = nf
    P = np.array(verts) * r
    uv = np.c_[0.5 + np.arctan2(P[:, 2], P[:, 0]) / (2 * math.pi), 0.5 - np.arcsin(np.clip(P[:, 1] / r, -1, 1)) / math.pi]
    return Mesh(P, faces, uv, None, np.array(verts))


def extrude_polygon(poly2d, depth, axis_z=True) -> Mesh:
    """Extrude a convex-ish 2D polygon (x, y) along z from -depth/2..depth/2. Flat shaded."""
    poly = np.asarray(poly2d, float)
    n = len(poly)
    # ensure CCW
    area = 0.5 * np.sum(poly[:, 0] * np.roll(poly[:, 1], -1) - np.roll(poly[:, 0], -1) * poly[:, 1])
    if area < 0:
        poly = poly[::-1]
    hz = depth / 2
    pos, idx = [], []
    # front (+z) and back caps via fan (convex assumed)
    front = [(x, y, hz) for x, y in poly]
    back = [(x, y, -hz) for x, y in poly]
    pos += front
    idx += [(0, i, i + 1) for i in range(1, n - 1)]
    b0 = len(pos)
    pos += back
    idx += [(b0, b0 + i + 1, b0 + i) for i in range(1, n - 1)]
    for i in range(n):
        j = (i + 1) % n
        s = len(pos)
        pos += [back[i], back[j], front[j], front[i]]
        idx += [(s, s + 1, s + 2), (s, s + 2, s + 3)]
    m = Mesh(pos, idx)
    uvp = m.pos[:, :2]
    m.uv = (uvp - uvp.min(0)) / max(1e-6, (uvp.max(0) - uvp.min(0)).max())
    return m.flat()


def ribbon(left, right, v_coord=None, u_left=0.0, u_right=1.0, closed=False) -> Mesh:
    """Strip between two polylines (N,3). Front face is up when `left` is on the
    left-hand side of the direction of travel (looking down -> +Y normal)."""
    left = np.asarray(left, float)
    right = np.asarray(right, float)
    n = len(left)
    P = np.stack([left, right], axis=1)  # (n, 2, 3): v rows = along, u = across
    if v_coord is None:
        v_coord = np.r_[0, np.cumsum(np.linalg.norm(np.diff(left, axis=0), axis=1))]
    U = np.tile([u_left, u_right], (n, 1))
    V = np.tile(np.asarray(v_coord).reshape(-1, 1), (1, 2))
    m = grid_surface(P, closed_v=closed, uv=np.c_[U.reshape(-1), V.reshape(-1)])
    # grid: du = right-left (to the right), dv = forward; du x dv: right x forward = up? (x) x (-z) = +y. ok
    return m


def convex_hull_mesh(points) -> Mesh:
    from scipy.spatial import ConvexHull
    pts = np.asarray(points, float)
    hull = ConvexHull(pts)
    used = np.unique(hull.simplices)
    remap = -np.ones(len(pts), int)
    remap[used] = np.arange(len(used))
    faces = remap[hull.simplices]
    P = pts[used]
    c = P.mean(axis=0)
    # orient outward
    for k, (a, b, d) in enumerate(faces):
        n = np.cross(P[b] - P[a], P[d] - P[a])
        if np.dot(n, P[a] - c) < 0:
            faces[k] = (a, d, b)
    return Mesh(P, faces)
