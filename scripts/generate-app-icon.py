"""Render the Zorvo app icon master PNGs from the brand SVG geometry.

Usage: python3 scripts/generate-app-icon.py <out_dir>
Writes zorvo-icon-1024.png (full symbol) and zorvo-icon-small-1024.png
(small variant: no cursor, heavier stroke) per docs/brand/zorvo-brand-brief.md.
Needs Pillow 9.1 or later (pip install "pillow>=9.1").
"""
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

INK = (0x0A, 0x0A, 0x0A, 255)
PAPER = (0xFA, 0xFA, 0xFA, 255)
SS = 4  # supersampling factor
CANVAS = 1024
# macOS icon grid: 824px body centred on the 1024 canvas.
BODY = 824
SQUIRCLE_EXP = 5.0
SYMBOL_SHARE = 0.55  # symbol box as a share of the tile

# From docs/brand/assets/*.svg (viewBox units).
FULL = {
    "viewbox": (0, 0, 40, 40),
    "stroke": 3.6,
    "paths": [[(6, 7), (16, 14), (6, 21)], [(18, 19), (28, 26), (18, 33)], [(30, 33), (35, 33)]],
}
SMALL = {
    "viewbox": (-3, 0, 40, 40),
    "stroke": 6.0,
    "paths": [[(6, 7), (16, 14), (6, 21)], [(18, 19), (28, 26), (18, 33)]],
}


def squircle(size: float, exp: float, steps: int = 2048) -> list[tuple[float, float]]:
    half = size / 2
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        x = half * math.copysign(abs(c) ** (2 / exp), c)
        y = half * math.copysign(abs(s) ** (2 / exp), s)
        pts.append((x, y))
    return pts


def stroke_polyline(
    draw: ImageDraw.ImageDraw,
    pts: list[tuple[float, float]],
    width: float,
    fill: tuple[int, int, int, int],
) -> None:
    r = width / 2
    for a, b in zip(pts, pts[1:]):
        draw.line([a, b], fill=fill, width=round(width))
    for x, y in pts:  # round caps and joins
        draw.ellipse([x - r, y - r, x + r, y + r], fill=fill)


def render(symbol: dict) -> Image.Image:
    size = CANVAS * SS
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    centre = size / 2
    body = BODY * SS
    draw.polygon([(centre + x, centre + y) for x, y in squircle(body, SQUIRCLE_EXP)], fill=INK)

    vx, vy, vw, _vh = symbol["viewbox"]
    box = body * SYMBOL_SHARE
    scale = box / vw
    ox = centre - box / 2
    oy = centre - box / 2

    def to_px(p: tuple[float, float]) -> tuple[float, float]:
        return (ox + (p[0] - vx) * scale, oy + (p[1] - vy) * scale)

    for path in symbol["paths"]:
        stroke_polyline(draw, [to_px(p) for p in path], symbol["stroke"] * scale, PAPER)

    return img.resize((CANVAS, CANVAS), Image.Resampling.LANCZOS)


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: python3 scripts/generate-app-icon.py <out_dir>")
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    render(FULL).save(out / "zorvo-icon-1024.png")
    render(SMALL).save(out / "zorvo-icon-small-1024.png")


if __name__ == "__main__":
    main()
