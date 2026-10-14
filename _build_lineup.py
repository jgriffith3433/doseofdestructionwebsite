"""Compose every fighter into one lineup image for the home page hero.

Reads the cutouts in characters/img/ and writes site/img/lineup-*.webp.
Rerun after recutting any character art.
"""

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parent
IMG = ROOT / "characters" / "img"
OUT = ROOT / "site" / "img"
BG = (16, 14, 12)

# Back to front. The four playable fighters stand front and center.
ROWS = [
    ["yo-bot", "lapis-man", "orchestrator", "pyro-singer", "dj-wont-read", "future-man",
     "slice", "not-an-old-man-yet", "try-belt", "susan", "small-weather"],
    ["spider-bot", "shark-dude", "blog-man", "stratabots", "cel", "crystalline-intelligences",
     "crosser", "the-mechanic", "shutup-bot", "slow-rider", "ss-boulder"],
    ["ball-person", "got-ur-back", "tt", "kaelen", "break", "exit-punk",
     "evil-blue-bird", "yooba", "wallit", "chooser", "uh-me"],
]

W, H = 2800, 1180
# Per row: figure height, feet line, brightness, horizontal margin, stagger.
ROW_STYLE = [
    dict(height=400, base=640, light=0.5, margin=170, shift=0.0),
    dict(height=480, base=860, light=0.74, margin=110, shift=0.5),
    dict(height=580, base=1150, light=1.0, margin=60, shift=0.0),
]
MAX_ASPECT = 1.25


def key_backdrop(im):
    """Clear dark backdrop that touches the image edge; dark clothing inside the figure stays."""
    small = im.copy()
    small.thumbnail((700, 700))
    r, g, b, a = small.split()
    peak = ImageChops.lighter(ImageChops.lighter(r, g), b)
    # 255 where a pixel is dark or already transparent, so the fill can travel through it.
    dark = ImageChops.lighter(peak.point(lambda v: 255 if v < 34 else 0), a.point(lambda v: 255 if v < 40 else 0))
    w, h = dark.size
    for x in range(0, w, 6):
        for y in (0, h - 1):
            if dark.getpixel((x, y)) == 255:
                ImageDraw.floodfill(dark, (x, y), 128)
    for y in range(0, h, 6):
        for x in (0, w - 1):
            if dark.getpixel((x, y)) == 255:
                ImageDraw.floodfill(dark, (x, y), 128)
    keep = dark.point(lambda v: 0 if v == 128 else 255).filter(ImageFilter.GaussianBlur(1.2))
    keep = keep.resize(im.size, Image.BILINEAR)
    return Image.merge("RGBA", (*im.split()[:3], ImageChops.multiply(im.getchannel("A"), keep)))


def figure(name):
    im = key_backdrop(Image.open(IMG / f"{name}.png").convert("RGBA"))
    # Measure by solid, non-black pixels so stray haze doesn't pad the crop.
    solid = im.getchannel("A").point(lambda v: 255 if v > 110 else 0)
    box = solid.getbbox() or (0, 0, im.width, im.height)
    return im.crop(box)


def place(fig, height):
    h = height
    if fig.width / fig.height > MAX_ASPECT:
        h = int(height * MAX_ASPECT * fig.height / fig.width)
    w = max(1, round(fig.width * h / fig.height))
    return fig.resize((w, h), Image.LANCZOS)


def backdrop():
    canvas = Image.new("RGB", (W, H), BG)
    glow = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(glow)
    d.ellipse((W * 0.18, H * 0.25, W * 0.82, H * 1.2), fill=150)
    d.ellipse((W * 0.36, H * 0.5, W * 0.64, H * 1.05), fill=230)
    glow = glow.filter(ImageFilter.GaussianBlur(160))
    ember = Image.new("RGB", (W, H), (255, 90, 31))
    canvas = Image.composite(ember, canvas, glow.point(lambda v: v * 0.42))
    # Dashed blast-zone frame, echoing the in-game stage.
    d = ImageDraw.Draw(canvas)
    for x in range(120, W - 120, 34):
        d.line((x, 70, x + 18, 70), fill=(92, 72, 40), width=3)
    for y in range(70, H - 200, 34):
        d.line((120, y, 120, y + 18), fill=(92, 72, 40), width=3)
        d.line((W - 120, y, W - 120, y + 18), fill=(92, 72, 40), width=3)
    return canvas.convert("RGBA")


def main():
    names = [n for row in ROWS for n in row]
    on_disk = sorted(p.stem for p in IMG.glob("*.png"))
    missing = sorted(set(on_disk) - set(names))
    unknown = sorted(set(names) - set(on_disk))
    if missing or unknown:
        raise SystemExit(f"lineup out of date. not placed: {missing}, no art: {unknown}")

    canvas = backdrop()
    for row, style in zip(ROWS, ROW_STYLE):
        span = W - style["margin"] * 2
        slot = span / len(row)
        # Draw from the outside in, so the middle of each row overlaps its neighbours.
        order = sorted(range(len(row)), key=lambda i: -abs(i - (len(row) - 1) / 2))
        for i in order:
            fig = place(figure(row[i]), style["height"])
            if style["light"] < 1:
                rgb = ImageEnhance.Brightness(fig.convert("RGB")).enhance(style["light"])
                fig = Image.merge("RGBA", (*rgb.split(), fig.getchannel("A")))
            cx = style["margin"] + (i + 0.5 + style["shift"] * (1 if i % 2 else -1) * 0.25) * slot
            x = round(cx - fig.width / 2)
            y = style["base"] - fig.height
            # A soft contact shadow under each fighter.
            shadow = Image.new("L", (fig.width + 80, 60), 0)
            ImageDraw.Draw(shadow).ellipse((20, 10, fig.width + 60, 50), fill=150)
            shadow = shadow.filter(ImageFilter.GaussianBlur(14))
            canvas.paste((0, 0, 0, 255), (x - 40, style["base"] - 30), shadow)
            canvas.alpha_composite(fig, (x, y))
        # Haze between rows pushes the back rows further away.
        if style["light"] < 1:
            haze = Image.new("RGBA", (W, H), (*BG, 0))
            mask = Image.new("L", (W, H), 0)
            ImageDraw.Draw(mask).rectangle((0, style["base"] - 40, W, H), fill=70)
            mask = mask.filter(ImageFilter.GaussianBlur(60))
            haze.putalpha(mask)
            canvas.alpha_composite(haze)

    # Fade the bottom edge into the page.
    fade = Image.new("L", (1, H), 0)
    for y in range(H):
        t = max(0, (y - (H - 170)) / 170)
        fade.putpixel((0, y), int(255 * min(1, t) ** 1.4))
    canvas.paste((*BG, 255), (0, 0), fade.resize((W, H)))

    OUT.mkdir(parents=True, exist_ok=True)
    rgb = canvas.convert("RGB")
    for width in (2800, 1600, 900):
        size = (width, round(H * width / W))
        rgb.resize(size, Image.LANCZOS).save(OUT / f"lineup-{width}.webp", quality=82, method=6)
    rgb.resize((1600, round(H * 1600 / W)), Image.LANCZOS).save(OUT / "lineup-1600.jpg", quality=84, optimize=True)
    print("wrote", ", ".join(p.name for p in sorted(OUT.glob("lineup-*"))))


if __name__ == "__main__":
    main()
