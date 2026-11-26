#!/usr/bin/env python3
"""Procedural, seamlessly tiling PBR textures -> assets/textures/*.png

Ground set (1024^2, tiling): asphalt, kerb, grass, gravel  (albedo, normal, ORM)
Props: barrier (512), building facade (512), billboard atlas (1024, made-up brands),
car body liveries (1024, one per colour variant).
ORM packing: R = ambient occlusion, G = roughness, B = metallic (glTF compatible).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
from lib.tex import (ao_from_height, height_to_normal, periodic_noise, save_normal, save_orm,
                     save_rgb, srgb_mix, worley)

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "textures"
FONT = Path(__file__).parent / "vendor" / "fonts" / "russo-one" / "RussoOne-Regular.ttf"

# Physical tile size of each tiling ground texture (metres per texture repeat).
TILE_METRES = {"asphalt": 8.0, "kerb": 3.0, "grass": 8.0, "gravel": 4.0, "barrier": 8.0, "facade": 12.0}

CAR_VARIANTS = {
    # name: (paint sRGB, stripe sRGB)
    "red": ((0.78, 0.035, 0.03), (0.95, 0.95, 0.95)),
    "blue": ((0.04, 0.20, 0.72), (0.95, 0.95, 0.95)),
    "yellow": ((0.98, 0.74, 0.04), (0.05, 0.05, 0.05)),
    "black": ((0.025, 0.025, 0.03), (0.72, 0.72, 0.74)),
}

BRANDS = [  # all invented for this project
    ("VOLTARA", "ENERGY DRINK", (0.98, 0.80, 0.10), (0.08, 0.08, 0.10)),
    ("KESTRAX", "PERFORMANCE TYRES", (0.08, 0.10, 0.14), (0.95, 0.32, 0.12)),
    ("NOVAFUEL", "RACE FUELS", (0.05, 0.42, 0.85), (1.0, 1.0, 1.0)),
    ("ZEPHYRA", "MOTOR WORKS", (0.92, 0.92, 0.94), (0.75, 0.05, 0.08)),
    ("APEXLINE", "SYNTHETIC OIL", (0.10, 0.55, 0.25), (1.0, 1.0, 1.0)),
]


def asphalt(n=1024):
    base = periodic_noise(n, 11, beta=1.6, lo=2)
    fine = periodic_noise(n, 12, beta=0.6, lo=40)
    stones, cell = worley(n, 9000, 13)
    stone_mask = np.clip((0.35 - stones) * 4, 0, 1)
    cell_tone = np.random.default_rng(14).random(cell.max() + 1)[cell]
    h = 0.55 * fine + 0.45 * stone_mask * (0.6 + 0.4 * cell_tone)
    tone = 0.20 + 0.05 * (base - 0.5) + 0.06 * (fine - 0.5) + 0.10 * stone_mask * (cell_tone - 0.3)
    wear = periodic_noise(n, 15, beta=2.4, lo=1)
    tone += 0.03 * np.clip(wear - 0.55, 0, 1)
    albedo = np.dstack([tone, tone, tone * 1.04])
    rough = np.clip(0.88 - 0.10 * stone_mask * cell_tone - 0.05 * np.clip(wear - 0.6, 0, 1), 0, 1)
    ao = ao_from_height(h, 3, 2.0) * 0.5 + 0.5
    return albedo, height_to_normal(h, 3.0), ao, rough, np.zeros_like(h)


def kerb(n=1024):
    yy, xx = np.mgrid[0:n, 0:n] / n
    # v (rows) runs along the track: one red + one white stripe per tile (1.5 m each)
    red = (yy < 0.5)
    grime = periodic_noise(n, 21, beta=1.8, lo=2)
    fine = periodic_noise(n, 22, beta=0.8, lo=30)
    red_c = np.array([0.72, 0.06, 0.05])
    white_c = np.array([0.90, 0.90, 0.88])
    col = np.where(red[..., None], red_c, white_c)
    col = col * (0.88 + 0.12 * grime[..., None]) * (0.95 + 0.05 * fine[..., None])
    # rubber marks
    rubber = np.clip((periodic_noise(n, 23, beta=2.2, lo=1) - 0.62) * 3, 0, 0.6)
    col = col * (1 - rubber[..., None]) + 0.08 * rubber[..., None]
    # height: rounded ridge across the kerb (u) + bevel at stripe joints + noise
    ridge = np.sin(np.pi * xx) ** 0.5
    joint = np.minimum(np.abs(yy - 0.5), np.minimum(yy, 1 - yy))
    bevel = np.clip(joint * 60, 0, 1)
    h = 0.5 * ridge * bevel + 0.08 * fine
    ao = 0.75 + 0.25 * bevel
    rough = np.clip(0.55 + 0.25 * grime + 0.2 * rubber, 0, 1)
    return col, height_to_normal(h, 4.0), ao, rough, np.zeros_like(h)


def grass(n=1024):
    big = periodic_noise(n, 31, beta=2.6, lo=1)
    mid = periodic_noise(n, 32, beta=1.4, lo=8)
    # blade-like streaks: anisotropic high frequency noise
    r = np.random.default_rng(33)
    w = r.standard_normal((n, n))
    F = np.fft.fft2(w)
    fy = np.fft.fftfreq(n)[:, None] * n
    fx = np.fft.fftfreq(n)[None, :] * n
    amp = np.exp(-(fy / 40) ** 2) * np.exp(-(fx / 300) ** 2) * (np.hypot(fx, fy) > 20)
    blades = np.real(np.fft.ifft2(F * amp))
    blades = (blades - blades.min()) / (blades.max() - blades.min())
    t = np.clip(0.55 * big + 0.25 * mid + 0.35 * (blades - 0.5), 0, 1)
    dark = (0.10, 0.26, 0.05)
    light = (0.36, 0.55, 0.14)
    col = srgb_mix(dark, light, t)
    dry = np.clip((periodic_noise(n, 34, beta=2.2, lo=1) - 0.7) * 3, 0, 1)
    col = col * (1 - 0.4 * dry[..., None]) + np.array([0.55, 0.50, 0.28]) * 0.4 * dry[..., None]
    h = 0.6 * blades + 0.4 * mid
    ao = ao_from_height(h, 4, 1.5) * 0.4 + 0.6
    rough = np.clip(0.85 + 0.1 * (blades - 0.5), 0, 1)
    return col, height_to_normal(h, 2.5), ao, rough, np.zeros_like(h)


def gravel(n=1024):
    f1, cell = worley(n, 2600, 41)
    pebble = np.clip(1 - f1 * 2.2, 0, 1) ** 0.6
    edge, _ = worley(n, 2600, 41, second=True)
    tone = np.random.default_rng(42).random(cell.max() + 1)[cell]
    fine = periodic_noise(n, 43, beta=0.8, lo=40)
    sand = np.array([0.62, 0.55, 0.42])
    stone_a = np.array([0.72, 0.68, 0.60])
    stone_b = np.array([0.48, 0.44, 0.38])
    stone = stone_a * tone[..., None] + stone_b * (1 - tone[..., None])
    m = np.clip(edge * 6, 0, 1)
    col = sand * (1 - m[..., None]) + stone * m[..., None]
    col *= (0.9 + 0.1 * fine[..., None])
    h = pebble * m + 0.1 * fine
    ao = ao_from_height(h, 5, 2.5) * 0.6 + 0.4
    rough = np.clip(0.8 + 0.15 * (1 - m), 0, 1)
    return col, height_to_normal(h, 5.0), ao, rough, np.zeros_like(h)


def barrier(n=512):
    """Concrete wall. u runs along the wall (8 m per tile), v = top (0) to bottom (1).
    Top band painted red/white, 4 m per colour."""
    yy, xx = np.mgrid[0:n, 0:n] / n
    conc = periodic_noise(n, 51, beta=1.5, lo=2)
    fine = periodic_noise(n, 52, beta=0.7, lo=30)
    g = 0.62 + 0.10 * (conc - 0.5) + 0.05 * (fine - 0.5)
    col = np.dstack([g, g, g * 0.98])
    band = yy < 0.30
    red = xx < 0.5
    paint = np.where(red[..., None], np.array([0.80, 0.08, 0.06]), np.array([0.93, 0.93, 0.92]))
    col = np.where(band[..., None], paint * (0.9 + 0.1 * conc[..., None]), col)
    joints = (np.minimum(xx % 0.25, 0.25 - xx % 0.25) < 0.004)    # 2 m blocks
    col = col * np.where(joints[..., None], 0.55, 1.0)
    streak = np.clip(periodic_noise(n, 53, beta=2.0, lo=4) - 0.6, 0, 1) * (yy > 0.3)
    col *= (1 - 0.5 * streak[..., None])
    h = 0.4 * fine - 0.6 * joints
    rough = np.where(band, 0.5, 0.9)
    return col, height_to_normal(h, 3.0), np.ones_like(g), rough, np.zeros_like(g)


def facade(n=512):
    """Office facade, 12 m tile: 4 floors x 4 bays. Windows are glossy."""
    yy, xx = np.mgrid[0:n, 0:n] / n
    bay_u = (xx * 4) % 1
    bay_v = (yy * 4) % 1
    win = (bay_u > 0.12) & (bay_u < 0.88) & (bay_v > 0.22) & (bay_v < 0.85)
    conc = periodic_noise(n, 61, beta=1.6, lo=2)
    wall = np.dstack([0.78 + 0.05 * conc, 0.76 + 0.05 * conc, 0.72 + 0.05 * conc])
    sky = (1 - bay_v)[..., None] * np.array([0.35, 0.50, 0.65]) + bay_v[..., None] * np.array([0.12, 0.18, 0.26])
    lit = np.random.default_rng(62).random((4, 4))[np.minimum((yy * 4).astype(int), 3), np.minimum((xx * 4).astype(int), 3)]
    sky = sky * (0.85 + 0.3 * lit[..., None])
    col = np.where(win[..., None], sky, wall)
    h = np.where(win, 0.0, 1.0)
    rough = np.where(win, 0.08, 0.85)
    metal = np.where(win, 0.6, 0.0)
    return col, height_to_normal(h, 1.5), np.ones_like(conc), rough, metal


def billboard_atlas(path, meta_path):
    """1024x1024 atlas, 2 columns x 4 rows of 512x256 panels."""
    W = H = 1024
    img = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(img)
    panels = {}

    def rect(i):
        c, r = i % 2, i // 2
        return (c * 512, r * 256, c * 512 + 512, r * 256 + 256)

    def fit_font(text, max_w, size):
        while size > 8:
            f = ImageFont.truetype(str(FONT), size)
            if d.textlength(text, font=f) <= max_w:
                return f
            size -= 2
        return ImageFont.truetype(str(FONT), size)

    def c255(c):
        return tuple(int(v * 255) for v in c)

    for i, (name, tag, bg, fg) in enumerate(BRANDS):
        x0, y0, x1, y1 = rect(i)
        d.rectangle((x0, y0, x1 - 1, y1 - 1), fill=c255(bg))
        d.rectangle((x0 + 10, y0 + 10, x1 - 11, y1 - 11), outline=c255(fg), width=6)
        f = fit_font(name, 440, 120)
        tw = d.textlength(name, font=f)
        d.text((x0 + (512 - tw) / 2, y0 + 50), name, font=f, fill=c255(fg))
        f2 = fit_font(tag, 400, 40)
        tw2 = d.textlength(tag, font=f2)
        d.text((x0 + (512 - tw2) / 2, y0 + 180), tag, font=f2, fill=c255(fg))
        panels[f"brand_{name.lower()}"] = (x0, y0, x1, y1)
    # chevron warning panel (points left = towards the corner when placed on the outside)
    x0, y0, x1, y1 = rect(5)
    d.rectangle((x0, y0, x1 - 1, y1 - 1), fill=(20, 20, 20))
    for k in range(4):
        cx = x0 + 70 + k * 120
        d.polygon([(cx + 60, y0 + 30), (cx, y0 + 128), (cx + 60, y0 + 226), (cx + 100, y0 + 226), (cx + 40, y0 + 128),
                   (cx + 100, y0 + 30)], fill=(250, 200, 20))
    panels["chevron_left"] = (x0, y0, x1, y1)
    # distance boards 300 / 200 / 100 (three sub-panels in one 512x256 tile)
    x0, y0, x1, y1 = rect(6)
    d.rectangle((x0, y0, x1 - 1, y1 - 1), fill=(255, 255, 255))
    for k, label in enumerate(["300", "200", "100"]):
        sx0 = x0 + k * 170
        d.rectangle((sx0 + 6, y0 + 6, sx0 + 164, y1 - 7), fill=(255, 255, 255), outline=(20, 20, 20), width=8)
        f = fit_font(label, 140, 90)
        tw = d.textlength(label, font=f)
        d.text((sx0 + 85 - tw / 2, y0 + 75), label, font=f, fill=(20, 20, 20))
        panels[f"distance_{label}"] = (sx0, y0, sx0 + 170, y1)
    # start / finish banner
    x0, y0, x1, y1 = rect(7)
    for yy in range(4):
        for xx in range(16):
            if (xx + yy) % 2 == 0:
                d.rectangle((x0 + xx * 32, y0 + yy * 16, x0 + xx * 32 + 31, y0 + yy * 16 + 15), fill=(15, 15, 15))
                d.rectangle((x0 + xx * 32, y1 - 64 + yy * 16, x0 + xx * 32 + 31, y1 - 64 + yy * 16 + 15), fill=(15, 15, 15))
    f = fit_font("START  FINISH", 470, 80)
    tw = d.textlength("START  FINISH", font=f)
    d.text((x0 + (512 - tw) / 2, y0 + 82), "START  FINISH", font=f, fill=(200, 20, 20))
    panels["start_finish"] = (x0, y0, x1, y1)
    img.save(path, optimize=True)
    # UV rects (glTF UV: origin top-left, u right, v down)
    uv = {k: [r[0] / W, r[1] / H, r[2] / W, r[3] / H] for k, r in panels.items()}
    Path(meta_path).write_text(json.dumps(uv, indent=1))


def car_livery(n=1024):
    """u = around the body cross-section (0 bottom centre -> 0.5 roof centre -> 1),
    v = along the car (0 front bumper -> 1 rear bumper). Twin racing stripes."""
    xx = (np.arange(n) + 0.5) / n
    d = np.abs(xx - 0.5)
    stripe = ((d > 0.004) & (d < 0.024)).astype(float)
    # soft 1px anti-aliasing
    from scipy.ndimage import uniform_filter1d
    stripe = uniform_filter1d(stripe, 3)
    flake = periodic_noise(n, 71, beta=0.3, lo=100)
    out = {}
    for name, (paint, st) in CAR_VARIANTS.items():
        col = np.array(paint)[None, None, :] * (1 - stripe[None, :, None]) + np.array(st)[None, None, :] * stripe[None, :, None]
        col = np.broadcast_to(col, (n, n, 3)) * (0.985 + 0.03 * flake[..., None])
        out[name] = col
    return out


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, fn in [("asphalt", asphalt), ("kerb", kerb), ("grass", grass), ("gravel", gravel),
                     ("barrier", barrier), ("facade", facade)]:
        alb, nrm, ao, rough, metal = fn()
        save_rgb(OUT / f"{name}_albedo.png", alb)
        save_normal(OUT / f"{name}_normal.png", nrm)
        save_orm(OUT / f"{name}_orm.png", ao, rough, metal)
        print(f"  texture {name}: {alb.shape[1]}x{alb.shape[0]}")
    billboard_atlas(OUT / "billboards_albedo.png", OUT.parent.parent / "build" / "billboard_uv.json")
    for name, col in car_livery().items():
        save_rgb(OUT / f"car_body_{name}_albedo.png", col)
    (OUT.parent.parent / "build").mkdir(exist_ok=True)
    Path(OUT.parent.parent / "build" / "texture_meta.json").write_text(json.dumps(
        {"tile_metres": TILE_METRES, "car_variants": {k: {"paint_srgb": v[0], "stripe_srgb": v[1]} for k, v in CAR_VARIANTS.items()},
         "brands": [b[0] for b in BRANDS]}, indent=1))
    print("  billboard atlas + car liveries done")


if __name__ == "__main__":
    main()
