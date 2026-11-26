"""Minimal, dependency-free glTF 2.0 binary (.glb) writer.

Only what this project needs: one binary buffer, indexed triangle primitives,
PBR metallic-roughness materials, PNG textures embedded in the GLB, node
hierarchy, extras and a few Khronos extensions. Output is deterministic.
"""
from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np

from .geom import Mesh

ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963
FLOAT = 5126
UNSIGNED_SHORT = 5123
UNSIGNED_BYTE = 5121
UNSIGNED_INT = 5125

REPEAT, CLAMP = 10497, 33071
LINEAR, LINEAR_MIPMAP_LINEAR = 9729, 9987


def _r(x, nd=6):
    """Round floats in JSON for stable, compact output."""
    if isinstance(x, float):
        v = round(x, nd)
        return 0.0 if v == 0 else v
    if isinstance(x, (list, tuple)):
        return [_r(v, nd) for v in x]
    if isinstance(x, dict):
        return {k: _r(v, nd) for k, v in x.items()}
    if isinstance(x, (np.floating,)):
        return _r(float(x), nd)
    if isinstance(x, (np.integer,)):
        return int(x)
    return x


class GLB:
    def __init__(self, generator="race-assets procedural generator", image_uri_base=None, glb_dir=None):
        """image_uri_base: if set, textures are referenced as external files with a
        URI relative to the .glb (glb_dir) instead of being embedded."""
        self.image_uri_base = image_uri_base
        self.glb_dir = Path(glb_dir) if glb_dir else None
        self.j = {"asset": {"version": "2.0", "generator": generator}}
        self.bin = bytearray()
        self.ext_used: set[str] = set()
        self.ext_required: set[str] = set()
        self._img_cache: dict[str, int] = {}
        self._tex_cache: dict[tuple, int] = {}
        self._mat_by_name: dict[str, int] = {}

    def _list(self, key):
        return self.j.setdefault(key, [])

    # ----------------------------------------------------------- binary data
    def _view(self, data: bytes, target=None) -> int:
        while len(self.bin) % 4:
            self.bin.append(0)
        view = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data)}
        if target:
            view["target"] = target
        self.bin += data
        views = self._list("bufferViews")
        views.append(view)
        return len(views) - 1

    def _accessor(self, arr, atype, ctype, target, minmax=False, normalized=False) -> int:
        arr = np.ascontiguousarray(arr)
        view = self._view(arr.tobytes(), target)
        count = arr.shape[0]
        acc = {"bufferView": view, "componentType": ctype, "count": int(count), "type": atype}
        if normalized:
            acc["normalized"] = True
        if minmax:
            a2 = arr.reshape(count, -1)
            acc["min"] = [float(v) for v in a2.min(axis=0)]
            acc["max"] = [float(v) for v in a2.max(axis=0)]
        accs = self._list("accessors")
        accs.append(acc)
        return len(accs) - 1

    # --------------------------------------------------------------- textures
    def image(self, path: str | Path, name: str | None = None) -> int:
        path = str(path)
        if path in self._img_cache:
            return self._img_cache[path]
        imgs = self._list("images")
        if self.glb_dir is not None:
            import os
            rel = os.path.relpath(Path(path).resolve(), self.glb_dir.resolve()).replace(os.sep, "/")
            imgs.append({"name": name or Path(path).stem, "uri": rel, "mimeType": "image/png"})
        else:
            data = Path(path).read_bytes()
            view = self._view(data)
            imgs.append({"name": name or Path(path).stem, "bufferView": view, "mimeType": "image/png"})
        self._img_cache[path] = len(imgs) - 1
        return len(imgs) - 1

    def texture(self, path, wrap=REPEAT) -> int:
        key = (str(path), wrap)
        if key in self._tex_cache:
            return self._tex_cache[key]
        samplers = self._list("samplers")
        sampler = {"magFilter": LINEAR, "minFilter": LINEAR_MIPMAP_LINEAR, "wrapS": wrap, "wrapT": wrap}
        if sampler in samplers:
            si = samplers.index(sampler)
        else:
            samplers.append(sampler)
            si = len(samplers) - 1
        texs = self._list("textures")
        texs.append({"sampler": si, "source": self.image(path), "name": Path(path).stem})
        self._tex_cache[key] = len(texs) - 1
        return len(texs) - 1

    # -------------------------------------------------------------- materials
    def material(self, name, base=(1, 1, 1, 1), metallic=0.0, roughness=0.8, base_tex=None,
                 normal_tex=None, normal_scale=1.0, orm_tex=None, occlusion_strength=1.0,
                 emissive=None, emissive_strength=None, alpha_mode=None, double_sided=False,
                 extras=None) -> int:
        if name in self._mat_by_name:
            return self._mat_by_name[name]
        pbr = {"baseColorFactor": list(base), "metallicFactor": float(metallic), "roughnessFactor": float(roughness)}
        if base_tex:
            pbr["baseColorTexture"] = {"index": self.texture(base_tex)}
        if orm_tex:
            pbr["metallicRoughnessTexture"] = {"index": self.texture(orm_tex)}
        m = {"name": name, "pbrMetallicRoughness": pbr}
        if normal_tex:
            m["normalTexture"] = {"index": self.texture(normal_tex), "scale": float(normal_scale)}
        if orm_tex:
            m["occlusionTexture"] = {"index": self.texture(orm_tex), "strength": float(occlusion_strength)}
        if emissive:
            m["emissiveFactor"] = list(emissive)
            if emissive_strength and emissive_strength != 1.0:
                m.setdefault("extensions", {})["KHR_materials_emissive_strength"] = {"emissiveStrength": float(emissive_strength)}
                self.ext_used.add("KHR_materials_emissive_strength")
        if alpha_mode:
            m["alphaMode"] = alpha_mode
        if double_sided:
            m["doubleSided"] = True
        if extras:
            m["extras"] = extras
        mats = self._list("materials")
        mats.append(m)
        self._mat_by_name[name] = len(mats) - 1
        return len(mats) - 1

    # ------------------------------------------------------------------ meshes
    def mesh(self, name, prims, extras=None) -> int:
        """prims: list of (Mesh, material_index or None[, primitive_extensions])"""
        out = []
        for p in prims:
            m, mat = p[0], p[1]
            pext = p[2] if len(p) > 2 else None
            m = m.ensure_normals()
            attrs = {
                "POSITION": self._accessor(m.pos.astype(np.float32), "VEC3", FLOAT, ARRAY_BUFFER, minmax=True),
                "NORMAL": self._accessor(m.nrm.astype(np.float32), "VEC3", FLOAT, ARRAY_BUFFER),
            }
            if m.uv is not None and self._material_textured(mat):
                attrs["TEXCOORD_0"] = self._accessor(m.uv.astype(np.float32), "VEC2", FLOAT, ARRAY_BUFFER)
            if m.uv is not None and mat is not None and "normalTexture" in self.j["materials"][mat]:
                attrs["TANGENT"] = self._accessor(compute_tangents(m).astype(np.float32), "VEC4", FLOAT, ARRAY_BUFFER)
            if m.col is not None:
                c8 = np.round(np.clip(m.col, 0, 1) * 255).astype(np.uint8)
                attrs["COLOR_0"] = self._accessor(c8, "VEC4", UNSIGNED_BYTE, ARRAY_BUFFER, normalized=True)
            idx = m.idx.reshape(-1)
            if idx.max() < 65535:
                ia = self._accessor(idx.astype(np.uint16), "SCALAR", UNSIGNED_SHORT, ELEMENT_ARRAY_BUFFER)
            else:
                ia = self._accessor(idx.astype(np.uint32), "SCALAR", UNSIGNED_INT, ELEMENT_ARRAY_BUFFER)
            prim = {"attributes": attrs, "indices": ia, "mode": 4}
            if mat is not None:
                prim["material"] = mat
            if pext:
                prim["extensions"] = pext
            out.append(prim)
        mesh = {"name": name, "primitives": out}
        if extras:
            mesh["extras"] = extras
        meshes = self._list("meshes")
        meshes.append(mesh)
        return len(meshes) - 1

    def _material_textured(self, mat):
        if mat is None:
            return False
        m = self.j["materials"][mat]
        pbr = m.get("pbrMetallicRoughness", {})
        return any(k in pbr for k in ("baseColorTexture", "metallicRoughnessTexture")) or \
            any(k in m for k in ("normalTexture", "occlusionTexture", "emissiveTexture"))

    # ------------------------------------------------------------------- nodes
    def node(self, name, mesh=None, children=None, translation=None, rotation=None, scale=None,
             extras=None, extensions=None) -> int:
        n = {"name": name}
        if mesh is not None:
            n["mesh"] = mesh
        if children:
            n["children"] = list(children)
        if translation is not None and any(abs(v) > 1e-9 for v in translation):
            n["translation"] = [float(v) for v in translation]
        if rotation is not None and any(abs(v) > 1e-9 for v in rotation[:3]):
            n["rotation"] = [float(v) for v in rotation]
        if scale is not None and any(abs(v - 1) > 1e-9 for v in scale):
            n["scale"] = [float(v) for v in scale]
        if extras:
            n["extras"] = extras
        if extensions:
            n["extensions"] = extensions
            self.ext_used.update(extensions.keys())
        nodes = self._list("nodes")
        nodes.append(n)
        return len(nodes) - 1

    def scene(self, name, nodes, extras=None):
        sc = {"name": name, "nodes": list(nodes)}
        if extras:
            sc["extras"] = extras
        self._list("scenes").append(sc)
        self.j["scene"] = 0

    def set_root_extension(self, name, value):
        self.j.setdefault("extensions", {})[name] = value
        self.ext_used.add(name)

    # ------------------------------------------------------------------ output
    def write(self, path):
        while len(self.bin) % 4:
            self.bin.append(0)
        self.j["buffers"] = [{"byteLength": len(self.bin)}]
        if self.ext_used:
            self.j["extensionsUsed"] = sorted(self.ext_used)
        if self.ext_required:
            self.j["extensionsRequired"] = sorted(self.ext_required)
        accessors = self.j.get("accessors")
        out_j = _r({k: v for k, v in self.j.items() if k != "accessors"})
        if accessors is not None:
            out_j["accessors"] = accessors        # min/max must stay bit-exact float32 values
        js = json.dumps(out_j, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        while len(js) % 4:
            js += b" "
        total = 12 + 8 + len(js) + 8 + len(self.bin)
        out = bytearray()
        out += struct.pack("<4sII", b"glTF", 2, total)
        out += struct.pack("<I4s", len(js), b"JSON") + js
        out += struct.pack("<I4s", len(self.bin), b"BIN\x00") + self.bin
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_bytes(bytes(out))
        return len(out)


def compute_tangents(m: Mesh) -> np.ndarray:
    """Per-vertex tangents (xyz, w) for glTF normal mapping. T follows +u; the
    bitangent cross(N,T)*w points towards the image top (decreasing v), which is
    +Y of a glTF/OpenGL normal map."""
    p, uv, n = m.pos, m.uv, m.nrm
    i0, i1, i2 = m.idx[:, 0], m.idx[:, 1], m.idx[:, 2]
    e1, e2 = p[i1] - p[i0], p[i2] - p[i0]
    d1, d2 = uv[i1] - uv[i0], uv[i2] - uv[i0]
    det = d1[:, 0] * d2[:, 1] - d2[:, 0] * d1[:, 1]
    r = np.where(np.abs(det) > 1e-12, 1.0 / np.where(det == 0, 1, det), 0.0)[:, None]
    t = (e1 * d2[:, 1:2] - e2 * d1[:, 1:2]) * r
    bv = (e2 * d1[:, 0:1] - e1 * d2[:, 0:1]) * r          # dP/dv
    T_acc = np.zeros_like(p)
    B_acc = np.zeros_like(p)
    for k in (i0, i1, i2):
        np.add.at(T_acc, k, t)
        np.add.at(B_acc, k, bv)
    T = T_acc - n * np.einsum("ij,ij->i", T_acc, n)[:, None]
    ln = np.linalg.norm(T, axis=1)
    bad = ln < 1e-8
    if bad.any():                                         # any vector perpendicular to the normal
        alt = np.where(np.abs(n[bad, 0:1]) < 0.9, np.array([[1.0, 0, 0]]), np.array([[0, 1.0, 0]]))
        alt = alt - n[bad] * np.einsum("ij,ij->i", alt, n[bad])[:, None]
        T[bad] = alt
        ln[bad] = np.linalg.norm(alt, axis=1)
    T = T / ln[:, None]
    w = np.where(np.einsum("ij,ij->i", np.cross(n, T), -B_acc) < 0, -1.0, 1.0)
    return np.c_[T, w]


def read_glb(path):
    """Return (json, bin bytes) of a GLB file."""
    data = Path(path).read_bytes()
    magic, ver, total = struct.unpack_from("<4sII", data, 0)
    assert magic == b"glTF" and ver == 2
    jl, jt = struct.unpack_from("<I4s", data, 12)
    js = json.loads(data[20:20 + jl])
    off = 20 + jl
    bl, bt = struct.unpack_from("<I4s", data, off)
    return js, data[off + 8: off + 8 + bl]


def accessor_array(js, binb, ai):
    acc = js["accessors"][ai]
    view = js["bufferViews"][acc["bufferView"]]
    ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[acc["type"]]
    dt = {FLOAT: np.float32, UNSIGNED_SHORT: np.uint16, UNSIGNED_INT: np.uint32, UNSIGNED_BYTE: np.uint8}[acc["componentType"]]
    start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    arr = np.frombuffer(binb, dtype=dt, count=acc["count"] * ncomp, offset=start)
    return arr.reshape(acc["count"], ncomp) if ncomp > 1 else arr


def node_world_meshes(js, binb, include=None):
    """Yield (node_name, world_matrix, Mesh-like dict of primitives) for every mesh node in scene 0."""
    from .geom import T as _T

    def local(n):
        m = np.eye(4)
        if "matrix" in n:
            return np.array(n["matrix"]).reshape(4, 4).T
        t = n.get("translation", [0, 0, 0])
        r = n.get("rotation", [0, 0, 0, 1])
        s = n.get("scale", [1, 1, 1])
        x, y, z, w = r
        R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
        m[:3, :3] = R @ np.diag(s)
        m[:3, 3] = t
        return m

    out = []

    def walk(ni, parent):
        n = js["nodes"][ni]
        w = parent @ local(n)
        out.append((ni, n, w))
        for c in n.get("children", []):
            walk(c, w)
    for r in js["scenes"][js.get("scene", 0)]["nodes"]:
        walk(r, np.eye(4))
    return out
