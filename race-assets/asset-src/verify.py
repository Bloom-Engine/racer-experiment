#!/usr/bin/env python3
"""Asset verification: geometry/gameplay checks + budgets. Prints a report and
writes assets/reports/verify_report.{txt,json}. Exit code 1 if anything fails.

Checks (reads only the exported files, not the generator internals):
  * racing line: >= 200 points, closed, every point lies on col_road
  * checkpoints: >= 12, in race order along the racing line, cp_00 at the line
  * spawns: on col_road (origin and all four wheel contact points), facing race direction
  * triangle budgets (car <= 25k incl. wheels, collider <= 200, track scene <= 300k),
    static draw calls <= 40
  * required node names, colliders hidden, car conventions (origin, -Z forward, wheels)
  * textures power-of-two <= 2048, sky/minimap sizes, audio format + loop seams
  * every file listed in the manifest exists with matching sha256; glTF validator 0 errors
"""
from __future__ import annotations

import hashlib
import json
import sys
import wave
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).parent))
from lib.gltf import accessor_array, node_world_meshes, read_glb

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / "assets"
results = []


def check(name, ok, detail=""):
    results.append({"check": name, "ok": bool(ok), "detail": detail})


# ---------------------------------------------------------------- glb utils
def load_scene(path):
    js, binb = read_glb(path)
    nodes = {}
    for ni, n, w in node_world_meshes(js, binb):
        entry = {"node": n, "world": w, "prims": []}
        if "mesh" in n:
            for p in js["meshes"][n["mesh"]]["primitives"]:
                pos = accessor_array(js, binb, p["attributes"]["POSITION"]).astype(np.float64)
                idx = accessor_array(js, binb, p["indices"]).astype(np.int64).reshape(-1, 3)
                pw = (np.c_[pos, np.ones(len(pos))] @ w.T)[:, :3]
                mat = js["materials"][p["material"]] if "material" in p else None
                entry["prims"].append({"pos": pw, "idx": idx, "material": mat, "local": pos})
        nodes[n["name"]] = entry
    return js, nodes


def tri_count(entry):
    return sum(len(p["idx"]) for p in entry["prims"])


class Surface:
    """Vertical ray casts against a triangle soup."""

    def __init__(self, prims):
        tris = np.concatenate([p["pos"][p["idx"]] for p in prims])
        self.t = tris
        self.cent = tris[:, :, [0, 2]].mean(axis=1)
        self.rad = np.linalg.norm(tris[:, :, [0, 2]] - self.cent[:, None, :], axis=2).max()
        self.tree = cKDTree(self.cent)

    def height(self, x, z):
        cand = self.tree.query_ball_point([x, z], self.rad + 1e-3)
        best = None
        for c in cand:
            a, b, d = self.t[c]
            v0 = b[[0, 2]] - a[[0, 2]]
            v1 = d[[0, 2]] - a[[0, 2]]
            v2 = np.array([x, z]) - a[[0, 2]]
            den = v0[0] * v1[1] - v1[0] * v0[1]
            if abs(den) < 1e-12:
                continue
            u = (v2[0] * v1[1] - v1[0] * v2[1]) / den
            v = (v0[0] * v2[1] - v2[0] * v0[1]) / den
            if u >= -1e-6 and v >= -1e-6 and u + v <= 1 + 1e-6:
                y = a[1] + u * (b[1] - a[1]) + v * (d[1] - a[1])
                best = y if best is None else max(best, y)
        return best


def yaw_rotate(q, v):
    x, y, z, w = q
    R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                  [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                  [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    return R @ np.asarray(v, float)


def is_hidden(entry):
    n = entry["node"]
    vis = n.get("extensions", {}).get("KHR_node_visibility", {}).get("visible", True) is False
    mats = [p["material"] for p in entry["prims"]]
    invisible = all(m and m.get("alphaMode") == "MASK" and m["pbrMetallicRoughness"]["baseColorFactor"][3] == 0 for m in mats)
    return vis and invisible and n.get("extras", {}).get("collider") is True


def main():
    man = json.loads((A / "manifest.json").read_text())

    # ------------------------------------------------------------ validator
    vr = A / "reports" / "validation.json"
    if vr.exists():
        v = json.loads(vr.read_text())
        errs = {k: e["errors"] for k, e in v["gltf"].items()}
        check("Khronos glTF validator: 0 errors in every .glb", all(e == 0 for e in errs.values()) and len(errs) >= 3,
              ", ".join(f"{k}: {e} errors / {v['gltf'][k]['warnings']} warnings" for k, e in errs.items()))
        check("manifest.json validates against manifest.schema.json", v["manifest"]["valid"])
    else:
        check("Khronos glTF validator report present", False, "run node asset-src/validate.mjs first")

    # ------------------------------------------------------------------ car
    cj, car = load_scene(A / man["car"]["file"])
    required = ["car", "body", "wheel_FL", "wheel_FR", "wheel_RL", "wheel_RR", "brake_lights", "exhaust_L", "exhaust_R", "collider_body"]
    missing = [n for n in required if n not in car]
    check("car: required nodes present", not missing, f"missing {missing}" if missing else ", ".join(required))
    vis_tris = sum(tri_count(e) for k, e in car.items() if k != "collider_body")
    check("car: <= 25,000 triangles incl. wheels", vis_tris <= 25000, f"{vis_tris} triangles")
    ctris = tri_count(car["collider_body"])
    check("car: collider_body <= 200 triangles", ctris <= 200, f"{ctris} triangles")
    cp = car["collider_body"]["prims"][0]
    P = cp["pos"]
    tri = P[cp["idx"]]
    nrm = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    off = np.einsum("ij,kj->ik", nrm, P) - np.einsum("ij,ij->i", nrm, tri[:, 0])[:, None]
    check("car: collider_body is a closed convex hull", (off <= 1e-4).all(), "all vertices behind every face plane")
    check("car: collider hidden (KHR_node_visibility + invisible MASK material)", is_hidden(car["collider_body"]))
    m = man["car"]["metrics"]
    wpos = {k: car[k]["world"][:3, 3] for k in ("wheel_FL", "wheel_FR", "wheel_RL", "wheel_RR")}
    wb = wpos["wheel_RL"][2] - wpos["wheel_FL"][2]
    tw = wpos["wheel_FR"][0] - wpos["wheel_FL"][0]
    check("car: wheelbase / track width match manifest", abs(wb - m["wheelbase_m"]) < 1e-3 and abs(tw - m["track_width_m"]) < 1e-3,
          f"wheelbase {wb:.3f} m, track {tw:.3f} m")
    centre_z = np.mean([p[2] for p in wpos.values()])
    tyre = car["wheel_FL"]["prims"][0]["local"]
    r = np.linalg.norm(tyre[:, 1:], axis=1).max()
    width = np.ptp(tyre[:, 0])
    ground = min(e["prims"][0]["pos"][:, 1].min() for k, e in car.items() if k.startswith("wheel_"))
    check("car: origin at ground level & wheelbase centre", abs(ground) < 0.005 and abs(centre_z) < 1e-6,
          f"lowest tyre point y={ground:.4f}, wheel centre z={centre_z:.4f}")
    check("car: wheel radius / width match manifest", abs(r - m["wheel_radius_m"]) < 0.005 and abs(width - m["wheel_width_m"]) < 0.01,
          f"radius {r:.3f} m, width {width:.3f} m")
    check("car: wheel origins at rotation centre", all(abs(p[1] - m["wheel_radius_m"]) < 1e-6 for p in wpos.values()))
    head = [p for p in car["body"]["prims"] if p["material"]["name"] == "car_headlight"][0]["pos"][:, 2].mean()
    tail = car["brake_lights"]["prims"][0]["pos"][:, 2].mean()
    check("car: faces -Z (headlights at -Z, brake lights at +Z)", head < -1.5 and tail > 1.5, f"headlights z={head:.2f}, brake lights z={tail:.2f}")
    ext = cj.get("extensions", {}).get("KHR_materials_variants", {}).get("variants", [])
    check("car: 4 colour variants (KHR_materials_variants)", [x["name"] for x in ext] == ["red", "blue", "yellow", "black"],
          ", ".join(x["name"] for x in ext))
    check("car: brake_lights use their own material", car["brake_lights"]["prims"][0]["material"]["name"] == "car_brake_light")

    # ---------------------------------------------------------------- track
    tj, trk = load_scene(A / man["track"]["file"])
    req = ["road", "kerbs", "barriers", "terrain", "col_road", "col_barriers", "col_terrain"] + [f"spawn_{i}" for i in range(1, 5)]
    cps = sorted(k for k in trk if k.startswith("cp_"))
    missing = [n for n in req if n not in trk]
    scen = [k for k in trk if k.startswith("scenery_")]
    check("track: required nodes present", not missing and scen, f"missing {missing}" if missing else f"{len(req)} required + {len(scen)} scenery_* nodes")
    check("track: collision nodes hidden", all(is_hidden(trk[k]) for k in ("col_road", "col_barriers", "col_terrain")))
    total = sum(tri_count(e) for e in trk.values())
    visual = sum(tri_count(e) for k, e in trk.items() if not k.startswith("col_"))
    check("track: whole scene <= 300,000 triangles", total <= 300000, f"{total} total ({visual} visual + {total - visual} collision)")
    draws = sum(len(e["prims"]) for k, e in trk.items() if not k.startswith("col_"))
    mats = {p["material"]["name"] for k, e in trk.items() if not k.startswith("col_") for p in e["prims"]}
    check("track: static scene <= 40 draw calls", draws <= 40, f"{draws} primitives, {len(mats)} unique materials")
    L = man["track"]["length_m"]
    check("track: length 1.8-2.5 km", 1800 <= L <= 2500, f"{L:.1f} m")
    check("track: width 12-16 m", 12 <= man["track"]["road_width_m"] <= 16, f"{man['track']['road_width_m']} m")
    el = man["track"]["elevation_range_m"]
    check("track: elevation change within +/-12 m", -12 <= el[0] and el[1] <= 12, f"{el[0]:.1f} .. {el[1]:.1f} m")
    ftypes = {f["type"] for f in man["track"]["features"]}
    need = {"start_finish_straight", "hairpin", "fast_sweeper", "s_section", "hill"}
    check("track: has straight, hairpin, sweeper, S-section, hill", need <= ftypes, ", ".join(sorted(ftypes)))
    # col_barriers height above road
    road_s = Surface(trk["col_road"]["prims"])
    bar = trk["col_barriers"]["prims"][0]["pos"]
    rv = trk["col_road"]["prims"][0]["pos"]
    _, ri = cKDTree(rv[:, [0, 2]]).query(bar[:, [0, 2]])
    dh = bar[:, 1] - rv[ri, 1]
    top = dh > 1.0
    check("track: collision walls tall enough to not be jumped (>= 3.5 m above road)", top.any() and dh[top].min() >= 3.5,
          f"wall tops {dh[top].min():.2f}..{dh[top].max():.2f} m above the nearest road surface (visual barrier 1 m)")

    # racing line
    rl = json.loads((A / man["track"]["racing_line"]["file"]).read_text())
    pts = np.array([[p["x"], p["y"], p["z"]] for p in rl])
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    gap = np.linalg.norm(pts[0] - pts[-1])
    check("racing line: >= 200 points with speeds", len(rl) >= 200 and all(p["speed_kmh"] > 0 for p in rl),
          f"{len(rl)} points, {min(p['speed_kmh'] for p in rl):.0f}-{max(p['speed_kmh'] for p in rl):.0f} km/h")
    check("racing line: closed loop", gap <= 2 * np.median(seg), f"last->first gap {gap:.2f} m (median spacing {np.median(seg):.2f} m)")
    off_road = []
    max_dy = 0
    for i, (x, y, z) in enumerate(pts):
        h = road_s.height(x, z)
        if h is None or abs(h - y) > 0.10:
            off_road.append(i)
        else:
            max_dy = max(max_dy, abs(h - y))
    check("racing line: every point lies on col_road", not off_road,
          f"{len(pts) - len(off_road)}/{len(pts)} on surface, max |dy| {max_dy:.3f} m" + (f", off: {off_road[:10]}" if off_road else ""))

    # checkpoints
    tree = cKDTree(pts[:, [0, 2]])
    order = []
    for k in cps:
        p = trk[k]["world"][:3, 3]
        d, i = tree.query([p[0], p[2]])
        order.append((k, int(i), float(d)))
    idx = [o[1] for o in order]
    mono = all(b > a for a, b in zip(idx, idx[1:]))
    check("checkpoints: >= 12, named cp_00..cp_NN", len(cps) >= 12 and cps == [f"cp_{i:02d}" for i in range(len(cps))], f"{len(cps)} checkpoints")
    check("checkpoints: in race order along the racing line", mono and idx[0] <= 2,
          "racing-line indices " + " ".join(str(i) for i in idx))
    check("checkpoints: every box has a size in the manifest", all("box_size" in c and len(c["box_size"]) == 3 for c in man["track"]["checkpoints"]))
    # each checkpoint box must cover the racing line where it crosses
    cover = True
    for c in man["track"]["checkpoints"]:
        p = np.array(c["position"])
        d, i = tree.query([p[0], p[2]])
        lat = abs(np.dot(pts[i][[0, 2]] - p[[0, 2]], [-c["forward"][2], c["forward"][0]]))
        cover &= lat < c["box_size"][0] / 2
    check("checkpoints: trigger boxes span the racing line", cover)

    # spawns
    sp_ok, detail = True, []
    fwd_ok = True
    for sp in man["track"]["spawns"]:
        p = np.array(sp["position"])
        h = road_s.height(p[0], p[2])
        ok = h is not None and abs(h - p[1]) < 0.05
        for wname, w in man["car"]["nodes"]["wheels"].items():
            wp = p + yaw_rotate(sp["rotation"], [w["position"][0], 0, w["position"][2]])
            hh = road_s.height(wp[0], wp[2])
            ok &= hh is not None and abs(hh - p[1]) < 0.1
        sp_ok &= ok
        node = trk[sp["name"]]
        fwd = node["world"][:3, :3] @ np.array([0, 0, -1.0])
        d, i = tree.query([p[0], p[2]])
        tdir = pts[(i + 1) % len(pts)] - pts[i]
        tdir /= np.linalg.norm(tdir)
        fwd_ok &= float(np.dot(fwd, tdir)) > 0.98
        detail.append(f"{sp['name']} dy={0 if h is None else h - p[1]:+.3f}")
    check("spawns: 4 spawns on col_road (origin + all wheel contact points)", sp_ok and len(man["track"]["spawns"]) == 4, ", ".join(detail))
    check("spawns: facing the race direction (node -Z)", fwd_ok)
    cp0 = trk["cp_00"]["world"][:3, 3]
    behind = all(np.dot(np.array(sp["position"]) - cp0, np.array(man["track"]["checkpoints"][0]["forward"])) < 0
                 for sp in man["track"]["spawns"])
    check("spawns: behind the start/finish line", behind)

    # ------------------------------------------------------ images & audio
    bad = []
    for p in sorted((A / "textures").glob("*.png")) + sorted((A / "sky").glob("*.png")):
        with Image.open(p) as im:
            w, h = im.size
        if not (w & (w - 1) == 0 and h & (h - 1) == 0 and max(w, h) <= 2048):
            bad.append(f"{p.name} {w}x{h}")
    check("textures: PNG, power-of-two, <= 2048", not bad, ", ".join(bad) or f"{len(list((A / 'textures').glob('*.png')))} textures + sky ok")
    with Image.open(A / "track" / "minimap_1024.png") as im:
        corner = im.getpixel((0, 0))
        check("minimap: 1024x1024 RGBA, transparent background", im.size == (1024, 1024) and im.mode == "RGBA" and corner[3] == 0)
    with Image.open(A / "sky" / "sky_equirect_2048x1024.png") as im:
        check("sky: 2048x1024 equirectangular + low-res env", im.size == (2048, 1024) and (A / "sky" / "sky_env_256x128.png").exists())
    abad, seams = [], []
    for name, s in man["audio"]["sounds"].items():
        with wave.open(str(A / s["wav"])) as w:
            fmt = (w.getframerate(), w.getnchannels(), w.getsampwidth())
            x = np.frombuffer(w.readframes(w.getnframes()), "<i2").astype(float) / 32768
        if fmt != (44100, 1, 2) or not (A / s["ogg"]).exists():
            abad.append(name)
        else:
            try:
                import soundfile as sf
                info = sf.info(str(A / s["ogg"]))
                if info.samplerate != 44100 or info.channels != 1 or abs(info.frames - len(x)) > 64:
                    abad.append(name + " (ogg mismatch)")
            except Exception as e:  # undecodable ogg
                abad.append(f"{name} (ogg: {e})")
        if s["loop"]:
            steps = np.abs(np.diff(x))
            seam = abs(x[0] - x[-1])
            seams.append(f"{name} {seam:.3f}<= p99.9 {np.percentile(steps, 99.9):.3f}")
            if seam > np.percentile(steps, 99.9):
                abad.append(name + " (loop seam)")
    check("audio: WAV 44.1 kHz mono 16-bit + decodable OGG (same rate/length) for every sound", not [a for a in abad if "seam" not in a], ", ".join(abad))
    check("audio: loops are seamless (seam step within normal sample steps)", not [a for a in abad if "seam" in a], "; ".join(seams))
    icons = man["ui"]["icons"]
    check("ui: 7 icons (SVG + PNG) and OFL font with licence", len(icons) == 7 and all((A / f).exists() for i in icons.values() for f in i.values())
          and (A / man["ui"]["font"]["file"]).exists() and (A / man["ui"]["font"]["license_file"]).exists())

    # ------------------------------------------------------ manifest files
    mism = []
    for f in man["files"]:
        p = A / f["path"]
        if not p.exists() or hashlib.sha256(p.read_bytes()).hexdigest() != f["sha256"]:
            mism.append(f["path"])
    listed = {f["path"] for f in man["files"]}
    unlisted = [p.relative_to(A).as_posix() for p in A.rglob("*") if p.is_file() and p.name not in ("manifest.json", ".DS_Store")
                and not p.relative_to(A).as_posix().startswith("reports/") and p.relative_to(A).as_posix() not in listed]
    check("manifest: every file listed, exists, sha256 matches", not mism and not unlisted,
          f"{len(man['files'])} files" + (f"; mismatch {mism}" if mism else "") + (f"; unlisted {unlisted}" if unlisted else ""))
    prev = {"car_front34.png", "car_rear34.png", "car_side.png", "track_top.png", "track_start_grid.png"}
    have = {p.name for p in (A / "previews").glob("*.png")}
    check("previews: car x3, track top, start grid", prev <= have, ", ".join(sorted(have)))

    # --------------------------------------------------------------- report
    w = max(len(r["check"]) for r in results)
    lines = ["race-assets verification report", "=" * 32]
    for r in results:
        lines.append(f"[{'PASS' if r['ok'] else 'FAIL'}] {r['check'].ljust(w)}  {r['detail']}")
    n_fail = sum(not r["ok"] for r in results)
    lines.append("")
    lines.append(f"{len(results) - n_fail}/{len(results)} checks passed" + ("" if not n_fail else f", {n_fail} FAILED"))
    text = "\n".join(lines)
    print(text)
    (A / "reports").mkdir(exist_ok=True)
    (A / "reports" / "verify_report.txt").write_text(text + "\n")
    (A / "reports" / "verify_report.json").write_text(json.dumps({"passed": n_fail == 0, "checks": results}, indent=1) + "\n")
    sys.exit(1 if n_fail else 0)


if __name__ == "__main__":
    main()
