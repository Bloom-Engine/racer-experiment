#!/usr/bin/env python3
"""Sporty coupe -> assets/cars/car.glb

Conventions: glTF (Y up, metres). Origin at ground level, centre of the
wheelbase, car faces -Z (right side of the car is +X).

Nodes:  car (root)
          body            paint (4 variants), glass, trim, chrome, headlights
          wheel_FL/FR/RL/RR   origin = wheel rotation centre, spin axis local +X
          brake_lights    separate emissive material
          exhaust_L/R     empties at the tail-pipe tips, local +Z = exhaust flow
          collider_body   convex hull <= 200 tris, invisible (see manifest)
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy.interpolate import PchipInterpolator

sys.path.insert(0, str(Path(__file__).parent))
from lib.geom import (Mesh, Rx, Ry, Rz, S, T, box, chain, convex_hull_mesh, cylinder, extrude_polygon, grid_surface,
                      lathe, merge, normalize)
from lib.gltf import GLB

ROOT = Path(__file__).resolve().parent.parent
TEX = ROOT / "assets" / "textures"
OUT = ROOT / "assets" / "cars" / "car.glb"

# ---------------------------------------------------------------- dimensions
WHEELBASE = 2.70
TRACK_WIDTH = 1.66          # wheel centre to wheel centre
WHEEL_RADIUS = 0.34
WHEEL_WIDTH = 0.255
RIM_RADIUS = 0.235
ARCH_RADIUS = 0.395
MASS_KG = 1420.0
COM_OFFSET = (0.0, 0.46, -0.08)   # relative to origin; slightly front biased (-Z = front)
Z_FRONT, Z_REAR = -2.30, 2.18
AXLE_F, AXLE_R = -WHEELBASE / 2, WHEELBASE / 2
VARIANTS = ["red", "blue", "yellow", "black"]


def pchip(keys):
    k = np.array(keys, float)
    return PchipInterpolator(k[:, 0], k[:, 1])


W = pchip([(-2.30, 0.80), (-2.20, 0.90), (-1.95, 0.955), (-1.35, 0.985), (-0.8, 0.965), (0.0, 0.952), (0.8, 0.975),
           (1.35, 0.992), (1.9, 0.962), (2.10, 0.90), (2.18, 0.83)])
YB = pchip([(-2.30, 0.24), (-2.18, 0.13), (-1.8, 0.12), (1.9, 0.13), (2.06, 0.15), (2.18, 0.27)])
YH = pchip([(-2.30, 0.50), (-2.22, 0.60), (-2.0, 0.70), (-1.6, 0.785), (-1.35, 0.805), (-1.0, 0.80), (-0.6, 0.80),
            (0.3, 0.84), (1.0, 0.88), (1.35, 0.90), (1.9, 0.91), (2.12, 0.88), (2.18, 0.81)])
YR = pchip([(-2.30, 0.51), (-2.22, 0.62), (-2.0, 0.69), (-1.4, 0.745), (-0.62, 0.80), (0.08, 1.215), (0.45, 1.24),
            (0.75, 1.225), (1.70, 0.965), (2.05, 0.94), (2.18, 0.83)])
WR = pchip([(-2.3, 0.45), (-0.62, 0.58), (0.1, 0.60), (0.8, 0.62), (1.7, 0.70), (2.18, 0.55)])

# column indices in the right half profile (see profile())
C_GH_BASE, C_GH_TOP, C_ROOF_EDGE, C_TOP = 9, 12, 13, 15
WINDSHIELD = (-0.60, 0.06)
REAR_WINDOW = (0.84, 1.62)
B_PILLAR = (0.40, 0.50)


def profile(z):
    """Right-half cross-section from bottom centre to top centre, (x, y) pairs."""
    w, yb, yh, yr, wr = float(W(z)), float(YB(z)), float(YH(z)), float(YR(z)), float(WR(z))
    wg = w * 0.90
    gh = yr - yh
    yre = yh + gh * 0.93 if gh > 0.12 else yh + (yr - yh) * 0.6
    side = lambda f: yb + f * (yh - yb)
    pts = [
        (0.0, yb), (0.66, yb), (0.69, yb + 0.005), (w * 0.93, yb + 0.02), (w * 0.99, yb + 0.10),
        (w, side(0.35)), (w, side(0.72)), (w * 0.988, yh - 0.03), (w * 0.955, yh),   # 0..8
        (wg, yh + 0.012),                                                             # 9 greenhouse base
    ]
    for f in (0.33, 0.66, 0.90):                                                      # 10, 11, 12
        x = wg + (wr - wg) * f + 0.03 * math.sin(math.pi * f) * (gh > 0.12)
        pts.append((x, yh + 0.012 + (yre - yh - 0.012) * f))
    pts += [(wr, yre), (wr * 0.55, yr - 0.006), (0.0, yr)]                             # 13 edge, 14, 15 top
    return pts


def arch_lift(x, y, z):
    """Cut wheel arches: lift side vertices out of a circle around each axle."""
    if abs(x) < 0.675:
        return y
    for za in (AXLE_F, AXLE_R):
        dz = z - za
        if abs(dz) < ARCH_RADIUS:
            top = WHEEL_RADIUS + math.sqrt(ARCH_RADIUS ** 2 - dz ** 2)
            if y < top:
                return top
    return y


def build_body():
    nz = 76
    zs = np.linspace(Z_FRONT, Z_REAR, nz)
    rings, cols = [], None
    for z in zs:
        right = profile(z)
        left = [(-x, y) for x, y in right[-2:0:-1]]          # top->bottom, excluding both centre points
        ring = right + left + [right[0]]                      # closed with duplicate seam (UV u=1)
        rings.append([(x, arch_lift(x, y, z), z) for x, y in ring])
    P = np.array(rings)                                       # (nz, ncol, 3)
    ncol = P.shape[1]
    # u = arc length around the ring (normalised), v = along the car
    seg = np.linalg.norm(np.diff(P[nz // 2], axis=0), axis=1)
    u_col = np.r_[0, np.cumsum(seg)] / seg.sum()
    V, U = np.meshgrid((zs - Z_FRONT) / (Z_REAR - Z_FRONT), u_col, indexing="ij")
    m = grid_surface(P, uv=np.c_[U.ravel(), V.ravel()])
    # make normals point outward (ring direction decides the sign)
    if _signed_volume(m) < 0:
        m.idx = m.idx[:, ::-1].copy()
    # caps: inset ring + fan, front and rear
    caps = []
    for k, sign in ((0, -1), (nz - 1, 1)):
        ring = P[k, :-1]
        c = ring.mean(axis=0)
        inset = c + (ring - c) * np.array([0.86, 0.80, 1.0])
        inset[:, 2] += sign * 0.035
        n = len(ring)
        pos = np.vstack([ring, inset, [c + np.array([0, 0, sign * 0.035])]])
        idx = []
        for i in range(n):
            j = (i + 1) % n
            idx += [(i, j, n + j), (i, n + j, n + i), (n + i, n + j, 2 * n)]
        cap = Mesh(pos, idx, np.tile([0.25, 0.5], (len(pos), 1)))
        if _signed_volume_rel(cap, P.reshape(-1, 3).mean(axis=0)) < 0:
            cap.idx = cap.idx[:, ::-1].copy()
        caps.append(cap)
    # per-face material class for the loft
    a, b, c = (m.idx[:, i] for i in range(3))
    col_of = lambda vi: vi % ncol
    row_of = lambda vi: vi // ncol
    fz = m.pos[m.idx].mean(axis=1)[:, 2]
    cmin = np.minimum(np.minimum(col_of(a), col_of(b)), col_of(c))
    cmax = np.maximum(np.maximum(col_of(a), col_of(b)), col_of(c))
    # mirror left-side columns to right-side numbering
    def mirror(ci):
        return np.where(ci > C_TOP, ncol - 1 - ci, ci)
    lo = np.minimum(mirror(cmin), mirror(cmax))
    hi = np.maximum(mirror(cmin), mirror(cmax))
    gh = YR(fz) - YH(fz)
    side_glass = (lo >= C_GH_BASE) & (hi <= C_GH_TOP) & (gh > 0.15) & ~((fz > B_PILLAR[0]) & (fz < B_PILLAR[1])) & (fz < 1.50)
    roof_band = (lo >= C_ROOF_EDGE) | ((cmin <= C_TOP) & (cmax >= C_TOP))  # incl. faces straddling the centre line
    roof_band &= (lo >= C_ROOF_EDGE - 0) | (hi >= C_TOP)
    shield = roof_band & (((fz > WINDSHIELD[0]) & (fz < WINDSHIELD[1])) | ((fz > REAR_WINDOW[0]) & (fz < REAR_WINDOW[1])))
    glass = side_glass | shield
    paint_m = Mesh(m.pos, m.idx[~glass], m.uv)
    glass_m = Mesh(m.pos, m.idx[glass], m.uv)
    paint = merge([smooth_by_angle(paint_m, 50)] + [smooth_by_angle(cp, 50) for cp in caps])
    glass_mesh = smooth_by_angle(glass_m, 50)
    return compact(paint), compact(glass_mesh), P


def _signed_volume(m):
    a, b, c = (m.pos[m.idx[:, i]] for i in range(3))
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6)


def _signed_volume_rel(m, centre):
    a, b, c = (m.pos[m.idx[:, i]] - centre for i in range(3))
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum())


def compact(m: Mesh) -> Mesh:
    """Drop unused/degenerate geometry and weld identical vertices."""
    m = m.drop_degenerate(1e-9)
    used = np.unique(m.idx)
    remap = -np.ones(len(m.pos), int)
    remap[used] = np.arange(len(used))
    out = Mesh(m.pos[used], remap[m.idx], None if m.uv is None else m.uv[used],
               None if m.col is None else m.col[used], None if m.nrm is None else m.nrm[used])
    return out


def smooth_by_angle(m: Mesh, deg) -> Mesh:
    """Unweld, then give each corner the average normal of incident faces whose
    normal is within `deg` of the corner's face (like Blender auto-smooth)."""
    m = m.drop_degenerate(1e-10)
    a, b, c = (m.pos[m.idx[:, i]] for i in range(3))
    fn_raw = np.cross(b - a, c - a)
    fn = normalize(fn_raw)
    nf = len(m.idx)
    cos_t = math.cos(math.radians(deg))
    # vertex -> faces incidence (by welded position so seams smooth too)
    key = np.round(m.pos, 5)
    _, pid = np.unique(key, axis=0, return_inverse=True)
    pid = pid.reshape(-1)
    corner_v = pid[m.idx].reshape(-1)
    corner_f = np.repeat(np.arange(nf), 3)
    order = np.argsort(corner_v, kind="stable")
    cv, cf = corner_v[order], corner_f[order]
    starts = np.searchsorted(cv, np.arange(pid.max() + 2))
    out_n = np.zeros((nf * 3, 3))
    for k in range(nf * 3):
        f = k // 3
        v = corner_v[k]
        faces = cf[starts[v]:starts[v + 1]]
        dots = fn[faces] @ fn[f]
        sel = faces[dots >= cos_t]
        out_n[k] = fn_raw[sel].sum(axis=0)
    flat_idx = m.idx.reshape(-1)
    res = Mesh(m.pos[flat_idx], np.arange(nf * 3).reshape(-1, 3),
               None if m.uv is None else m.uv[flat_idx], None if m.col is None else m.col[flat_idx], normalize(out_n))
    return weld(res)


def weld(m: Mesh) -> Mesh:
    parts = [np.round(m.pos, 5), np.round(m.nrm, 4)]
    if m.uv is not None:
        parts.append(np.round(m.uv, 5))
    if m.col is not None:
        parts.append(np.round(m.col, 4))
    key = np.hstack(parts)
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    return Mesh(m.pos[first], inv.reshape(-1)[m.idx], None if m.uv is None else m.uv[first],
                None if m.col is None else m.col[first], m.nrm[first])


# ------------------------------------------------------- surface projection
def project_patch(body: Mesh, rect, axis, toward_positive, nx=6, ny=4, offset=0.004, shape=None):
    """Grid patch over rect=(a0,b0,a1,b1) in the plane orthogonal to `axis`
    ('z' -> (x,y), 'x' -> (z,y)), projected onto the body along the axis from
    outside. Returns a Mesh (smooth normals) or None."""
    ax = {"x": 0, "y": 1, "z": 2}[axis]
    pa, pb = [i for i in range(3) if i != ax]
    A, B = np.meshgrid(np.linspace(rect[0], rect[2], nx + 1), np.linspace(rect[1], rect[3], ny + 1))
    if shape is not None:
        A, B = shape(A, B)
    q = np.c_[A.ravel(), B.ravel()]
    tri = body.pos[body.idx]
    t2 = tri[:, :, [pa, pb]]
    v0, v1, v2 = t2[:, 0], t2[:, 1], t2[:, 2]
    d00 = v1 - v0
    d01 = v2 - v0
    den = d00[:, 0] * d01[:, 1] - d00[:, 1] * d01[:, 0]
    ok = np.abs(den) > 1e-12
    hit = np.full(len(q), np.nan)
    for i, (qa, qb) in enumerate(q):
        rx, ry = qa - v0[:, 0], qb - v0[:, 1]
        with np.errstate(divide="ignore", invalid="ignore"):
            u = (rx * d01[:, 1] - ry * d01[:, 0]) / den
            v = (d00[:, 0] * ry - d00[:, 1] * rx) / den
        inside = ok & (u >= -1e-6) & (v >= -1e-6) & (u + v <= 1 + 1e-6)
        if not inside.any():
            continue
        depth = tri[inside, 0, ax] + u[inside] * (tri[inside, 1, ax] - tri[inside, 0, ax]) + v[inside] * (tri[inside, 2, ax] - tri[inside, 0, ax])
        hit[i] = depth.max() if toward_positive else depth.min()
    pos = np.zeros((len(q), 3))
    pos[:, pa], pos[:, pb] = q[:, 0], q[:, 1]
    pos[:, ax] = hit + (offset if toward_positive else -offset)
    G = pos.reshape(ny + 1, nx + 1, 3)
    m = grid_surface(G)
    good = ~np.isnan(m.pos[m.idx]).any(axis=(1, 2))
    if not good.any():
        return None
    m.idx = m.idx[good]
    m.pos = np.nan_to_num(m.pos)
    # orient: normal must point away from the body along the axis
    a, b, c = (m.pos[m.idx[:, i]] for i in range(3))
    nsum = np.cross(b - a, c - a).sum(axis=0)
    if (nsum[ax] > 0) != toward_positive:
        m.idx = m.idx[:, ::-1].copy()
    return compact(m).smooth_normals()


# ------------------------------------------------------------------- wheels
def build_wheel(right: bool):
    """Wheel in local space, axle along X, outer face towards +X (right side)."""
    hw = WHEEL_WIDTH / 2
    tyre_prof = [(RIM_RADIUS - 0.005, -hw + 0.01), (0.29, -hw), (0.325, -hw + 0.012), (WHEEL_RADIUS, -hw + 0.045),
                 (WHEEL_RADIUS, hw - 0.045), (0.325, hw - 0.012), (0.29, hw), (RIM_RADIUS - 0.005, hw - 0.01)]
    tyre = lathe(tyre_prof, 36, axis="x")
    tyre = fix_outward(tyre, np.zeros(3), radial_axis=0)
    tyre = smooth_by_angle(tyre, 40)
    # rim: inner barrel (visible through spokes) + lip + spokes + hub
    barrel = lathe([(RIM_RADIUS - 0.01, hw - 0.02), (RIM_RADIUS - 0.01, -hw + 0.03)], 36, axis="x")
    barrel = fix_inward(barrel)
    lip = lathe([(RIM_RADIUS - 0.03, hw - 0.012), (RIM_RADIUS + 0.004, hw - 0.006)], 36, axis="x")
    lip = fix_facing(lip, np.array([1.0, 0, 0]))
    spokes = []
    for k in range(5):
        ang = k * 2 * math.pi / 5
        for off in (-0.11, 0.11):
            sp = box(0.025, 0.17, 0.028)
            sp = sp.transformed(chain(Rx(ang + off), T(hw - 0.035, 0.07 + 0.085, 0)))
            spokes.append(sp)
    hub = cylinder(0.075, 0.05, 12).transformed(chain(T(hw - 0.06, 0, 0), Rz(-math.pi / 2)))
    cap = cylinder(0.035, 0.012, 10).transformed(chain(T(hw - 0.012, 0, 0), Rz(-math.pi / 2)))
    rim = merge([smooth_by_angle(barrel, 40), smooth_by_angle(lip, 40)] + spokes + [hub, cap])
    # brake disc + caliper (vertex coloured)
    disc = cylinder(0.19, 0.028, 24).transformed(chain(T(-0.03, 0, 0), Rz(-math.pi / 2))).with_color((0.30, 0.30, 0.32, 1))
    caliper = box(0.06, 0.09, 0.16).transformed(chain(Rx(-0.6), T(0.0, 0.16, 0.0))).with_color((0.85, 0.08, 0.05, 1))
    brake = merge([disc, caliper])
    parts = [tyre, rim, brake]
    if not right:
        parts = [p.transformed(S(-1, 1, 1)) for p in parts]
    return parts


def fix_outward(m, centre, radial_axis=0):
    """Orient lathe surface normals away from the axle (radially)."""
    a, b, c = (m.pos[m.idx[:, i]] for i in range(3))
    n = np.cross(b - a, c - a)
    fc = (a + b + c) / 3
    radial = fc.copy()
    radial[:, radial_axis] = 0
    sign = np.einsum("ij,ij->i", n, radial)
    # sidewall faces: use axial direction instead
    m = m.copy()
    side = np.abs(n[:, radial_axis]) > np.linalg.norm(n, axis=1) * 0.7
    axial_sign = n[:, radial_axis] * np.sign(fc[:, radial_axis])
    flip = np.where(side, axial_sign < 0, sign < 0)
    m.idx[flip] = m.idx[flip][:, ::-1]
    return m


def fix_inward(m):
    a, b, c = (m.pos[m.idx[:, i]] for i in range(3))
    n = np.cross(b - a, c - a)
    fc = (a + b + c) / 3
    radial = fc.copy()
    radial[:, 0] = 0
    flip = np.einsum("ij,ij->i", n, radial) > 0
    m = m.copy()
    m.idx[flip] = m.idx[flip][:, ::-1]
    return m


def fix_facing(m, direction):
    a, b, c = (m.pos[m.idx[:, i]] for i in range(3))
    n = np.cross(b - a, c - a)
    flip = n @ direction < 0
    m = m.copy()
    m.idx[flip] = m.idx[flip][:, ::-1]
    return m


# ----------------------------------------------------------------- assembly
def build():
    paint, glass, P = build_body()
    body_for_proj = merge([paint, glass])

    paint_uv = (0.25, 0.5)        # a plain-paint area of the livery texture for paint-coloured extras

    def solid_uv(m):
        m = m.copy()
        m.uv = np.tile(paint_uv, (len(m.pos), 1))
        return m

    # headlights (front, facing -Z), shaped as slanted lozenges
    def lozenge(A, B):
        return A, B + (A - A.mean()) * 0.18 * np.sign(A.mean())
    heads = [project_patch(body_for_proj, (sx * 0.50, 0.53, sx * 0.84, 0.61), "z", False, 6, 3, 0.006, lozenge)
             for sx in (-1, 1)]
    # tail lights (rear, facing +Z): two clusters + a slim connecting bar
    tails = [project_patch(body_for_proj, (sx * 0.42, 0.70, sx * 0.84, 0.79), "z", True, 6, 3, 0.006) for sx in (-1, 1)]
    tails.append(project_patch(body_for_proj, (-0.42, 0.745, 0.42, 0.765), "z", True, 8, 1, 0.006))
    # front grille + lower intake, rear diffuser panel (trim)
    grille = project_patch(body_for_proj, (-0.55, 0.26, 0.55, 0.44), "z", False, 10, 3, 0.005)
    rear_panel = project_patch(body_for_proj, (-0.70, 0.18, 0.70, 0.36), "z", True, 10, 2, 0.005)
    # side intakes behind the doors (trim), on both flanks
    # axis 'x' projects in the (y, z) plane -> rect = (y0, z0, y1, z1)
    intakes = [project_patch(body_for_proj, (0.42, 0.80, 0.58, 1.05), "x", sx > 0, 3, 4, 0.005) for sx in (-1, 1)]
    # trim boxes: splitter, side skirts, diffuser fins
    trim_parts = [g for g in (grille, rear_panel) if g is not None] + [m for m in intakes if m is not None]
    trim_parts.append(box(1.62, 0.03, 0.30, center=(0, 0.11, -2.10)))                       # front splitter
    for sx in (-1, 1):
        trim_parts.append(box(0.06, 0.07, 1.95, center=(sx * 0.93, 0.155, 0.0)))           # side skirts
    for x in (-0.36, -0.12, 0.12, 0.36):
        trim_parts.append(box(0.02, 0.10, 0.30, center=(x, 0.16, 2.02)))                   # diffuser fins
    # rear wing (airfoil) on two pylons
    foil = extrude_polygon([(0, 0), (0.08, 0.026), (0.20, 0.031), (0.33, 0.010), (0.33, 0.0), (0.15, -0.009)], 1.56)
    swap_xz = np.array([[0, 0, 1, 0], [0, 1, 0, 0], [1, 0, 0, 0], [0, 0, 0, 1]], float)
    wing = foil.transformed(chain(T(0, 1.06, 1.80), Rx(0.08), swap_xz))
    trim_parts.append(wing)
    for sx in (-1, 1):
        trim_parts.append(box(0.025, 0.16, 0.12, center=(sx * 0.55, 0.99, 1.92)))
        trim_parts.append(box(0.012, 0.11, 0.36, center=(sx * 0.785, 1.07, 1.97)))         # wing end plates
    trim = merge(trim_parts)
    # mirrors (paint coloured housing + glass face)
    extras_paint = []
    mirror_glass = []
    for sx in (-1, 1):
        gx = float(W(-0.40)) * 0.90                     # greenhouse base half-width at the A-pillar foot
        extras_paint.append(solid_uv(box(0.13, 0.075, 0.10, center=(sx * (gx + 0.13), 0.905, -0.40))))
        extras_paint.append(solid_uv(box(0.11, 0.028, 0.05, center=(sx * (gx + 0.035), 0.865, -0.41))))
        mirror_glass.append(box(0.11, 0.06, 0.01, center=(sx * (gx + 0.13), 0.905, -0.345)))
    paint_all = merge([paint] + extras_paint)
    glass_all = merge([glass] + mirror_glass)
    # exhausts: twin chrome tips per side, flowing towards +Z
    exh_pos = {"exhaust_L": (-0.46, 0.255, 2.25), "exhaust_R": (0.46, 0.255, 2.25)}
    chrome_parts = []
    for name, (x, y, z) in exh_pos.items():
        tube = cylinder(0.045, 0.24, 14, caps=False).transformed(chain(T(x, y, z - 0.24), Rx(math.pi / 2)))
        inner = cylinder(0.037, 0.20, 14, caps=False).flipped().transformed(chain(T(x, y, z - 0.20), Rx(math.pi / 2)))
        chrome_parts += [tube, inner]
    chrome = merge(chrome_parts)
    soot = merge([cylinder(0.036, 0.01, 12).transformed(chain(T(x, y, z - 0.08), Rx(math.pi / 2)))
                  for (x, y, z) in exh_pos.values()])
    trim = merge([trim, soot])
    headlights = merge([h for h in heads if h is not None])
    brake_lights = merge([t for t in tails if t is not None])

    # collider: convex hull of a coarse sampling of the body loft
    coarse = P[::5, ::2].reshape(-1, 3)
    coarse = np.vstack([coarse, P[-1, ::2]])
    hull = convex_hull_mesh(coarse)
    step = 5
    while hull.tri_count > 200 and step < 20:
        step += 1
        hull = convex_hull_mesh(np.vstack([P[::step, ::2].reshape(-1, 3), P[-1, ::2]]))
    hull = hull.flat()

    wheels_r = build_wheel(True)
    wheels_l = build_wheel(False)
    return dict(paint=paint_all, glass=glass_all, trim=trim, chrome=chrome, headlights=headlights,
                brake_lights=brake_lights, collider=hull, wheel_r=wheels_r, wheel_l=wheels_l, exhausts=exh_pos)


def write(parts):
    g = GLB("race-assets build_car.py")
    mats = {}
    for v in VARIANTS:
        mats[f"paint_{v}"] = g.material(f"car_paint_{v}", base=(1, 1, 1, 1), metallic=0.45, roughness=0.30,
                                        base_tex=TEX / f"car_body_{v}_albedo.png")
    mats["glass"] = g.material("car_glass", base=(0.025, 0.03, 0.04, 1), metallic=0.1, roughness=0.06)
    mats["trim"] = g.material("car_trim", base=(0.035, 0.035, 0.04, 1), metallic=0.1, roughness=0.55)
    mats["chrome"] = g.material("car_chrome", base=(0.85, 0.85, 0.86, 1), metallic=1.0, roughness=0.18)
    mats["headlight"] = g.material("car_headlight", base=(0.9, 0.92, 0.95, 1), metallic=0.0, roughness=0.1,
                                   emissive=(1.0, 0.97, 0.90))
    mats["brake"] = g.material("car_brake_light", base=(0.45, 0.02, 0.02, 1), metallic=0.0, roughness=0.15,
                               emissive=(0.35, 0.01, 0.005),
                               extras={"emissive_off": [0.35, 0.01, 0.005], "emissive_on": [1.0, 0.04, 0.02],
                                       "emissive_strength_on": 4.0})
    mats["tyre"] = g.material("car_tyre", base=(0.045, 0.045, 0.05, 1), metallic=0.0, roughness=0.88)
    mats["rim"] = g.material("car_rim", base=(0.78, 0.79, 0.80, 1), metallic=1.0, roughness=0.28)
    mats["brake_disc"] = g.material("car_brake_disc", base=(1, 1, 1, 1), metallic=0.7, roughness=0.45)
    mats["collider"] = g.material("collider_invisible", base=(1, 0, 1, 0), metallic=0, roughness=1, alpha_mode="MASK",
                                  extras={"note": "fully transparent + alpha MASK: never visible even if an engine "
                                                  "ignores KHR_node_visibility"})

    g.set_root_extension("KHR_materials_variants", {"variants": [{"name": v} for v in VARIANTS]})
    variant_ext = {"KHR_materials_variants": {"mappings": [
        {"material": mats[f"paint_{v}"], "variants": [i]} for i, v in enumerate(VARIANTS)]}}

    body_mesh = g.mesh("body", [
        (parts["paint"], mats["paint_red"], variant_ext),
        (parts["glass"], mats["glass"]),
        (parts["trim"], mats["trim"]),
        (parts["chrome"], mats["chrome"]),
        (parts["headlights"], mats["headlight"]),
    ])
    wr, wl = parts["wheel_r"], parts["wheel_l"]
    wheel_r_mesh = g.mesh("wheel_right", [(wr[0], mats["tyre"]), (wr[1], mats["rim"]), (wr[2], mats["brake_disc"])])
    wheel_l_mesh = g.mesh("wheel_left", [(wl[0], mats["tyre"]), (wl[1], mats["rim"]), (wl[2], mats["brake_disc"])])
    brake_mesh = g.mesh("brake_lights", [(parts["brake_lights"], mats["brake"])])
    col_mesh = g.mesh("collider_body", [(parts["collider"], mats["collider"])])

    hx = TRACK_WIDTH / 2
    children = [g.node("body", body_mesh)]
    wheel_nodes = {
        "wheel_FL": ((-hx, WHEEL_RADIUS, AXLE_F), wheel_l_mesh),
        "wheel_FR": ((hx, WHEEL_RADIUS, AXLE_F), wheel_r_mesh),
        "wheel_RL": ((-hx, WHEEL_RADIUS, AXLE_R), wheel_l_mesh),
        "wheel_RR": ((hx, WHEEL_RADIUS, AXLE_R), wheel_r_mesh),
    }
    for name, (t, mesh) in wheel_nodes.items():
        children.append(g.node(name, mesh, translation=t,
                               extras={"spin_axis_local": [1, 0, 0], "steers": name in ("wheel_FL", "wheel_FR"),
                                       "radius_m": WHEEL_RADIUS, "width_m": WHEEL_WIDTH}))
    children.append(g.node("brake_lights", brake_mesh, extras={"emissive_material": "car_brake_light"}))
    for name, t in parts["exhausts"].items():
        children.append(g.node(name, translation=t, extras={"empty": True, "flow_direction_local": [0, 0, 1]}))
    children.append(g.node("collider_body", col_mesh, extras={"collider": True, "visible": False, "convex": True},
                           extensions={"KHR_node_visibility": {"visible": False}}))
    root = g.node("car", children=children, extras={
        "forward": [0, 0, -1], "up": [0, 1, 0], "origin": "ground level, centre of wheelbase",
        "wheel_radius_m": WHEEL_RADIUS, "wheel_width_m": WHEEL_WIDTH, "track_width_m": TRACK_WIDTH,
        "wheelbase_m": WHEELBASE, "mass_kg": MASS_KG, "centre_of_mass": list(COM_OFFSET)})
    g.scene("car", [root])
    size = g.write(OUT)

    tri = {
        "body": sum(p.tri_count for p in (parts["paint"], parts["glass"], parts["trim"], parts["chrome"], parts["headlights"])),
        "wheels": 2 * sum(p.tri_count for p in wr) + 2 * sum(p.tri_count for p in wl),
        "brake_lights": parts["brake_lights"].tri_count,
        "collider_body": parts["collider"].tri_count,
    }
    tri["visual_total"] = tri["body"] + tri["wheels"] + tri["brake_lights"]
    allp = merge([parts["paint"], parts["glass"], parts["trim"]])
    lo, hi = allp.bounds()
    meta = {
        "file": "cars/car.glb", "bytes": size, "triangles": tri,
        "dimensions_m": {"length": float(hi[2] - lo[2]), "width_body": float(hi[0] - lo[0]), "height": float(hi[1])},
        "wheel_radius_m": WHEEL_RADIUS, "wheel_width_m": WHEEL_WIDTH, "track_width_m": TRACK_WIDTH,
        "wheelbase_m": WHEELBASE, "mass_kg": MASS_KG, "centre_of_mass_offset_m": list(COM_OFFSET),
        "wheels": {k: {"position": list(v[0])} for k, v in wheel_nodes.items()},
        "exhausts": {k: list(v) for k, v in parts["exhausts"].items()},
        "variants": VARIANTS,
    }
    (ROOT / "build").mkdir(exist_ok=True)
    (ROOT / "build" / "car_meta.json").write_text(json.dumps(meta, indent=1))
    print(f"  car.glb: {size / 1024:.0f} KiB, triangles {tri}")


if __name__ == "__main__":
    write(build())
