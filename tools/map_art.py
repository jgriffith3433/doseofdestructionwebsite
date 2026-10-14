"""Art helpers for stages. Called by the devtools map routes.

    python tools/map_art.py prep <image> <out.webp> [max_width]
        A copy for the game: resized to at most max_width (default 2560),
        saved as WebP. Transparency is kept. Prints {"width", "height"}.

    python tools/map_art.py palette <image> [n]
        The image's n main colors (default 6), most common first, as JSON
        [{"hex", "share", "lum"}], plus the mean luminance.
"""

import json
import sys

from PIL import Image


def prep(src, out, max_width=2560):
    im = Image.open(src)
    im = im.convert("RGBA") if im.mode in ("RGBA", "LA", "P") else im.convert("RGB")
    if im.width > max_width:
        im = im.resize((max_width, round(im.height * max_width / im.width)), Image.LANCZOS)
    im.save(out, "WEBP", quality=88, method=5)
    print(json.dumps({"width": im.width, "height": im.height}))


def palette(src, n=6):
    im = Image.open(src).convert("RGB")
    im.thumbnail((320, 320))
    q = im.quantize(colors=n, method=Image.Quantize.MEDIANCUT)
    pal = q.getpalette()[: n * 3]
    counts = sorted(q.getcolors(), reverse=True)
    total = sum(c for c, _ in counts)
    out = []
    for count, idx in counts:
        r, g, b = pal[idx * 3: idx * 3 + 3]
        out.append({
            "hex": f"#{r:02x}{g:02x}{b:02x}",
            "share": round(count / total, 3),
            "lum": round((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255, 3),
        })
    gray = im.convert("L")
    mean = sum(gray.histogram()[i] * i for i in range(256)) / (gray.width * gray.height) / 255
    # Accents: the bright, saturated pixels (neon, fire, lit windows), which the
    # main colors of a dark scene drown out.
    hsv = im.convert("HSV")
    pixels = getattr(im, 'get_flattened_data', im.getdata)
    hsv_pixels = getattr(hsv, 'get_flattened_data', hsv.getdata)
    bright = [p for p, h in zip(pixels(), hsv_pixels()) if h[1] > 90 and h[2] > 150]
    accents = []
    if len(bright) > 20:
        strip = Image.new("RGB", (len(bright), 1))
        strip.putdata(bright)
        aq = strip.quantize(colors=4, method=Image.Quantize.MEDIANCUT)
        apal = aq.getpalette()
        for count, idx in sorted(aq.getcolors(), reverse=True):
            r, g, b = apal[idx * 3: idx * 3 + 3]
            accents.append(f"#{r:02x}{g:02x}{b:02x}")
    print(json.dumps({"colors": out, "accents": accents, "mean": round(mean, 3)}))


def main():
    cmd = sys.argv[1]
    if cmd == "prep":
        prep(sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 2560)
    elif cmd == "palette":
        palette(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 6)
    else:
        sys.exit(f"unknown command {cmd}")


if __name__ == "__main__":
    main()
