#!/usr/bin/env python3
"""Circuit + scenery -> assets/track/{track.glb, scenery.glb, racing_line.json, minimap_1024.png}

track.glb (scene "track", root node "track"):
  visual:    road (asphalt + paint), kerbs, barriers, terrain (grass + gravel),
             scenery_* (all scenery instances baked & merged by material)
  collision: col_road, col_barriers, col_terrain  (invisible, see manifest)
  empties:   spawn_1..spawn_4, cp_00..cp_15 (local -Z = race direction)
scenery.glb: one node per prototype (proto_*), for engines that prefer
             instancing; instance transforms are in the manifest.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).parent))
from lib.geom import (Mesh, Rx, Ry, S, T, box, chain, cone, cylinder, grid_surface, icosphere, merge, normalize,
                      quat_from_yaw, yaw_for_forward)
from lib.gltf import GLB
from lib.track import DS, KERB_WIDTH, ROAD_WIDTH, Track, build_track, corners, stats

ROOT = Path(__file__).resolve().parent.parent
TEX = ROOT / "assets" / "textures"
OUT = ROOT / "assets" / "track"
BUILD = ROOT / "build"
HW = ROAD_WIDTH / 2
N_CHECKPOINTS = 16
COL_STEP = 2            # collision meshes use every 2nd centreline sample (4 m)
BARRIER_STEP = 2
TERRAIN_SPACING = 8.0
TERRAIN_MARGIN = 360.0
RNG = np.random.default_rng(2024)
TILE = json.loads((BUILD / "texture_meta.json").read_text())["tile_metres"]
BB_UV = json.loads((BUILD / "billboard_uv.json").read_text())


# ======================================================================= utils
def loop(a):
    """Append the first row so a closed strip gets a proper UV seam."""
    return np.concatenate([a, a[:1]], axis=0)


def strip(inner, outer, v, u0=0.0, u1=1.0, up=True):
    """Ribbon between two polylines (N,3); front face points up (or outward)."""
    P = np.stack([inner, outer], axis=1)
    U = np.tile([u0, u1], (len(inner), 1))
    V = np.tile(np.asarray(v).reshape(-1, 1), (1, 2))
    m = grid_surface(P, uv=np.c_[U.ravel(), V.ravel()])
    a, b, c = (m.pos[m.idx[:, i]] for i in range(3))
    n = np.cross(b - a, c - a)
    if up and n[:, 1].sum() < 0:
        m.idx = m.idx[:, ::-1].copy()
    return m


def orient(m: Mesh, expected: np.ndarray):
    """Flip faces whose normal disagrees with `expected` (per face (F,3) or (3,))."""
    a, b, c = (m.pos[m.idx[:, i]] for i in range(3))
    n = np.cross(b - a, c - a)
    exp = np.broadcast_to(expected, n.shape)
    flip = np.einsum("ij,ij->i", n, exp) < 0
    m = m.copy()
    m.idx[flip] = m.idx[flip][:, ::-1]
    return m


def world_uv(m: Mesh, tile):
    m = m.copy()
    m.uv = np.c_[m.pos[:, 0], m.pos[:, 2]] / tile
    return m


def runs(mask):
    """Contiguous True runs in a cyclic boolean array -> list of index arrays."""
    n = len(mask)
    if mask.all():
        return [np.arange(n + 1) % n]
    if not mask.any():
        return []
    start = int(np.argmin(mask))           # a False index: start scanning after it
    out, cur = [], []
    for k in range(1, n + 1):
        i = (start + k) % n
        if mask[i]:
            cur.append(i)
        elif cur:
            out.append(np.array(cur))
            cur = []
    if cur:
        out.append(np.array(cur))
    return out


def quad(p0, p1, p2, p3, uv, normal):
    m = Mesh([p0, p1, p2, p3], [(0, 1, 2), (0, 2, 3)], uv)
    m = orient(m, np.asarray(normal, float))
    m.nrm = np.tile(normalize(np.asarray(normal, float)), (4, 1))
    return m


def place(m: Mesh, pos, yaw, scale=1.0):
    return m.transformed(chain(T(*pos), Ry(yaw), S(scale)))


# ================================================================ track parts
def build_road(tr: Track):
    L = tr.length
    c = loop(tr.pos3())
    left = loop(tr.pos3(HW))
    right = loop(tr.pos3(-HW))
    v = np.r_[tr.s, L] / TILE["asphalt"]
    t = TILE["asphalt"]
    surf = strip(right, left, v, -HW / t, HW / t)
    # skirts so the road edge never shows a gap to the run-off
    skirts = []
    for edge, sgn in ((left, 1), (right, -1)):
        low = edge - np.array([0, 0.35, 0])
        sk = strip(edge, low, v, 0, 0.35 / t, up=False)
        out_dir = loop(np.c_[tr.left[:, 0], np.zeros(tr.n), tr.left[:, 1]] * sgn)
        exp = np.repeat(out_dir[:-1], 2, axis=0)
        sk = orient(sk, np.r_[exp[0::2], exp[1::2]])
        skirts.append(sk)
    road = merge([surf.smooth_normals()] + [s.flat() for s in skirts])
    return road


def ribbon_along(tr: Track, s0, s1, o0, o1, dy, step=1.0):
    """Flat quad strip on the road between arc lengths s0..s1 and lateral offsets o0..o1."""
    n = max(2, int(abs(s1 - s0) / step) + 1)
    ss = np.linspace(s0, s1, n)
    p, _, lft = tr.sample(ss)
    lft3 = np.c_[lft[:, 0], np.zeros(n), lft[:, 1]]
    a = p + lft3 * o0 + np.array([0, dy, 0])
    b = p + lft3 * o1 + np.array([0, dy, 0])
    return strip(a, b, np.linspace(0, 1, n))


def build_paint(tr: Track, spawns):
    parts = []
    L = tr.length
    # edge lines
    for o0, o1 in ((HW - 0.55, HW - 0.30), (-HW + 0.30, -HW + 0.55)):
        parts.append(ribbon_along(tr, 0, L, o0, o1, 0.012, step=DS))
    # chequered start/finish line: 2 rows x 14 columns of 1 m squares (white squares only)
    for row in range(2):
        for col in range(14):
            if (row + col) % 2 == 0:
                o0 = -HW + col
                parts.append(ribbon_along(tr, -1.0 + row, row, o0, o0 + 1.0, 0.014, step=1.0))
    # grid boxes: front bar + outer side bar for every spawn slot
    for sp in spawns:
        s, lat = sp["s"], sp["lateral"]
        parts.append(ribbon_along(tr, s + 2.6, s + 2.9, lat - 1.5, lat + 1.5, 0.013, 0.3))
        side = lat + (1.5 if lat > 0 else -1.5)
        parts.append(ribbon_along(tr, s + 0.8, s + 2.9, side - 0.15 * np.sign(lat), side + 0.0, 0.013, 0.5))
    return merge([p.smooth_normals() for p in parts])


def build_kerbs(tr: Track):
    parts = []
    t = TILE["kerb"]
    for side, mask in ((1, tr.kerb_l), (-1, tr.kerb_r)):
        for idx in runs(mask):
            if len(idx) < 3:
                continue
            # cross-section (offset from road edge outward, height): ramp up, flat top, drop
            prof = [(0.0, 0.0), (0.15, 0.06), (KERB_WIDTH - 0.15, 0.05), (KERB_WIDTH, -0.08)]
            us = [0.0, 0.12, 0.88, 1.0]
            v = (tr.s[idx] - tr.s[idx[0]]) % tr.length / t
            P = np.zeros((len(idx), len(prof), 3))
            for j, (o, h) in enumerate(prof):
                off = side * (HW + o)
                p = tr.pos3(off)[idx]
                p[:, 1] += h
                P[:, j] = p
            U, V = np.meshgrid(us, v)
            m = grid_surface(P, uv=np.c_[U.ravel(), V.ravel()])
            a, b, c = (m.pos[m.idx[:, i]] for i in range(3))
            if np.cross(b - a, c - a)[:, 1].sum() < 0:
                m.idx = m.idx[:, ::-1].copy()
            parts.append(m.smooth_normals())
    return merge(parts)


def shoulder_polys(tr: Track, step=1):
    """Run-off strips per side, split into grass / gravel runs."""
    bl, br = tr.barrier_offset()
    out = {"grass": [], "gravel": []}
    for side, b, gravel in ((1, bl, tr.gravel_l), (-1, br, tr.gravel_r)):
        for kind, mask in (("gravel", gravel), ("grass", ~gravel)):
            for idx in runs(mask):
                # extend each run by one sample so neighbouring runs overlap (no gaps)
                idx = np.r_[idx, (idx[-1] + 1) % tr.n][::step] if step == 1 else np.r_[idx, (idx[-1] + 1) % tr.n][::step]
                if len(idx) < 2:
                    continue
                inner = tr.pos3(side * (HW - 0.3), -0.03)[idx]
                outer = tr.pos3(side * b, -0.03)[idx]
                m = strip(inner, outer, np.zeros(len(idx)))
                out[kind].append(m)
    return out


def jersey_profile():
    # (offset outward from barrier centre line, height); listed around the section
    return [(-0.30, -0.40), (-0.30, 0.12), (-0.14, 0.30), (-0.11, 1.0), (0.11, 1.0), (0.14, 0.30), (0.30, 0.12),
            (0.30, -0.40)]


def build_barriers(tr: Track):
    bl, br = tr.barrier_offset()
    idx = np.arange(0, tr.n, BARRIER_STEP)
    parts = []
    t = TILE["barrier"]
    prof = jersey_profile()
    for side, b in ((1, bl), (-1, br)):
        base = loop(tr.pos3(side * b)[idx])
        out_dir = loop(np.c_[tr.left[idx, 0], np.zeros(len(idx)), tr.left[idx, 1]] * side)
        seg = np.linalg.norm(np.diff(base, axis=0), axis=1)
        along = np.r_[0, np.cumsum(seg)] / t
        for j in range(len(prof) - 1):
            (d0, h0), (d1, h1) = prof[j], prof[j + 1]
            p0 = base + out_dir * d0 + np.array([0, h0, 0])
            p1 = base + out_dir * d1 + np.array([0, h1, 0])
            # v: 0 at the top of the wall (painted band in the texture) to 1 at the base
            v0, v1 = np.clip((1.0 - h0) / 1.0, 0, 1), np.clip((1.0 - h1) / 1.0, 0, 1)
            P = np.stack([p0, p1], axis=1)
            V = np.tile([v0, v1], (len(base), 1))
            U = np.tile(along.reshape(-1, 1), (1, 2))
            m = grid_surface(P, uv=np.c_[U.ravel(), V.ravel()])
            # expected normal: perpendicular to the section edge, pointing away from the wall core
            dd, dh = d1 - d0, h1 - h0
            nd, nh = dh, -dd                         # rotate edge by -90 deg in (d, h)
            mid_d = (d0 + d1) / 2
            if nd * mid_d + nh * ((h0 + h1) / 2 - 0.5) < 0:
                nd, nh = -nd, -nh
            exp = out_dir[:-1] * nd + np.array([0, nh, 0])
            m = orient(m, np.repeat(exp, 2, axis=0).reshape(-1, 2, 3).transpose(1, 0, 2).reshape(-1, 3))
            parts.append(m.smooth_normals())
    return merge(parts)


# ================================================================== collision
def build_col_road(tr: Track):
    idx = np.r_[np.arange(0, tr.n, COL_STEP), 0]
    m = strip(tr.pos3(-HW)[idx], tr.pos3(HW)[idx], np.zeros(len(idx)))
    parts = [m]
    # kerbs as drivable surface (flat top at kerb height)
    for side, mask in ((1, tr.kerb_l), (-1, tr.kerb_r)):
        for r in runs(mask):
            r = r[::COL_STEP] if len(r) > 2 * COL_STEP else r
            if len(r) < 2:
                continue
            a = tr.pos3(side * HW, 0.0)[r]
            b = tr.pos3(side * (HW + KERB_WIDTH), 0.05)[r]
            parts.append(strip(a, b, np.zeros(len(r))))
    return merge([p.flat() for p in parts])


def build_col_barriers(tr: Track, height=4.0):
    bl, br = tr.barrier_offset()
    idx = np.r_[np.arange(0, tr.n, COL_STEP), 0]
    parts = []
    for side, b in ((1, bl), (-1, br)):
        out_dir = np.c_[tr.left[idx, 0], np.zeros(len(idx)), tr.left[idx, 1]] * side
        inner = tr.pos3(side * (b - 0.30))[idx]
        outer = tr.pos3(side * (b + 0.30))[idx]
        lo, hi = np.array([0, -1.0, 0]), np.array([0, height, 0])
        f_in = strip(inner + lo, inner + hi, np.zeros(len(idx)), up=False)
        f_out = strip(outer + lo, outer + hi, np.zeros(len(idx)), up=False)
        top = strip(inner + hi, outer + hi, np.zeros(len(idx)))
        e = np.repeat(out_dir[:-1], 2, axis=0).reshape(-1, 2, 3).transpose(1, 0, 2).reshape(-1, 3)
        parts += [orient(f_in, -e), orient(f_out, e), orient(top, np.array([0, 1.0, 0]))]
    return merge([p.flat() for p in parts])


def build_col_terrain(tr: Track):
    sh = shoulder_polys(tr, step=COL_STEP)
    return merge([p.flat() for p in sh["grass"] + sh["gravel"]])


# ==================================================================== terrain
class Terrain:
    def __init__(self, tr: Track):
        self.tr = tr
        self.tree = cKDTree(tr.xz)
        self.bl, self.br = tr.barrier_offset()
        hill_i = int(np.argmax(tr.y))
        self.hill_c = tr.xz[hill_i]
        r = np.random.default_rng(7)
        self.waves = [(r.uniform(0.004, 0.02), r.uniform(0, 6.28), r.uniform(0, 6.28), r.uniform(0.5, 2.0)) for _ in range(8)]

    def natural(self, q):
        x, z = q[:, 0], q[:, 1]
        h = np.zeros(len(q))
        for f, a, p, amp in self.waves:
            h += amp * np.sin(f * (x * math.cos(a) + z * math.sin(a)) + p)
        dh = np.linalg.norm(q - self.hill_c, axis=1)
        h += 8.5 * np.exp(-(dh / 170) ** 2)
        return h

    def info(self, q):
        d, i = self.tree.query(q)
        rel = q - self.tr.xz[i]
        lat = np.einsum("ij,ij->i", rel, self.tr.left[i])
        b = np.where(lat > 0, self.bl[i], self.br[i])
        return d, i, b

    def height(self, q):
        q = np.atleast_2d(q)
        d, i, b = self.info(q)
        e = self.tr.y[i]
        nat = self.natural(q) + 26 * _smooth(260, 650, d)
        inner = np.where(d < b - 1.0, e - 0.5, e - 0.5 + 0.44 * _smooth(b - 1.0, b + 0.3, d))
        w = _smooth(b + 0.3, b + 70, d)
        return inner * (1 - w) + nat * w

    def mesh(self):
        lo = self.tr.xz.min(axis=0) - TERRAIN_MARGIN
        hi = self.tr.xz.max(axis=0) + TERRAIN_MARGIN
        nx = int((hi[0] - lo[0]) / TERRAIN_SPACING) + 1
        nz = int((hi[1] - lo[1]) / TERRAIN_SPACING) + 1
        xs = lo[0] + np.arange(nx) * TERRAIN_SPACING
        zs = lo[1] + np.arange(nz) * TERRAIN_SPACING
        X, Z = np.meshgrid(xs, zs)
        q = np.c_[X.ravel(), Z.ravel()]
        H = self.height(q).reshape(nz, nx)
        P = np.dstack([X, H, Z])
        m = grid_surface(P)
        m = orient(m, np.array([0, 1.0, 0]))
        self.bounds = (float(xs[0]), float(zs[0]), float(xs[-1]), float(zs[-1]))
        return world_uv(m, TILE["grass"]).smooth_normals()


def _smooth(e0, e1, x):
    t = np.clip((x - e0) / np.maximum(e1 - e0, 1e-6), 0, 1)
    return t * t * (3 - 2 * t)


# ================================================================ prototypes
def col(rgb):
    return (*rgb, 1.0)


def proto_pine():
    trunk = cylinder(0.22, 2.2, 6).with_color(col((0.35, 0.24, 0.15)))
    tiers = []
    for y, r, h in ((1.4, 2.3, 3.6), (3.2, 1.8, 3.2), (4.9, 1.2, 2.9)):
        tiers.append(cone(r, h, 8).transformed(T(0, y, 0)))
    fol = merge(tiers).with_color(col((0.13, 0.32, 0.12)))
    return {"bark": trunk.flat(), "foliage": fol.flat()}


def proto_broadleaf():
    trunk = cylinder(0.28, 3.2, 6, r_top=0.18).with_color(col((0.38, 0.28, 0.18)))
    blobs = []
    for (x, y, z, r) in ((0, 4.6, 0, 2.4), (1.2, 4.0, 0.6, 1.7), (-0.9, 4.2, -0.8, 1.8)):
        s = icosphere(r, 1)
        jit = np.random.default_rng(int(r * 100)).uniform(0.88, 1.1, (len(s.pos), 1))
        s.pos = s.pos * jit
        blobs.append(s.transformed(T(x, y, z)))
    fol = merge(blobs).with_color(col((0.24, 0.48, 0.15)))
    return {"bark": trunk.flat(), "foliage": fol.flat()}


def proto_grandstand(length=64.0, rows=10):
    parts = []
    depth_row, rise = 1.1, 0.55
    seat_cols = [(0.85, 0.12, 0.10), (0.95, 0.95, 0.95), (0.10, 0.30, 0.75)]
    for i in range(rows):
        h = 1.2 + rise * i
        z = -rows * depth_row / 2 + depth_row * (i + 0.5)
        c = seat_cols[(i // 2) % 3]
        parts.append(box(length, h, depth_row, center=(0, h / 2, z)).with_color(col(c)))
    back_z = rows * depth_row / 2 + 0.2
    top = 1.2 + rise * rows
    parts.append(box(length, top + 3.2, 0.4, center=(0, (top + 3.2) / 2, back_z)).with_color(col((0.78, 0.78, 0.76))))
    for sx in (-1, 1):
        parts.append(box(0.4, top + 3.2, rows * depth_row + 0.8, center=(sx * (length / 2 + 0.2), (top + 3.2) / 2, 0.2))
                     .with_color(col((0.78, 0.78, 0.76))))
    parts.append(box(length, 1.1, 0.25, center=(0, 0.55, -rows * depth_row / 2 - 0.1)).with_color(col((0.7, 0.7, 0.7))))
    # cantilever roof
    roof = box(length + 2, 0.3, rows * depth_row + 3.0, center=(0, 0, 0)).transformed(
        chain(T(0, top + 3.3, -1.0), Rx(-0.08))).with_color(col((0.92, 0.92, 0.94)))
    parts.append(roof)
    for x in np.linspace(-length / 2, length / 2, 7):
        parts.append(box(0.35, top + 3.3, 0.35, center=(x, (top + 3.3) / 2, back_z - 0.5)).with_color(col((0.5, 0.5, 0.52))))
    return {"painted": merge(parts)}


def proto_building(w, h, d, roof_col=(0.45, 0.46, 0.48)):
    body = box(w, h, d, center=(0, h / 2, 0), uv_scale=1 / TILE["facade"])
    # remove the top/bottom face from the facade (roof is painted)
    a, b, c = (body.pos[body.idx[:, i]] for i in range(3))
    n = np.cross(b - a, c - a)
    keep = np.abs(normalize(n)[:, 1]) < 0.5
    body.idx = body.idx[keep]
    roof = box(w + 0.6, 0.5, d + 0.6, center=(0, h + 0.25, 0)).with_color(col(roof_col))
    unit = box(w * 0.25, 1.8, d * 0.3, center=(w * 0.15, h + 1.4, 0)).with_color(col((0.65, 0.66, 0.68)))
    return {"facade": body, "painted": merge([roof, unit])}


def billboard_face(w, h, y0, rect, z=-0.14):
    u0, v0, u1, v1 = rect
    # face normal -Z: the viewer stands at -Z, whose right-hand side is -X
    return quad((w / 2, y0 + h, z), (-w / 2, y0 + h, z), (-w / 2, y0, z), (w / 2, y0, z),
                [(u0, v0), (u1, v0), (u1, v1), (u0, v1)], (0, 0, -1))


def proto_billboard(rect, w=10.0, h=3.2, y0=3.0):
    frame = box(w + 0.3, h + 0.3, 0.25, center=(0, y0 + h / 2, 0)).with_color(col((0.2, 0.2, 0.22)))
    posts = [box(0.3, y0, 0.3, center=(sx * w * 0.33, y0 / 2, 0.1)).with_color(col((0.45, 0.45, 0.47))) for sx in (-1, 1)]
    return {"atlas": billboard_face(w, h, y0, rect), "painted": merge([frame] + posts)}


def proto_sign(rect, w, h, y0=0.6):
    frame = box(w + 0.1, h + 0.1, 0.12, center=(0, y0 + h / 2, 0.02)).with_color(col((0.25, 0.25, 0.25)))
    posts = [box(0.12, y0 + h * 0.5, 0.12, center=(sx * w * 0.3, (y0 + h * 0.5) / 2, 0.12)).with_color(col((0.5, 0.5, 0.5)))
             for sx in (-1, 1)]
    return {"atlas": billboard_face(w, h, y0, rect, z=-0.08), "painted": merge([frame] + posts)}


def proto_cone():
    base = box(0.42, 0.04, 0.42, center=(0, 0.02, 0)).with_color(col((0.1, 0.1, 0.1)))
    lower = cylinder(0.17, 0.2, 10, caps=False, r_top=0.12).transformed(T(0, 0.04, 0)).with_color(col((0.98, 0.42, 0.05)))
    band = cylinder(0.12, 0.09, 10, caps=False, r_top=0.095).transformed(T(0, 0.24, 0)).with_color(col((0.97, 0.97, 0.97)))
    top = cone(0.095, 0.2, 10, base=False).transformed(T(0, 0.33, 0)).with_color(col((0.98, 0.42, 0.05)))
    return {"painted": merge([base, lower, band, top]).flat()}


def proto_gantry(span):
    h = 7.5
    parts = [box(0.6, h + 0.8, 0.6, center=(sx * span / 2, (h + 0.8) / 2, 0)).with_color(col((0.85, 0.85, 0.87)))
             for sx in (-1, 1)]
    parts.append(box(span + 0.6, 0.8, 0.8, center=(0, h + 0.4, 0)).with_color(col((0.85, 0.85, 0.87))))
    parts.append(box(12.4, 2.7, 0.3, center=(0, h - 1.0, 0)).with_color(col((0.15, 0.15, 0.15))))
    rect = BB_UV["start_finish"]
    front = billboard_face(12.0, 2.5, h - 2.25, rect, z=-0.16)
    back = front.transformed(Ry(math.pi))
    return {"atlas": merge([front, back]), "painted": merge(parts)}


# ================================================================== placement
def frame_at(tr: Track, s):
    p, t, l = tr.sample(np.array([s]))
    return p[0], np.array([t[0, 0], 0, t[0, 1]]), np.array([l[0, 0], 0, l[0, 1]])


def scenery_layout(tr: Track, ter: Terrain):
    """Returns {proto_name: [ (pos(3), yaw, scale, tint) ... ]}"""
    L = tr.length
    bl, br = tr.barrier_offset()
    inst = {k: [] for k in ("tree_pine", "tree_broadleaf", "grandstand", "building_pits", "building_office",
                            "building_tower", "cone", "gantry", "sign_chevron", "sign_distance_300",
                            "sign_distance_200", "sign_distance_100")}
    for name in BB_UV:
        if name.startswith("brand_"):
            inst["billboard_" + name[6:]] = []
    footprints = []    # (centre xz, radius) to keep trees away from buildings

    def ground(x, z):
        return float(ter.height(np.array([[x, z]]))[0])

    def put(name, pos_xz, facing, scale=1.0, sink=0.0, radius=0.0, tint=None):
        y = ground(*pos_xz) - sink
        yaw = yaw_for_forward(facing[0], facing[2])
        inst[name].append((np.array([pos_xz[0], y, pos_xz[1]]), yaw, scale, tint))
        if radius:
            footprints.append((np.array(pos_xz), radius))

    def side_point(s, side, extra):
        p, t, l = frame_at(tr, s)
        i = int(round(s / DS)) % tr.n
        b = bl[i] if side > 0 else br[i]
        q = p + l * side * (b + extra)
        return np.array([q[0], q[2]]), t, l

    # grandstand opposite the pits on the main straight (right side = outside)
    for s in (-40.0, 30.0):
        q, t, l = side_point(s % L, -1, 14.0)
        put("grandstand", q, l, radius=40)        # its front (-Z) looks at the track (+left)
    # pit building + control tower on the infield (left side) of the straight
    q, t, l = side_point(0.0, 1, 15.0)
    put("building_pits", q, -l, radius=40)
    q, t, l = side_point(L - 70.0, 1, 18.0)
    put("building_tower", q, -l, radius=10)
    # offices: outside of the sweeper and beyond the final corner
    for s, side, extra in ((0.17 * L, -1, 45.0), (0.22 * L, -1, 50.0), (0.90 * L, -1, 50.0), (0.55 * L, -1, 55.0)):
        q, t, l = side_point(s, side, extra)
        put("building_office", q, -l * side, radius=22)
    # start/finish gantry
    p, t, l = frame_at(tr, 0.0)
    put("gantry", (p[0], p[2]), -t)
    inst["gantry"][-1] = (np.array([p[0], p[1], p[2]]), inst["gantry"][-1][1], 1.0, None)
    # billboards along straights / corner exits, outside barrier, angled toward oncoming cars
    brands = sorted(k for k in inst if k.startswith("billboard_"))
    bb_s = [0.06, 0.12, 0.30, 0.36, 0.47, 0.63, 0.68, 0.74, 0.80, 0.93]
    for k, f in enumerate(bb_s):
        s = f * L
        side = -1 if k % 3 else 1
        q, t, l = side_point(s, side, 4.0)
        facing = normalize(-t * 0.6 + (-l * side) * 0.8)
        put(brands[k % len(brands)], q, -facing, radius=6)
    # hairpin: distance boards before, chevrons on the outside
    hp = int(np.argmax(np.abs(tr.curvature) * (tr.curvature > 0)))
    s_hp = tr.s[hp]
    entry = s_hp - 35.0
    for dist, nm in ((300, "sign_distance_300"), (200, "sign_distance_200"), (100, "sign_distance_100")):
        s = entry - dist
        q, t, l = side_point(s, -1, -1.5)
        put(nm, q, t, radius=2)              # face (-Z local) points back at approaching cars
    for ds_ in (-30, -15, 0, 15, 30):
        s = s_hp + ds_
        q, t, l = side_point(s, -1, -1.4)
        put("sign_chevron", q, t * 0.3 + l * 0.95, radius=2)
    # cones: on the run-off just past the kerbs at the apexes of the tightest corners
    order = np.argsort(-np.abs(tr.curvature))
    apexes = []
    for i in order:
        if all(min(abs(i - a), tr.n - abs(i - a)) > 40 for a in apexes):
            apexes.append(i)
        if len(apexes) == 6:
            break
    for a in apexes:
        side = 1 if tr.curvature[a] > 0 else -1
        for k in range(-3, 4):
            s = tr.s[a] + k * 4.0
            p, t, l = frame_at(tr, s)
            q = p + l * side * (HW + KERB_WIDTH + 1.2)
            inst["cone"].append((np.array([q[0], p[1] - 0.03, q[2]]), float(RNG.uniform(0, 6.28)), 1.0, None))
    # trees: rejection sampling, denser near the circuit
    lo = tr.xz.min(axis=0) - TERRAIN_MARGIN + 30
    hi = tr.xz.max(axis=0) + TERRAIN_MARGIN - 30
    target, tries = 520, 0
    trees = []
    tree_pts = []
    while len(trees) < target and tries < 40000:
        tries += 1
        q = RNG.uniform(lo, hi)
        d, i, b = ter.info(q[None])
        d, b = float(d[0]), float(b[0])
        if d < b + 7.0:
            continue
        if RNG.random() > math.exp(-max(0.0, d - b - 15) / 160):
            continue
        if any(np.linalg.norm(q - c) < r + 4 for c, r in footprints):
            continue
        if tree_pts and np.min(np.linalg.norm(np.array(tree_pts) - q, axis=1)) < 6.0:
            continue
        kind = "tree_pine" if RNG.random() < 0.45 else "tree_broadleaf"
        tint = RNG.uniform(0.82, 1.15, 3) * np.array([1.0, 1.0, 0.9])
        put(kind, q, np.array([math.cos(RNG.uniform(0, 6.28)), 0, math.sin(RNG.uniform(0, 6.28))]),
            scale=float(RNG.uniform(0.8, 1.35)), sink=0.3, tint=tint)
        trees.append(q)
        tree_pts.append(q)
    return inst


# ================================================================= racing line
def racing_line(tr: Track, step=5.0, margin=1.6, iters=4000):
    n = int(round(tr.length / step))
    ss = np.linspace(0, tr.length, n, endpoint=False)
    c, t, l = tr.sample(ss)
    c2 = np.c_[c[:, 0], c[:, 2]]
    lim = HW - margin
    alpha = np.zeros(n)
    for it in range(iters):
        p = c2 + l * alpha[:, None]
        target = 0.5 * (np.roll(p, 1, axis=0) + np.roll(p, -1, axis=0))
        a_new = np.einsum("ij,ij->i", target - c2, l)
        alpha = np.clip(alpha + 0.6 * (a_new - alpha), -lim, lim)
    p = c2 + l * alpha[:, None]
    # curvature (Menger) and speed profile
    p0, p1, p2 = np.roll(p, 1, axis=0), p, np.roll(p, -1, axis=0)
    a = np.linalg.norm(p1 - p0, axis=1)
    b = np.linalg.norm(p2 - p1, axis=1)
    cc = np.linalg.norm(p2 - p0, axis=1)
    area2 = np.abs((p1 - p0)[:, 0] * (p2 - p0)[:, 1] - (p1 - p0)[:, 1] * (p2 - p0)[:, 0])
    kappa = 2 * area2 / np.maximum(a * b * cc, 1e-9)
    k5 = np.ones(5) / 5
    kappa = np.convolve(np.r_[kappa[-4:], kappa, kappa[:4]], k5, mode="same")[4:-4]
    v_max = 290 / 3.6
    a_lat = 13.5
    v = np.minimum(v_max, np.sqrt(a_lat / np.maximum(kappa, 1e-6)))
    seg = b
    for _ in range(3):                       # wrap-around passes for a closed loop
        for i in range(n):                   # acceleration limit
            j = (i + 1) % n
            acc = 2.0 + 7.0 * (1 - v[i] / v_max)
            v[j] = min(v[j], math.sqrt(v[i] ** 2 + 2 * acc * seg[i]))
        for i in range(n - 1, -1, -1):       # braking limit
            j = (i + 1) % n
            v[i] = min(v[i], math.sqrt(v[j] ** 2 + 2 * 15.0 * seg[i]))
    y = c[:, 1]
    pts = [{"x": round(float(p[i, 0]), 3), "y": round(float(y[i]), 3), "z": round(float(p[i, 1]), 3),
            "speed_kmh": round(float(v[i] * 3.6), 1)} for i in range(n)]
    return pts, alpha, ss


# ===================================================================== minimap
def minimap(tr: Track, path, size=1024, pad_px=48):
    bl, br = tr.barrier_offset()
    edge = np.vstack([tr.xz + tr.left * bl[:, None], tr.xz - tr.left * br[:, None]])
    lo, hi = edge.min(axis=0), edge.max(axis=0)
    span = (hi - lo).max()
    scale = (size - 2 * pad_px) / span                 # px per metre
    centre = (lo + hi) / 2
    off = np.array([size / 2, size / 2]) - centre * scale
    ss = 4
    img = Image.new("RGBA", (size * ss, size * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pts = [tuple((p * scale + off) * ss) for p in np.vstack([tr.xz, tr.xz[:1]])]
    w_road = ROAD_WIDTH * scale * ss
    d.line(pts, fill=(20, 22, 28, 235), width=int(w_road + 10 * ss), joint="curve")
    for p in pts[::4]:
        r = (w_road + 10 * ss) / 2
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=(20, 22, 28, 235))
    d.line(pts, fill=(255, 255, 255, 255), width=int(w_road), joint="curve")
    for p in pts[::4]:
        r = w_road / 2
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=(255, 255, 255, 255))
    # start/finish marker (red bar across the road) + direction arrow
    p0, t0, l0 = tr.sample(np.array([0.0]))
    c = np.array([p0[0, 0], p0[0, 2]])
    a = (c + l0[0] * (HW + 6)) * scale + off
    b = (c - l0[0] * (HW + 6)) * scale + off
    d.line([tuple(a * ss), tuple(b * ss)], fill=(230, 30, 30, 255), width=int(5 * ss))
    p1, t1, l1 = tr.sample(np.array([60.0]))
    tip = (np.array([p1[0, 0], p1[0, 2]]) + t1[0] * 22) * scale + off
    base = np.array([p1[0, 0], p1[0, 2]]) * scale + off
    nrm = np.array([-t1[0, 1], t1[0, 0]]) * 9
    d.polygon([tuple(tip * ss), tuple((base + nrm) * ss), tuple((base - nrm) * ss)], fill=(230, 30, 30, 255))
    img = img.resize((size, size), Image.LANCZOS)
    img.save(path, optimize=True)
    # world (x, z) -> pixel (u right, v down), origin top-left of the PNG
    return {
        "image_size_px": [size, size],
        "pixels_per_metre": scale,
        "world_to_map_matrix": [[scale, 0.0, float(off[0])], [0.0, scale, float(off[1])]],
        "formula": "u_px = x * pixels_per_metre + offset_px[0]; v_px = z * pixels_per_metre + offset_px[1] "
                   "(world -Z = north = image up)",
        "offset_px": [float(off[0]), float(off[1])],
        "world_bounds": {"min_x": float((0 - off[0]) / scale), "max_x": float((size - off[0]) / scale),
                         "min_z": float((0 - off[1]) / scale), "max_z": float((size - off[1]) / scale)},
    }


# ======================================================================= main
def main():
    OUT.mkdir(parents=True, exist_ok=True)
    tr = build_track()
    st = stats(tr)
    print(f"  track: length {st['length_m']:.0f} m, min radius {st['min_radius_m']:.1f} m, "
          f"elevation {st['elev_min']:.1f}..{st['elev_max']:.1f} m")
    ter = Terrain(tr)
    bl, br = tr.barrier_offset()

    # spawns: 2-wide staggered grid behind the line, pole on the left (inside of T1)
    spawns = []
    for k in range(4):
        s = -(8.0 + 7.0 * k)
        lat = 3.5 if k % 2 == 0 else -3.5
        p, t, l = frame_at(tr, s % tr.length)
        pos = p + l * lat
        yaw = yaw_for_forward(t[0], t[2])
        spawns.append({"name": f"spawn_{k + 1}", "s": s, "lateral": lat, "position": pos, "forward": t, "yaw": yaw})

    # checkpoints
    cps = []
    half_w = float(np.max(np.maximum(bl, br))) + 1.0
    for k in range(N_CHECKPOINTS):
        s = k * tr.length / N_CHECKPOINTS
        p, t, l = frame_at(tr, s)
        i = int(round(s / DS)) % tr.n
        w = float(bl[i] + br[i] + 2.0)
        centre_off = float((bl[i] - br[i]) / 2)       # shift box centre so it spans barrier to barrier
        cps.append({"name": f"cp_{k:02d}", "s": s, "position": p + l * centre_off, "forward": t,
                    "yaw": yaw_for_forward(t[0], t[2]), "size": [w, 8.0, 6.0]})

    road = build_road(tr)
    paint = build_paint(tr, spawns)
    kerbs = build_kerbs(tr)
    sh = shoulder_polys(tr)
    terrain_grid = ter.mesh()
    grass = merge([terrain_grid] + [world_uv(m, TILE["grass"]).smooth_normals() for m in sh["grass"]])
    gravel = merge([world_uv(m, TILE["gravel"]).smooth_normals() for m in sh["gravel"]])
    barriers = build_barriers(tr)
    col_road = build_col_road(tr)
    col_barriers = build_col_barriers(tr)
    col_terrain = build_col_terrain(tr)

    # ---- scenery
    gantry_span = float(bl[0] + br[0] + 2.0)
    protos = {
        "tree_pine": proto_pine(), "tree_broadleaf": proto_broadleaf(), "grandstand": proto_grandstand(),
        "building_pits": proto_building(72, 7, 12, (0.85, 0.15, 0.12)), "building_office": proto_building(24, 15, 16),
        "building_tower": proto_building(9, 24, 9, (0.2, 0.2, 0.22)), "cone": proto_cone(),
        "gantry": proto_gantry(gantry_span),
        "sign_chevron": proto_sign(BB_UV["chevron_left"], 3.0, 1.5),
        "sign_distance_300": proto_sign(BB_UV["distance_300"], 1.2, 1.8),
        "sign_distance_200": proto_sign(BB_UV["distance_200"], 1.2, 1.8),
        "sign_distance_100": proto_sign(BB_UV["distance_100"], 1.2, 1.8),
    }
    for name, rect in BB_UV.items():
        if name.startswith("brand_"):
            protos["billboard_" + name[6:]] = proto_billboard(rect)
    layout = scenery_layout(tr, ter)
    groups = {
        "scenery_trees": ["tree_pine", "tree_broadleaf"],
        "scenery_grandstand": ["grandstand"],
        "scenery_buildings": ["building_pits", "building_office", "building_tower"],
        "scenery_billboards": [k for k in protos if k.startswith("billboard_")],
        "scenery_signs": [k for k in protos if k.startswith("sign_")],
        "scenery_gantry": ["gantry"],
        "scenery_cones": ["cone"],
    }
    baked = {}
    for gname, members in groups.items():
        by_mat = {}
        for pn in members:
            for (pos, yaw, scale, tint) in layout[pn]:
                for mat, mesh in protos[pn].items():
                    m = place(mesh, pos, yaw, scale)
                    if tint is not None and m.col is not None:
                        m.col = m.col * np.r_[tint, 1.0][None, :]
                    by_mat.setdefault(mat, []).append(m)
        baked[gname] = {mat: merge(ms) for mat, ms in by_mat.items()}

    # ---- racing line + minimap
    rl, alpha, rl_s = racing_line(tr)
    (OUT / "racing_line.json").write_text(json.dumps(rl, separators=(",", ":")))
    mm = minimap(tr, OUT / "minimap_1024.png")

    # ---- write track.glb
    g = GLB("race-assets build_track.py", glb_dir=OUT)
    M = {}

    def tex_mat(name, key, rough=1.0, normal_scale=1.0, base=(1, 1, 1, 1)):
        return g.material(name, base=base, metallic=1.0, roughness=rough, base_tex=TEX / f"{key}_albedo.png",
                          normal_tex=TEX / f"{key}_normal.png", normal_scale=normal_scale, orm_tex=TEX / f"{key}_orm.png")
    M["asphalt"] = tex_mat("asphalt", "asphalt")
    M["paint"] = g.material("road_paint", base=(0.92, 0.92, 0.90, 1), roughness=0.55)
    M["kerb"] = tex_mat("kerb", "kerb")
    M["grass"] = tex_mat("grass", "grass")
    M["gravel"] = tex_mat("gravel", "gravel")
    M["barrier"] = tex_mat("barrier_concrete", "barrier")
    M["facade"] = tex_mat("building_facade", "facade")
    M["atlas"] = g.material("billboard_atlas", base=(1, 1, 1, 1), roughness=0.5, base_tex=TEX / "billboards_albedo.png")
    M["painted"] = g.material("painted_vertex_color", base=(1, 1, 1, 1), roughness=0.65,
                              extras={"note": "colour comes from COLOR_0"})
    M["bark"] = g.material("tree_bark", base=(1, 1, 1, 1), roughness=0.9)
    M["foliage"] = g.material("tree_foliage", base=(1, 1, 1, 1), roughness=0.8)
    M["collider"] = g.material("collider_invisible", base=(1, 0, 1, 0), roughness=1, alpha_mode="MASK",
                               extras={"note": "fully transparent + alpha MASK: never visible even if an engine "
                                               "ignores KHR_node_visibility"})
    vis = {
        "road": g.mesh("road", [(road, M["asphalt"]), (paint, M["paint"])]),
        "kerbs": g.mesh("kerbs", [(kerbs, M["kerb"])]),
        "barriers": g.mesh("barriers", [(barriers, M["barrier"])]),
        "terrain": g.mesh("terrain", [(grass, M["grass"])] + ([(gravel, M["gravel"])] if gravel else [])),
    }
    for gname, mats in baked.items():
        vis[gname] = g.mesh(gname, [(m, M[k]) for k, m in mats.items()])
    hidden = {"KHR_node_visibility": {"visible": False}}
    col_nodes = {
        "col_road": (col_road, {"surface": "asphalt", "suggested_friction": 1.0}),
        "col_barriers": (col_barriers, {"surface": "wall", "suggested_friction": 0.3, "height_m": 4.0}),
        "col_terrain": (col_terrain, {"surface": "offroad", "suggested_friction": 0.55, "rolling_drag": 3.0}),
    }
    children = [g.node(k, v) for k, v in vis.items()]
    for k, (m, ex) in col_nodes.items():
        children.append(g.node(k, g.mesh(k, [(m, M["collider"])]), extras={"collider": True, "visible": False, **ex},
                               extensions=hidden))
    for sp in spawns:
        children.append(g.node(sp["name"], translation=sp["position"], rotation=quat_from_yaw(sp["yaw"]),
                               extras={"empty": True, "forward": [float(v) for v in sp["forward"]]}))
    for cp in cps:
        children.append(g.node(cp["name"], translation=cp["position"], rotation=quat_from_yaw(cp["yaw"]),
                               extras={"empty": True, "trigger_box_size": cp["size"],
                                       "trigger_box_center_local": [0, cp["size"][1] / 2, 0]}))
    root = g.node("track", children=children, extras={"length_m": tr.length, "race_direction": "counter-clockwise from above"})
    g.scene("track", [root])
    size = g.write(OUT / "track.glb")

    # ---- write scenery.glb (prototypes)
    gs = GLB("race-assets build_track.py (scenery prototypes)", glb_dir=OUT)
    SM = {
        "facade": gs.material("building_facade", base=(1, 1, 1, 1), metallic=1.0, roughness=1.0,
                              base_tex=TEX / "facade_albedo.png", normal_tex=TEX / "facade_normal.png",
                              orm_tex=TEX / "facade_orm.png"),
        "atlas": gs.material("billboard_atlas", base=(1, 1, 1, 1), roughness=0.5, base_tex=TEX / "billboards_albedo.png"),
        "painted": gs.material("painted_vertex_color", base=(1, 1, 1, 1), roughness=0.65),
        "bark": gs.material("tree_bark", base=(1, 1, 1, 1), roughness=0.9),
        "foliage": gs.material("tree_foliage", base=(1, 1, 1, 1), roughness=0.8),
    }
    proto_nodes = []
    proto_tris = {}
    for pn, mats in protos.items():
        mi = gs.mesh(pn, [(m, SM[k]) for k, m in mats.items()])
        proto_nodes.append(gs.node(f"proto_{pn}", mi, extras={"prototype": pn, "front": [0, 0, -1]}))
        proto_tris[pn] = sum(m.tri_count for m in mats.values())
    gs.scene("scenery_prototypes", proto_nodes)
    s_size = gs.write(OUT / "scenery.glb")

    # ---- metadata for the manifest + verifier
    def tri(m):
        return int(m.tri_count)
    vis_tris = {"road": tri(road) + tri(paint), "kerbs": tri(kerbs), "barriers": tri(barriers),
                "terrain": tri(grass) + (tri(gravel) if gravel else 0)}
    for gname, mats in baked.items():
        vis_tris[gname] = sum(tri(m) for m in mats.values())
    col_tris = {k: tri(v[0]) for k, v in col_nodes.items()}
    draw_calls = sum(len(g.j["meshes"][mi]["primitives"]) for mi in vis.values())
    vis_materials = sorted({g.j["materials"][p["material"]]["name"] for mi in vis.values()
                            for p in g.j["meshes"][mi]["primitives"]})
    instances = {}
    for pn, lst in layout.items():
        instances[pn] = [{"translation": [round(float(v), 3) for v in pos],
                          "rotation": [round(float(v), 6) for v in quat_from_yaw(yaw)],
                          "scale": [round(float(scale), 3)] * 3,
                          **({"color_tint": [round(float(v), 3) for v in tint]} if tint is not None else {})}
                         for (pos, yaw, scale, tint) in lst]
    meta = {
        "file": "track/track.glb", "bytes": size, "scenery_file": "track/scenery.glb", "scenery_bytes": s_size,
        "length_m": tr.length, "stats": st, "corners": corners(tr),
        "hill": {"s_start": float(tr.s[tr.y > 1][0]), "s_end": float(tr.s[tr.y > 1][-1]),
                 "s_crest": float(tr.s[np.argmax(tr.y)]), "crest_elevation_m": float(tr.y.max()),
                 "lowest_elevation_m": float(tr.y.min())}, "road_width_m": ROAD_WIDTH, "kerb_width_m": KERB_WIDTH,
        "barrier_height_visual_m": 1.0, "barrier_height_collision_m": 4.0,
        "visual_triangles": vis_tris, "collision_triangles": col_tris,
        "visual_triangles_total": sum(vis_tris.values()), "collision_triangles_total": sum(col_tris.values()),
        "draw_calls_static_visual": draw_calls, "unique_visual_materials": vis_materials,
        "spawns": [{"name": sp["name"], "position": [float(v) for v in sp["position"]],
                    "rotation": quat_from_yaw(sp["yaw"]), "yaw_deg": math.degrees(sp["yaw"]),
                    "forward": [float(v) for v in sp["forward"]], "distance_behind_line_m": -sp["s"],
                    "lateral_offset_m": sp["lateral"]} for sp in spawns],
        "checkpoints": [{"name": cp["name"], "index": k, "distance_along_track_m": cp["s"],
                         "position": [float(v) for v in cp["position"]], "rotation": quat_from_yaw(cp["yaw"]),
                         "yaw_deg": math.degrees(cp["yaw"]), "forward": [float(v) for v in cp["forward"]],
                         "box_size": cp["size"], "box_center_local": [0, cp["size"][1] / 2, 0]}
                        for k, cp in enumerate(cps)],
        "racing_line": {"file": "track/racing_line.json", "points": len(rl), "closed": True,
                        "spacing_m": tr.length / len(rl),
                        "min_speed_kmh": min(p["speed_kmh"] for p in rl), "max_speed_kmh": max(p["speed_kmh"] for p in rl)},
        "minimap": {"file": "track/minimap_1024.png", **mm},
        "terrain_bounds": ter.bounds,
        "prototype_triangles": proto_tris,
        "instances": instances,
        "scenery_groups": groups,
        "billboard_uv_rects": BB_UV,
    }
    (BUILD / "track_meta.json").write_text(json.dumps(meta, indent=1))
    print(f"  track.glb: {size / 1e6:.1f} MB, visual tris {meta['visual_triangles_total']}, "
          f"collision tris {meta['collision_triangles_total']}, draw calls {draw_calls}")
    print(f"  scenery.glb: {s_size / 1e3:.0f} kB, {len(protos)} prototypes, "
          f"{sum(len(v) for v in instances.values())} instances")
    print(f"  racing line: {len(rl)} pts, {meta['racing_line']['min_speed_kmh']}..{meta['racing_line']['max_speed_kmh']} km/h")


if __name__ == "__main__":
    main()
