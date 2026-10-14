"""Coarse brightness maps so studio matte and clothing can be told apart."""

from pathlib import Path
from PIL import Image

OUT = Path(__file__).resolve().parent / "characters" / "img"


def shade(r, g, b, a):
    if a < 16:
        return "."
    v = max(r, g, b)
    if v <= 8:
        return "0"
    if v <= 18:
        return "1"
    if v <= 32:
        return "2"
    if v <= 55:
        return "3"
    if v <= 90:
        return "4"
    return "#"


def show(name, step=16):
    image = Image.open(OUT / f"{name}.png").convert("RGBA")
    pixels = image.load()
    w, h = image.size
    print("\n==", name, w, h)
    for y in range(0, h, step):
        row = []
        for x in range(0, w, step):
            row.append(shade(*pixels[x, y]))
        print("".join(row))


for name in (
    "orchestrator",
    "pyro-singer",
    "slice",
    "not-an-old-man-yet",
    "future-man",
    "try-belt",
):
    show(name)
