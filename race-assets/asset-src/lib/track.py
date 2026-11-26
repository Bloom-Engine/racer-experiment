"""Circuit definition: centreline, elevation, widths, run-off, kerbs.

Everything here is pure maths (numpy) so the track builder, minimap,
racing-line solver and the verifier all share one source of truth.

World axes (glTF): +X east, +Y up, -Z north. Race direction is counter-clockwise
seen from above.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

ROAD_WIDTH = 14.0          # metres, edge to edge
KERB_WIDTH = 1.2
DS = 2.0                   # centreline sample spacing (m)

# Control points in map coordinates (x east, y north), metres. Race direction
# follows the list order. Annotated with the corner they shape.
CONTROL = [
    (-260, 0),      # start/finish straight (west part)
    (0, 0),
    (260, 0),       # end of main straight (~700 m incl. run from final corner)
    (380, 18),      # T1 fast sweeper (left, R ~ 200 m)
    (470, 90),
    (520, 200),
    (535, 300),     # short straight north
    (540, 390),
    (534, 452),     # T2 hairpin (left, ~180 deg)
    (497, 484),
    (459, 460),
    (455, 410),     # back south out of the hairpin
    (446, 350),
    (410, 300),     # T3 right-hander onto the back section
    (340, 284),
    (270, 300),     # T4-T7 S-section
    (205, 336),
    (140, 330),
    (80, 290),
    (10, 285),
    (-80, 315),     # back straight over the hill (crest ~ +10 m)
    (-220, 320),
    (-360, 300),
    (-450, 255),    # T8 final double-apex left
    (-500, 175),
    (-490, 85),
    (-430, 20),
    (-360, 2),
]

START_S_FRACTION_X = 40.0   # start/finish line sits at map x = 40*SCALE on the main straight
SCALE = 0.8                 # uniform layout scale applied to CONTROL


def _catmull_rom_closed(P, samples_per_seg=60, alpha=0.5):
    """Centripetal Catmull-Rom through closed control polygon P (N,2)."""
    n = len(P)
    out = []
    for i in range(n):
        p0, p1, p2, p3 = P[(i - 1) % n], P[i], P[(i + 1) % n], P[(i + 2) % n]

        def tj(ti, a, b):
            return ti + max(np.linalg.norm(b - a), 1e-6) ** alpha
        t0 = 0.0
        t1 = tj(t0, p0, p1)
        t2 = tj(t1, p1, p2)
        t3 = tj(t2, p2, p3)
        t = np.linspace(t1, t2, samples_per_seg, endpoint=False)[:, None]
        a1 = (t1 - t) / (t1 - t0) * p0 + (t - t0) / (t1 - t0) * p1
        a2 = (t2 - t) / (t2 - t1) * p1 + (t - t1) / (t2 - t1) * p2
        a3 = (t3 - t) / (t3 - t2) * p2 + (t - t2) / (t3 - t2) * p3
        b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2
        b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3
        c = (t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2
        out.append(c)
    return np.vstack(out)


def _resample_closed(poly, ds):
    seg = np.linalg.norm(np.diff(np.vstack([poly, poly[:1]]), axis=0), axis=1)
    s = np.r_[0, np.cumsum(seg)]
    L = s[-1]
    n = int(round(L / ds))
    st = np.linspace(0, L, n, endpoint=False)
    closed = np.vstack([poly, poly[:1]])
    x = np.interp(st, s, closed[:, 0])
    y = np.interp(st, s, closed[:, 1])
    return np.c_[x, y], L


def _smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


@dataclass
class Track:
    xz: np.ndarray        # (N,2) centreline in world x,z
    y: np.ndarray         # (N,) elevation
    s: np.ndarray         # (N,) arc length from start line
    length: float
    tangent: np.ndarray   # (N,2) unit, world x,z
    left: np.ndarray      # (N,2) unit, pointing to driver's left
    curvature: np.ndarray  # (N,) signed, + = turning left
    shoulder_l: np.ndarray  # run-off width beyond road edge (m)
    shoulder_r: np.ndarray
    gravel_l: np.ndarray   # bool: run-off is gravel
    gravel_r: np.ndarray
    kerb_l: np.ndarray     # bool
    kerb_r: np.ndarray

    @property
    def n(self):
        return len(self.s)

    def pos3(self, offset=0.0, dy=0.0):
        """Points offset laterally (+ = left) from the centreline, (N,3)."""
        p = self.xz + self.left * np.asarray(offset).reshape(-1, 1)
        return np.c_[p[:, 0], self.y + dy, p[:, 1]]

    def barrier_offset(self):
        hw = ROAD_WIDTH / 2
        return hw + self.shoulder_l, hw + self.shoulder_r

    def sample(self, s_query):
        """Interpolate position/tangent at arbitrary arc length (wraps)."""
        s_query = np.mod(s_query, self.length)
        sx = np.r_[self.s, self.length]
        X = np.interp(s_query, sx, np.r_[self.xz[:, 0], self.xz[0, 0]])
        Z = np.interp(s_query, sx, np.r_[self.xz[:, 1], self.xz[0, 1]])
        Y = np.interp(s_query, sx, np.r_[self.y, self.y[0]])
        i = (np.searchsorted(sx, s_query, side="right") - 1) % self.n
        return np.c_[X, Y, Z], self.tangent[i], self.left[i]


def elevation(s, L):
    """Hill over the back straight: up to +10 m, plus a gentle -3 m dip around the sweeper."""
    def bump(c, w, h):
        d = np.abs(((s - c + L / 2) % L) - L / 2)
        return h * 0.5 * (1 + np.cos(np.pi * np.clip(d / w, 0, 1)))
    return bump(0.70 * L, 0.11 * L, 10.0) + bump(0.20 * L, 0.07 * L, -3.0)


def build_track() -> Track:
    P = np.array(CONTROL, float) * SCALE
    dense = _catmull_rom_closed(P, 80)
    pts, L = _resample_closed(dense, DS)
    # map (x, north) -> world (x, z=-north)
    xz = np.c_[pts[:, 0], -pts[:, 1]]
    # rotate so index 0 is the start/finish line (on the main straight, map y ~ 0, x = START)
    cand = np.where(np.abs(pts[:, 1]) < 5)[0]
    i0 = cand[np.argmin(np.abs(pts[cand, 0] - START_S_FRACTION_X * SCALE))]
    xz = np.roll(xz, -i0, axis=0)
    n = len(xz)
    L = float(np.sum(np.linalg.norm(np.diff(np.vstack([xz, xz[:1]]), axis=0), axis=1)))
    # re-sample exactly uniform after the roll
    seg = np.linalg.norm(np.diff(np.vstack([xz, xz[:1]]), axis=0), axis=1)
    s = np.r_[0, np.cumsum(seg)[:-1]]

    tan = np.roll(xz, -1, axis=0) - np.roll(xz, 1, axis=0)
    tan /= np.linalg.norm(tan, axis=1, keepdims=True)
    # left of travel direction in x,z (Y up): rotate tangent by +90deg about Y
    # forward (tx, tz): left = (tz, -tx)
    left = np.c_[tan[:, 1], -tan[:, 0]]
    # signed curvature from heading change
    heading = np.unwrap(np.arctan2(tan[:, 1], tan[:, 0]))
    dh = np.gradient(heading) / DS
    # in x,z with z south, a left turn (CCW from above) decreases atan2(z, x)
    curv = -dh
    k = np.ones(9) / 9
    curv = np.convolve(np.r_[curv[-8:], curv, curv[:8]], k, mode="same")[8:-8]

    y = elevation(s, L)

    # run-off: wider on the outside of fast/hard corners, gravel on the outside of T1/T2/T8
    kabs = np.abs(curv)
    base = 6.0
    outside_extra = np.clip(kabs * 900, 0, 14)          # up to +14 m at tight corners
    shoulder_l = np.full(n, base)
    shoulder_r = np.full(n, base)
    shoulder_l += np.where(curv < 0, outside_extra, 0)   # turning right -> outside is left
    shoulder_r += np.where(curv > 0, outside_extra, 0)
    shoulder_l = _smooth_closed(shoulder_l, 25)
    shoulder_r = _smooth_closed(shoulder_r, 25)
    gravel_l = (shoulder_l > base + 4.0)
    gravel_r = (shoulder_r > base + 4.0)
    kerb = _smooth_closed((kabs > 1 / 320).astype(float), 7) > 0.3
    tr = Track(xz, y, s, L, tan, left, curv, shoulder_l, shoulder_r, gravel_l, gravel_r, kerb, kerb.copy())
    _limit_inner_offsets(tr)
    return tr


def _smooth_closed(a, w):
    k = np.ones(w) / w
    return np.convolve(np.r_[a[-w:], a, a[:w]], k, mode="same")[w:-w]


def _limit_inner_offsets(tr: Track):
    """Clamp shoulders on the inside of tight corners so offset curves never fold,
    and so neighbouring stretches of track never overlap."""
    hw = ROAD_WIDTH / 2
    R = 1 / np.maximum(np.abs(tr.curvature), 1e-6)
    lim = np.maximum(R * 0.8 - hw, 2.0)
    inside_left = tr.curvature > 0
    tr.shoulder_l = np.where(inside_left, np.minimum(tr.shoulder_l, lim), tr.shoulder_l)
    tr.shoulder_r = np.where(~inside_left, np.minimum(tr.shoulder_r, lim), tr.shoulder_r)
    tr.shoulder_l = _smooth_min_closed(tr.shoulder_l, 9)
    tr.shoulder_r = _smooth_min_closed(tr.shoulder_r, 9)


def _smooth_min_closed(a, w):
    from scipy.ndimage import minimum_filter1d
    m = minimum_filter1d(a, size=w, mode="wrap")
    return _smooth_closed(m, w)


def stats(tr: Track):
    R = 1 / np.maximum(np.abs(tr.curvature), 1e-9)
    return {
        "length_m": tr.length,
        "min_radius_m": float(R.min()),
        "elev_min": float(tr.y.min()), "elev_max": float(tr.y.max()),
        "max_grade_pct": float(np.max(np.abs(np.gradient(tr.y) / DS)) * 100),
    }


def corners(tr: Track, k_min=1 / 450):
    """Detect corners (contiguous |curvature| > k_min, same sign) and classify them."""
    k = tr.curvature
    on = np.abs(k) > k_min
    sign = np.sign(k)
    n = tr.n
    # start scanning at a straight sample
    start = int(np.argmin(np.abs(k)))
    segs, cur = [], None
    for j in range(n):
        i = (start + j) % n
        if on[i]:
            if cur is not None and sign[i] == cur["sign"]:
                cur["idx"].append(i)
            else:
                if cur:
                    segs.append(cur)
                cur = {"sign": sign[i], "idx": [i]}
        elif cur:
            segs.append(cur)
            cur = None
    if cur:
        segs.append(cur)
    out = []
    for sg in segs:
        idx = np.array(sg["idx"])
        if len(idx) < 4:
            continue
        angle = float(np.degrees(np.abs(k[idx]).sum() * DS))
        if angle < 12:
            continue
        rmin = float(1 / np.abs(k[idx]).max())
        out.append({"s_start": float(tr.s[idx[0]]), "s_end": float(tr.s[idx[-1]]), "s_apex": float(tr.s[idx[np.argmax(np.abs(k[idx]))]]),
                    "direction": "left" if sg["sign"] > 0 else "right", "angle_deg": angle, "min_radius_m": rmin})
    out.sort(key=lambda c: c["s_start"])
    for c in out:
        if c["angle_deg"] > 150 and c["min_radius_m"] < 40:
            c["type"] = "hairpin"
        elif c["min_radius_m"] > 120 and c["angle_deg"] > 45:
            c["type"] = "fast_sweeper"
        else:
            c["type"] = "corner"
    # S-section: >= 2 consecutive corners of alternating direction within 60 m
    for a, b in zip(out, out[1:]):
        if a["direction"] != b["direction"] and b["s_start"] - a["s_end"] < 60 and a["type"] == b["type"] == "corner":
            a["s_section"] = b["s_section"] = True
    return out
