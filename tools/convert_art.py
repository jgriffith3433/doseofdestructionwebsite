"""Convert an image into a fighter cutout PNG. Used by devtools.

    python tools/convert_art.py <in> <out.png> [--key-black]

With --key-black, near-black pixels connected to the image edge become
transparent: the generated character art comes on a black backdrop, and dark
clothing inside the figure is left alone.
"""

import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter


def key_black(im, limit=24):
    r, g, b, a = im.split()
    peak = ImageChops.lighter(ImageChops.lighter(r, g), b)
    dark = peak.point(lambda v: 255 if v <= limit else 0)
    w, h = dark.size
    for x in range(0, w, 4):
        for y in (0, h - 1):
            if dark.getpixel((x, y)) == 255:
                ImageDraw.floodfill(dark, (x, y), 128)
    for y in range(0, h, 4):
        for x in (0, w - 1):
            if dark.getpixel((x, y)) == 255:
                ImageDraw.floodfill(dark, (x, y), 128)
    keep = dark.point(lambda v: 0 if v == 128 else 255).filter(ImageFilter.GaussianBlur(1))
    return Image.merge("RGBA", (r, g, b, ImageChops.multiply(a, keep)))


def main():
    src, dest = sys.argv[1], sys.argv[2]
    im = Image.open(src).convert("RGBA")
    if "--key-black" in sys.argv:
        im = key_black(im)
    box = im.getchannel("A").point(lambda v: 255 if v > 16 else 0).getbbox()
    if box:
        pad = 16
        im = im.crop((max(0, box[0] - pad), max(0, box[1] - pad), min(im.width, box[2] + pad), min(im.height, box[3] + pad)))
    im.save(dest)


if __name__ == "__main__":
    main()
