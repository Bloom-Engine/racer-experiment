#!/usr/bin/env python3
"""Procedural daytime sky -> assets/sky/

sky_equirect_2048x1024.png  - background (equirectangular, sRGB)
sky_env_256x128.png         - blurred low-res version for image based lighting

Equirect convention (identical to three.js `equirectUv` and Blender's default
environment mapping after the glTF axis conversion):
    u = 0.5 + atan2(dir.z, dir.x) / (2*pi)          (u=0.5 looks along +X)
    v = 0.5 - asin(dir.y) / pi                      (v=0 is the image top = zenith)
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from lib.tex import periodic_noise, save_rgb

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "sky"

# Direction *towards* the sun (world space, glTF axes). WSW, ~50 deg elevation:
# behind the camera on the start grid (race heads +X), so the grid is front-lit.
SUN_AZIMUTH_DEG = 160.0   # in the x-z plane from +X towards +Z (south): 160 = west, a little south
SUN_ELEVATION_DEG = 50.0
SUN_COLOR_LINEAR = (1.0, 0.95, 0.86)
SUN_ILLUMINANCE_LUX = 100000.0
SKY_AMBIENT_LINEAR = (0.42, 0.55, 0.78)


def sun_direction():
    az, el = math.radians(SUN_AZIMUTH_DEG), math.radians(SUN_ELEVATION_DEG)
    # azimuth measured in the x-z plane from +X towards +Z
    return np.array([math.cos(el) * math.cos(az), math.sin(el), math.cos(el) * math.sin(az)])


def render(w, h, sun):
    v = (np.arange(h) + 0.5) / h
    u = (np.arange(w) + 0.5) / w
    el = (0.5 - v) * math.pi
    az = (u - 0.5) * 2 * math.pi
    EL, AZ = np.meshgrid(el, az, indexing="ij")
    d = np.stack([np.cos(EL) * np.cos(AZ), np.sin(EL), np.cos(EL) * np.sin(AZ)], axis=-1)
    y = d[..., 1]

    zenith = np.array([0.16, 0.40, 0.86])
    horizon = np.array([0.72, 0.84, 0.96])
    t = np.clip(y, 0, 1) ** 0.45
    sky = horizon * (1 - t[..., None]) + zenith * t[..., None]
    # below horizon: hazy ground colour fading darker towards the nadir
    g = np.clip(-y, 0, 1) ** 0.35
    ground = np.array([0.66, 0.72, 0.74]) * (1 - g[..., None]) + np.array([0.33, 0.37, 0.30]) * g[..., None]
    col = np.where((y >= 0)[..., None], sky, ground)

    cos_sun = np.clip((d * sun).sum(-1), -1, 1)
    ang = np.arccos(cos_sun)
    glow = np.exp(-ang / 0.10) * 0.55 + np.exp(-ang / 0.45) * 0.18
    col = col + glow[..., None] * np.array([1.0, 0.92, 0.75])

    # clouds on a virtual plane, tileable noise lookup
    N = 1024
    n1 = periodic_noise(N, 81, beta=2.8, lo=2, hi=18)
    n2 = periodic_noise(N, 82, beta=2.0, lo=6, hi=60)
    cloud_tex = 0.7 * n1 + 0.3 * n2
    up = np.clip(y, 0.02, 1)
    px = d[..., 0] / up * 0.18
    pz = d[..., 2] / up * 0.18
    ix = ((px * N) % N).astype(int)
    iz = ((pz * N) % N).astype(int)
    c = cloud_tex[iz, ix]
    cover = np.clip((c - 0.52) * 3.5, 0, 1) ** 0.8
    fade = np.clip((y - 0.02) / 0.12, 0, 1) * np.clip(1 - (y - 0.55) / 0.45, 0.3, 1)
    cover *= fade
    shade = 0.82 + 0.18 * np.clip((c - 0.56) * 3, 0, 1) + 0.12 * np.clip(cos_sun, 0, 1)
    cloud_col = np.array([1.0, 1.0, 1.0]) * shade[..., None]
    col = col * (1 - cover[..., None] * 0.92) + cloud_col * cover[..., None] * 0.92

    # sun disc (slightly enlarged for readability), drawn over clouds
    disc = np.clip((0.018 - ang) / 0.004, 0, 1)
    col = col * (1 - disc[..., None]) + np.array([1.0, 0.99, 0.94]) * disc[..., None] * 1.0
    return np.clip(col, 0, 1)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    sun = sun_direction()
    hi = render(2048, 1024, sun)
    save_rgb(OUT / "sky_equirect_2048x1024.png", hi)
    # low-res irradiance-ish version: area downsample + wide blur (wrap horizontally)
    from scipy.ndimage import gaussian_filter
    lo = hi.reshape(128, 8, 256, 8, 3).mean(axis=(1, 3))
    lo = np.dstack([gaussian_filter(lo[..., k], sigma=(3, 6), mode=("nearest", "wrap")) for k in range(3)])
    save_rgb(OUT / "sky_env_256x128.png", lo)
    meta = {
        "sun_direction": [round(float(v), 6) for v in sun],
        "sun_azimuth_deg": SUN_AZIMUTH_DEG, "sun_elevation_deg": SUN_ELEVATION_DEG,
        "sun_color_linear": SUN_COLOR_LINEAR, "sun_illuminance_lux": SUN_ILLUMINANCE_LUX,
        "sky_ambient_linear": SKY_AMBIENT_LINEAR,
    }
    (ROOT / "build").mkdir(exist_ok=True)
    (ROOT / "build" / "sky_meta.json").write_text(json.dumps(meta, indent=1))
    print("  sky done, sun dir", meta["sun_direction"])


if __name__ == "__main__":
    main()
