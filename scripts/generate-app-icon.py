"""Generate the Zorvo app icons from the brand SVGs.

Usage:
    python3 scripts/generate-app-icon.py                  # regenerate src-tauri/icons/
    python3 scripts/generate-app-icon.py --masters-only <out_dir>

Draws two 1024px masters from docs/brand/assets/*.svg: the full symbol and
the small variant (no cursor, heavier stroke), per
docs/brand/zorvo-brand-brief.md. The default run then calls
`pnpm tauri icon` on the full master and rewrites the images under 32px
with the small variant: icon.ico (Pillow), icon.icns (macOS iconutil) and
the small PNGs.

Needs Python 3.9 or later (the macOS system python3 works), Pillow 9.1 or
later (pip install "pillow>=9.1"), pnpm and, for icon.icns, macOS iconutil.
"""

import argparse
import math
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parent.parent
ASSETS = REPO / "docs" / "brand" / "assets"
ICONS_DIR = REPO / "src-tauri" / "icons"
FULL_SVG = ASSETS / "zorvo-symbol.svg"
SMALL_SVG = ASSETS / "zorvo-symbol-small.svg"
FULL_MASTER = "zorvo-icon-1024.png"
SMALL_MASTER = "zorvo-icon-small-1024.png"

INK = (0x0A, 0x0A, 0x0A, 255)
PAPER = (0xFA, 0xFA, 0xFA, 255)
SS = 4  # supersampling factor
CANVAS = 1024
# macOS icon grid: 824px body centred on the 1024 canvas.
BODY = 824
SQUIRCLE_EXP = 5.0
SYMBOL_SHARE = 0.55  # symbol's viewBox as a share of the tile

# Images narrower than this use the small variant.
SMALL_BELOW = 32
ICO_SIZES = (16, 24, 32, 48, 64, 256)
# iconutil's .iconset names, each taken from the PNG chunk of that size in
# the icon.icns `tauri icon` writes. The 16px one is drawn from the small
# master instead.
ICONSET_SMALL = "icon_16x16.png"
ICONSET_FROM_TAURI = {
    "icon_16x16@2x.png": "ic11",
    "icon_32x32.png": "ic11",
    "icon_32x32@2x.png": "ic12",
    "icon_128x128.png": "ic07",
    "icon_128x128@2x.png": "ic13",
    "icon_256x256.png": "ic08",
    "icon_256x256@2x.png": "ic14",
    "icon_512x512.png": "ic09",
    "icon_512x512@2x.png": "ic10",
}
ICNS_HEADER = 8  # b"icns" + total length; each chunk has the same layout

SVG_NS = "{http://www.w3.org/2000/svg}"
# Elements load_symbol understands; anything else (a <g>, a <circle>) is refused.
SVG_TAGS = {f"{SVG_NS}{tag}" for tag in ("svg", "path", "title", "desc")}
PATH_TOKEN = re.compile(r"[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")

Point = tuple[float, float]


@dataclass(frozen=True)
class Symbol:
    viewbox: tuple[float, float, float, float]
    stroke: float
    paths: tuple[tuple[Point, ...], ...]


def parse_path(d: str) -> list[tuple[Point, ...]]:
    """Polylines from an SVG path made only of M, L, H and V commands."""
    polylines: list[list[Point]] = []
    x = y = 0.0
    cmd = ""
    tokens = PATH_TOKEN.findall(d)
    i = 0
    while i < len(tokens):
        if tokens[i].isalpha():
            cmd = tokens[i]
            i += 1
            if cmd not in "MmLlHhVv":
                raise ValueError(f"unsupported path command {cmd!r} in {d!r}")
            continue
        if not cmd:
            raise ValueError(f"path {d!r} does not start with a command")
        rel = cmd.islower()
        try:
            if cmd in "MmLl":
                x = float(tokens[i]) + (x if rel else 0)
                y = float(tokens[i + 1]) + (y if rel else 0)
                i += 2
            elif cmd in "Hh":
                x = float(tokens[i]) + (x if rel else 0)
                i += 1
            else:
                y = float(tokens[i]) + (y if rel else 0)
                i += 1
        except (IndexError, ValueError) as err:
            raise ValueError(f"malformed coordinates after {cmd!r} in {d!r}") from err
        if cmd in "Mm":
            polylines.append([(x, y)])
            cmd = "l" if rel else "L"  # extra pairs after a moveto are linetos
        elif not polylines:
            raise ValueError(f"path {d!r} does not start with a moveto")
        else:
            polylines[-1].append((x, y))
    return [tuple(p) for p in polylines]


def load_symbol(svg: Path) -> Symbol:
    """Read a flat SVG: <path>s under the root, one stroke width, no transforms."""
    root = ET.parse(svg).getroot()
    for el in root.iter():
        if el.tag not in SVG_TAGS:
            raise ValueError(f"{svg}: unsupported element {el.tag}")
        if "transform" in el.attrib:
            raise ValueError(f"{svg}: transforms are not supported")
    if "viewBox" not in root.attrib:
        raise ValueError(f"{svg}: no viewBox")
    vx, vy, vw, vh = (
        float(v) for v in re.split(r"[\s,]+", root.attrib["viewBox"].strip())
    )
    strokes = set()
    paths: list[tuple[Point, ...]] = []
    for el in root.iter(f"{SVG_NS}path"):
        stroke = el.get("stroke-width", root.get("stroke-width"))
        if stroke is None:
            raise ValueError(f"{svg}: a path has no stroke-width")
        strokes.add(float(stroke))
        paths.extend(parse_path(el.attrib["d"]))
    if len(strokes) != 1:
        raise ValueError(f"{svg}: expected one stroke width, found {sorted(strokes)}")
    return Symbol((vx, vy, vw, vh), strokes.pop(), tuple(paths))


def squircle(size: float, exp: float, steps: int = 2048) -> list[Point]:
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
    pts: list[Point],
    width: float,
    fill: tuple[int, int, int, int],
) -> None:
    r = width / 2
    # Not itertools.pairwise: it needs Python 3.10, macOS ships 3.9.
    for a, b in zip(pts, pts[1:]):  # noqa: RUF007
        draw.line([a, b], fill=fill, width=round(width))
    for x, y in pts:  # round caps and joins
        draw.ellipse([x - r, y - r, x + r, y + r], fill=fill)


def render(symbol: Symbol) -> Image.Image:
    size = CANVAS * SS
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    centre = size / 2
    body = BODY * SS
    draw.polygon(
        [(centre + x, centre + y) for x, y in squircle(body, SQUIRCLE_EXP)], fill=INK
    )

    vx, vy, vw, _ = symbol.viewbox
    box = body * SYMBOL_SHARE
    scale = box / vw
    ox = centre - box / 2
    oy = centre - box / 2

    def to_px(p: Point) -> Point:
        return (ox + (p[0] - vx) * scale, oy + (p[1] - vy) * scale)

    for path in symbol.paths:
        stroke_polyline(draw, [to_px(p) for p in path], symbol.stroke * scale, PAPER)

    return img.resize((CANVAS, CANVAS), Image.Resampling.LANCZOS)


def write_masters(out: Path) -> tuple[Image.Image, Image.Image]:
    out.mkdir(parents=True, exist_ok=True)
    full, small = render(load_symbol(FULL_SVG)), render(load_symbol(SMALL_SVG))
    full.save(out / FULL_MASTER)
    small.save(out / SMALL_MASTER)
    return full, small


def sized(full: Image.Image, small: Image.Image, px: int) -> Image.Image:
    master = small if px < SMALL_BELOW else full
    return master.resize((px, px), Image.Resampling.LANCZOS)


def write_ico(full: Image.Image, small: Image.Image, dest: Path) -> None:
    # Pillow skips sizes above the base image, so the largest frame goes first.
    frames = [sized(full, small, px) for px in sorted(ICO_SIZES, reverse=True)]
    frames[0].save(
        dest, format="ICO", sizes=[f.size for f in frames], append_images=frames[1:]
    )


def read_icns_chunks(path: Path) -> dict[str, bytes]:
    blob = path.read_bytes()
    chunks = {}
    i = ICNS_HEADER
    while i + ICNS_HEADER <= len(blob):
        kind = blob[i : i + 4].decode("latin-1")
        length = int.from_bytes(blob[i + 4 : i + 8], "big")
        if length < ICNS_HEADER:
            raise ValueError(f"corrupt chunk {kind!r} in {path}")
        chunks[kind] = blob[i + ICNS_HEADER : i + length]
        i += length
    return chunks


def write_icns(iconutil: str, small: Image.Image, dest: Path) -> None:
    """Rebuild dest, which `tauri icon` just wrote, with a small-variant 16px entry."""
    chunks = read_icns_chunks(dest)
    missing = [kind for kind in ICONSET_FROM_TAURI.values() if kind not in chunks]
    if missing:
        sys.exit(f"`tauri icon` wrote no {', '.join(missing)} entry in {dest}")
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "zorvo.iconset"
        iconset.mkdir()
        small.resize((16, 16), Image.Resampling.LANCZOS).save(iconset / ICONSET_SMALL)
        for name, kind in ICONSET_FROM_TAURI.items():
            (iconset / name).write_bytes(chunks[kind])
        subprocess.run(
            [iconutil, "-c", "icns", "-o", str(dest), str(iconset)], check=True
        )


def swap_small_pngs(full: Image.Image, small: Image.Image, icons_dir: Path) -> None:
    for target in sorted(icons_dir.rglob("*.png")):
        with Image.open(target) as current:
            px = current.width
        if px < SMALL_BELOW:
            sized(full, small, px).save(target)


def require(tool: str, why: str) -> str:
    path = shutil.which(tool)
    if path is None:
        sys.exit(f"{tool} not found: {why}")
    return path


def regenerate(icons_dir: Path) -> None:
    # Check every tool and build the whole set in a staging directory first, so
    # a failure never leaves icons_dir half-regenerated.
    pnpm = require("pnpm", "it runs `tauri icon`")
    iconutil = require("iconutil", "icon.icns can only be built on macOS")
    with tempfile.TemporaryDirectory() as tmp:
        staging = Path(tmp) / "icons"
        full, small = write_masters(Path(tmp))
        subprocess.run(
            [
                pnpm,
                "tauri",
                "icon",
                str(Path(tmp) / FULL_MASTER),
                "--output",
                str(staging),
            ],
            cwd=REPO,
            check=True,
        )
        write_ico(full, small, staging / "icon.ico")
        write_icns(iconutil, small, staging / "icon.icns")
        swap_small_pngs(full, small, staging)
        shutil.copytree(staging, icons_dir, dirs_exist_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate the Zorvo app icons.")
    target = parser.add_mutually_exclusive_group()
    target.add_argument(
        "--masters-only",
        metavar="OUT_DIR",
        type=Path,
        help="only draw the two 1024px masters into OUT_DIR",
    )
    target.add_argument(
        "--icons-dir",
        type=Path,
        default=ICONS_DIR,
        help="where to write the icon set (default: src-tauri/icons)",
    )
    args = parser.parse_args()
    if args.masters_only:
        write_masters(args.masters_only)
        return
    regenerate(args.icons_dir.resolve())


if __name__ == "__main__":
    main()
