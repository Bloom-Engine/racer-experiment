#!/usr/bin/env python3
"""Flat white-on-transparent UI icons (SVG + PNG 64/128/256) and the OFL UI font.

Each icon is described once as simple shapes in a 24x24 view box; the same
description is written as SVG and rasterised (4x supersampled) with Pillow.
"""
from __future__ import annotations

import json
import math
import shutil
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "ui"
FONT_SRC = Path(__file__).parent / "vendor" / "fonts" / "russo-one"
SIZES = (64, 128, 256)


def arc_pts(cx, cy, r, a0, a1, n=48):
    """Angles in degrees, 0 = +x, counter-clockwise on screen (y down => negate)."""
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / n)),
             cy - r * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]


ICONS = {
    "nitro": [
        ("poly", [(14.5, 1.5), (4.5, 13.5), (11, 13.5), (9, 22.5), (19.5, 9.5), (13, 9.5), (15.5, 1.5)]),
    ],
    "pause": [
        ("rect", 5.5, 4, 4.5, 16, 1.2),
        ("rect", 14, 4, 4.5, 16, 1.2),
    ],
    "camera": [
        ("stroke_rect", 2.5, 7, 19, 13, 2.2, 2),
        ("poly", [(8, 7.2), (9.6, 4), (14.4, 4), (16, 7.2)]),
        ("ring", 12, 13.5, 3.9, 2),
        ("circle", 18.2, 9.8, 1.0),
    ],
    "reset": [
        ("arc", 12, 12, 7.5, 60, 340, 2.6),
        ("poly", [(14.2, 1.8), (21.0, 5.6), (14.6, 10.0)]),
    ],
    "steer_left": [
        ("poly", [(2.5, 12), (11, 3.5), (11, 8.5), (21.5, 8.5), (21.5, 15.5), (11, 15.5), (11, 20.5)]),
    ],
    "steer_right": [
        ("poly", [(21.5, 12), (13, 3.5), (13, 8.5), (2.5, 8.5), (2.5, 15.5), (13, 15.5), (13, 20.5)]),
    ],
    "brake": [
        ("ring", 12, 12, 8.0, 2.4),
        ("circle", 12, 12, 2.6),
        ("circle", 12, 7.6, 0.9), ("circle", 16.4, 12, 0.9), ("circle", 12, 16.4, 0.9), ("circle", 7.6, 12, 0.9),
        ("arc", 12, 12, 10.6, 15, 75, 2.6),
    ],
}


def svg(shapes):
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">']
    for s in shapes:
        k = s[0]
        if k == "poly":
            pts = " ".join(f"{x:g},{y:g}" for x, y in s[1])
            parts.append(f'<polygon points="{pts}" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="0.3" stroke-linejoin="round"/>')
        elif k == "rect":
            _, x, y, w, h, rx = s
            parts.append(f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" rx="{rx:g}" fill="#FFFFFF"/>')
        elif k == "stroke_rect":
            _, x, y, w, h, rx, sw = s
            parts.append(f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" rx="{rx:g}" fill="none" stroke="#FFFFFF" stroke-width="{sw:g}"/>')
        elif k == "circle":
            _, cx, cy, r = s
            parts.append(f'<circle cx="{cx:g}" cy="{cy:g}" r="{r:g}" fill="#FFFFFF"/>')
        elif k == "ring":
            _, cx, cy, r, sw = s
            parts.append(f'<circle cx="{cx:g}" cy="{cy:g}" r="{r:g}" fill="none" stroke="#FFFFFF" stroke-width="{sw:g}"/>')
        elif k == "arc":
            _, cx, cy, r, a0, a1, sw = s
            p = arc_pts(cx, cy, r, a0, a1, 64)
            d = "M" + " L".join(f"{x:.3f},{y:.3f}" for x, y in p)
            parts.append(f'<path d="{d}" fill="none" stroke="#FFFFFF" stroke-width="{sw:g}" stroke-linecap="round" stroke-linejoin="round"/>')
    parts.append("</svg>")
    return "\n".join(parts) + "\n"


def raster(shapes, size):
    ss = 4
    S = size * ss
    k = S / 24.0
    m = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(m)

    def P(x, y):
        return (x * k, y * k)
    for s in shapes:
        t = s[0]
        if t == "poly":
            d.polygon([P(*p) for p in s[1]], fill=255)
            d.line([P(*p) for p in s[1]] + [P(*s[1][0])], fill=255, width=max(1, int(0.3 * k)), joint="curve")
        elif t == "rect":
            _, x, y, w, h, rx = s
            d.rounded_rectangle([P(x, y), P(x + w, y + h)], radius=rx * k, fill=255)
        elif t == "stroke_rect":
            _, x, y, w, h, rx, sw = s
            d.rounded_rectangle([P(x - sw / 2, y - sw / 2), P(x + w + sw / 2, y + h + sw / 2)], radius=(rx + sw / 2) * k, fill=255)
            d.rounded_rectangle([P(x + sw / 2, y + sw / 2), P(x + w - sw / 2, y + h - sw / 2)], radius=max(rx - sw / 2, 0) * k, fill=0)
        elif t == "circle":
            _, cx, cy, r = s
            d.ellipse([P(cx - r, cy - r), P(cx + r, cy + r)], fill=255)
        elif t == "ring":
            _, cx, cy, r, sw = s
            d.ellipse([P(cx - r - sw / 2, cy - r - sw / 2), P(cx + r + sw / 2, cy + r + sw / 2)], fill=255)
            d.ellipse([P(cx - r + sw / 2, cy - r + sw / 2), P(cx + r - sw / 2, cy + r - sw / 2)], fill=0)
        elif t == "arc":
            _, cx, cy, r, a0, a1, sw = s
            outer = [P(*p) for p in arc_pts(cx, cy, r + sw / 2, a0, a1, 96)]
            inner = [P(*p) for p in arc_pts(cx, cy, r - sw / 2, a0, a1, 96)]
            d.polygon(outer + inner[::-1], fill=255)
            pts = [P(*p) for p in arc_pts(cx, cy, r, a0, a1, 1)]
            for e in (pts[0], pts[-1]):
                rr = sw * k / 2
                d.ellipse([e[0] - rr, e[1] - rr, e[0] + rr, e[1] + rr], fill=255)
    m = m.resize((size, size), Image.LANCZOS)
    img = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    img.putalpha(m)
    return img


def main():
    (OUT / "icons").mkdir(parents=True, exist_ok=True)
    meta = {}
    for name, shapes in ICONS.items():
        (OUT / "icons" / f"{name}.svg").write_text(svg(shapes))
        files = {"svg": f"ui/icons/{name}.svg"}
        for sz in SIZES:
            p = OUT / "icons" / f"{name}_{sz}.png"
            raster(shapes, sz).save(p, optimize=True)
            files[f"png_{sz}"] = f"ui/icons/{name}_{sz}.png"
        meta[name] = files
    fdir = OUT / "fonts"
    fdir.mkdir(parents=True, exist_ok=True)
    shutil.copy(FONT_SRC / "RussoOne-Regular.ttf", fdir / "RussoOne-Regular.ttf")
    shutil.copy(FONT_SRC / "OFL.txt", fdir / "RussoOne-OFL.txt")
    (ROOT / "build").mkdir(exist_ok=True)
    (ROOT / "build" / "ui_meta.json").write_text(json.dumps(meta, indent=1))
    print(f"  ui: {len(ICONS)} icons x (svg + {len(SIZES)} png), font copied")


if __name__ == "__main__":
    main()
