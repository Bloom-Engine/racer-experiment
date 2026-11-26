"""Procedural, seamlessly tiling texture helpers (numpy + Pillow)."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image


def rng(seed):
    return np.random.default_rng(seed)


def periodic_noise(size, seed, beta=2.0, lo=1.0, hi=None):
    """Tileable fractal noise by spectral synthesis (1/f^beta), normalised to 0..1.
    lo/hi limit the spatial frequency band (cycles per tile)."""
    r = rng(seed)
    white = r.standard_normal((size, size))
    F = np.fft.fft2(white)
    fy = np.fft.fftfreq(size) * size
    fx = np.fft.fftfreq(size) * size
    f = np.sqrt(fy[:, None] ** 2 + fx[None, :] ** 2)
    f[0, 0] = 1.0
    amp = 1.0 / f ** (beta / 2)
    amp[f < lo] = 0
    if hi is not None:
        amp *= np.exp(-(f / hi) ** 2)
    out = np.real(np.fft.ifft2(F * amp))
    out -= out.min()
    out /= max(out.max(), 1e-9)
    return out


def worley(size, n_points, seed, second=False):
    """Tileable Worley (cellular) distance field, normalised 0..1, plus cell id."""
    from scipy.spatial import cKDTree
    r = rng(seed)
    pts = r.random((n_points, 2)) * size
    tree = cKDTree(pts, boxsize=size)
    yy, xx = np.mgrid[0:size, 0:size]
    q = np.c_[xx.ravel() + 0.5, yy.ravel() + 0.5]
    d, i = tree.query(q, k=2)
    f1 = d[:, 0].reshape(size, size)
    f2 = d[:, 1].reshape(size, size)
    cell = i[:, 0].reshape(size, size)
    val = (f2 - f1) if second else f1
    val = val / max(val.max(), 1e-9)
    return val, cell


def height_to_normal(h, strength):
    """Tangent-space normal map (glTF/OpenGL convention: +X right, +Y up = towards top of image)."""
    dx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * 0.5
    dy_up = (np.roll(h, 1, axis=0) - np.roll(h, -1, axis=0)) * 0.5
    n = np.dstack([-dx * strength, -dy_up * strength, np.ones_like(h)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    return n


def ao_from_height(h, radius=6, strength=1.5):
    """Cheap cavity AO: compare height to a blurred (periodic) version."""
    from scipy.ndimage import uniform_filter
    blur = uniform_filter(h, size=radius * 2 + 1, mode="wrap")
    ao = 1.0 - np.clip((blur - h) * strength, 0, 1)
    return ao


def to8(a):
    return (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)


def save_rgb(path, rgb):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(to8(rgb), "RGB").save(path, optimize=True)


def save_rgba(path, rgba):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(to8(rgba), "RGBA").save(path, optimize=True)


def save_gray(path, g):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(to8(g), "L").save(path, optimize=True)


def save_normal(path, n):
    save_rgb(path, n * 0.5 + 0.5)


def save_orm(path, ao, rough, metal):
    save_rgb(path, np.dstack([ao, rough, metal]))


def lerp(a, b, t):
    t = np.asarray(t)[..., None] if np.ndim(t) == 2 and np.ndim(a) == 1 else t
    return np.asarray(a) * (1 - t) + np.asarray(b) * t


def srgb_mix(c0, c1, t):
    """Mix two sRGB colours (0..1 tuples) by map t (H,W) -> (H,W,3)."""
    c0 = np.asarray(c0, float)
    c1 = np.asarray(c1, float)
    return c0[None, None, :] * (1 - t[..., None]) + c1[None, None, :] * t[..., None]
