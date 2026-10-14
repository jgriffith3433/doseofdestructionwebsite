"""Image work for painting stages. Called by tools/maps/paint.mjs and review.mjs.

    python tools/maps/stage_art.py blockout <spec.json> <out.png>
        Draws a blockout: the shapes an image model paints over, so the art
        lands exactly on the collision. spec: {
          "frame": {"x1","x2","y1","y2"},   world units, y up
          "size": [w, h],
          "background": "#ffffff" | {"top": "#..", "bottom": "#.."},
          "shapes": [
            {"kind": "box", "x1","x2","y1","y2", "fill": "#..", "line": "#.."},
            {"kind": "top", "x1","x2","y", "thick": 8, "color": "#.."},
            {"kind": "band", "y1","y2", "fill": "#.."}      full width
          ]}

    python tools/maps/stage_art.py finish <in.png> <out.webp> <w> <h> [--cutout] [--fit <spec.json>]
        A painted piece ready for the game: resized to exactly w x h (the
        frame it was painted for) and, with --cutout, cut out with BiRefNet
        so only the painted structures remain. Needs the project .venv for
        --cutout (rembg). With --fit ({"frame", "platforms": [{x1, x2, y}]}) it
        also scores how well the painted walkable tops sit on those platforms.

    python tools/maps/stage_art.py moodboard <image> <out.png> [px]
        The image's palette and light without its layout (shrunk to px wide,
        blurred back up), so a painter takes the mood but not the composition.

    python tools/maps/stage_art.py composite <spec.json> <out.png>
        The stage as the default camera sees it, for the art-director review:
        spec: {"frame", "size", "sky": [3 colors], "back" and "front": layers
        [{"file"|null, "x", "y", "width", "aspect", "opacity", "label"}] far to
        near (height comes from the image, else width * aspect), "platforms":
        [{"x1","x2","y"}], "fighters": [{"x","y"}]}. Back layers, then the
        platforms and fighters, then front layers.
"""

import json
import sys

from PIL import Image, ImageDraw


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


class Frame:
    def __init__(self, frame, size):
        self.x1, self.x2, self.y1, self.y2 = frame["x1"], frame["x2"], frame["y1"], frame["y2"]
        self.w, self.h = size

    def px(self, x, y):
        return (
            (x - self.x1) / (self.x2 - self.x1) * self.w,
            (self.y2 - y) / (self.y2 - self.y1) * self.h,
        )


def gradient(size, top, bottom):
    w, h = size
    a, b = hex_rgb(top), hex_rgb(bottom)
    col = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / max(1, h - 1)
        col.putpixel((0, y), tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3)))
    return col.resize((w, h))


def paint_texture(im, box, fill):
    """A surface to paint over: lighter at the top, darker at the bottom, with grain."""
    import random

    xa, ya, xb, yb = [round(v) for v in box]
    w, h = max(1, xb - xa), max(1, yb - ya)
    tile = Image.new("RGB", (w, h))
    px = tile.load()
    rnd = random.Random(w * 7919 + h)
    for y in range(h):
        k = 1.18 - 0.36 * (y / h)
        for x in range(w):
            n = rnd.randint(-4, 4)
            px[x, y] = tuple(max(0, min(255, round(c * k) + n)) for c in fill)
    # Soft, not pixel noise: the detail pass turns hard grain into blocky squares.
    from PIL import ImageFilter

    im.paste(tile.filter(ImageFilter.GaussianBlur(2)), (xa, ya))


def paint_windows(d, box, spec):
    """Rows of windows, some lit, so a facade has something to become."""
    import random

    xa, ya, xb, yb = box
    w, h = xb - xa, yb - ya
    size = spec.get("size", 26)
    cols = max(1, int(w // (size * 2.2)))
    rows = max(1, int(h // (size * 2.6)))
    lit = hex_rgb(spec.get("lit", "#f0b45a"))
    dark = hex_rgb(spec.get("dark", "#1b1d24"))
    rnd = random.Random(int(w * 31 + h))
    gx = w / cols
    gy = h / rows
    for r in range(rows):
        for c in range(cols):
            cx, cy = xa + gx * (c + 0.5), ya + gy * (r + 0.55)
            color = lit if rnd.random() < spec.get("share", 0.55) else dark
            d.rectangle([cx - size * 0.45, cy - size * 0.6, cx + size * 0.45, cy + size * 0.6], fill=color)


def blockout(spec_file, out):
    spec = json.load(open(spec_file, encoding="utf-8"))
    f = Frame(spec["frame"], spec["size"])
    bg = spec.get("background", "#ffffff")
    im = gradient(spec["size"], bg["top"], bg["bottom"]) if isinstance(bg, dict) else Image.new("RGB", tuple(spec["size"]), hex_rgb(bg))
    d = ImageDraw.Draw(im)
    for s in spec.get("shapes", []):
        if s["kind"] == "band":
            _, ya = f.px(0, s["y2"])
            _, yb = f.px(0, s["y1"])
            d.rectangle([0, ya, f.w, yb], fill=hex_rgb(s["fill"]))
        elif s["kind"] == "box":
            xa, ya = f.px(s["x1"], s["y2"])
            xb, yb = f.px(s["x2"], s["y1"])
            fill = hex_rgb(s.get("fill", "#b0b0b0"))
            if s.get("texture"):
                paint_texture(im, (xa, ya, xb, yb), fill)
                d = ImageDraw.Draw(im)
                d.rectangle([xa, ya, xb, yb], outline=hex_rgb(s.get("line", "#404040")), width=3)
            else:
                d.rectangle([xa, ya, xb, yb], fill=fill, outline=hex_rgb(s.get("line", "#404040")), width=3)
            if s.get("windows"):
                paint_windows(d, (xa, ya, xb, yb), s["windows"])
        elif s["kind"] == "top":
            xa, ya = f.px(s["x1"], s["y"])
            xb, _ = f.px(s["x2"], s["y"])
            t = s.get("thick", 8)
            d.rectangle([xa, ya - t / 2, xb, ya + t / 2], fill=hex_rgb(s.get("color", "#202020")))
    im.save(out)
    print(json.dumps({"width": im.width, "height": im.height}))


def white_key(im):
    """Alpha from distance to white, when the painter kept the background plain white.
    None if it didn't (then the model cutout runs instead)."""
    from PIL import ImageChops, ImageFilter

    rgb = im.convert("RGB")
    w, h = rgb.size
    # The border should be almost all white.
    edge = [rgb.getpixel((x, y)) for x in range(0, w, max(1, w // 64)) for y in (0, h - 1)]
    edge += [rgb.getpixel((x, y)) for y in range(0, h, max(1, h // 64)) for x in (0, w - 1)]
    white = sum(1 for p in edge if min(p) > 232) / len(edge)
    white_key.border = round(white, 2)
    if white < 0.9:
        return None
    # How far each pixel is from white (its darkest channel), as a soft ramp.
    inv = ImageChops.invert(rgb)
    far = inv.split()
    dist = ImageChops.lighter(ImageChops.lighter(far[0], far[1]), far[2])
    alpha = dist.point(lambda v: 0 if v < 14 else 255 if v > 46 else round((v - 14) * 255 / 32))
    # Specks of near-white noise out, holes in solid shapes closed.
    alpha = alpha.filter(ImageFilter.MedianFilter(3))
    return alpha


def fit_score(alpha, frame, platforms, w, h):
    """How well the painted walkable tops sit on the collision: for sampled columns of
    each platform, is there a transparent-to-solid edge within a few units of its y?"""
    f = Frame(frame, (w, h))
    px_per_unit = h / (frame["y2"] - frame["y1"])
    tol = max(2, round(14 * px_per_unit))
    window = max(tol + 2, round(70 * px_per_unit))
    a = alpha.load()
    per = []
    for p in platforms:
        xa, ya = f.px(p["x1"], p["y"])
        xb, _ = f.px(p["x2"], p["y"])
        ya = round(ya)
        hits = tested = 0
        for x in range(max(0, round(xa) + 3), min(w, round(xb) - 3), max(1, round((xb - xa) / 24))):
            col = [a[x, y] > 128 if 0 <= y < h else False for y in range(ya - window, ya + window)]
            if all(col) or not any(col):
                continue  # covered by a structure above, or nothing here at all
            tested += 1
            edges = [i for i in range(1, len(col)) if col[i] and not col[i - 1]]
            if any(abs(i - window) <= tol for i in edges):
                hits += 1
        per.append(round(hits / tested, 2) if tested else None)
    known = [v for v in per if v is not None]
    return {"score": round(sum(known) / len(known), 2) if known else None, "platforms": per}


def finish(src, out, w, h, cutout=False, fit=None):
    im = Image.open(src).convert("RGBA").resize((w, h), Image.LANCZOS)
    keyed = white_key(im) if cutout else None
    how = "none"
    if keyed is not None:
        im.putalpha(keyed)
        cutout = False
        how = "white"
    if cutout:
        from rembg import new_session, remove

        session = new_session("birefnet-general")
        mask = remove(im.convert("RGB"), session=session, only_mask=True)
        if mask.size != im.size:
            mask = mask.resize(im.size)
        im.putalpha(mask.convert("L"))
        how = "model"
    im.save(out, "WEBP", quality=90, method=5)
    box = im.getchannel("A").getbbox()
    result = {"width": w, "height": h, "empty": box is None, "keyed": how, "border": getattr(white_key, "border", None)}
    if fit:
        spec = json.load(open(fit, encoding="utf-8"))
        result["fit"] = fit_score(im.getchannel("A"), spec["frame"], spec["platforms"], w, h)
    print(json.dumps(result))


def composite(spec_file, out):
    spec = json.load(open(spec_file, encoding="utf-8"))
    f = Frame(spec["frame"], spec["size"])
    sky = spec.get("sky", ["#202020", "#101010", "#000000"])
    im = gradient(spec["size"], sky[1], sky[0]).convert("RGBA")

    def layers(items):
        d = ImageDraw.Draw(im)
        for layer in items:
            art = Image.open(layer["file"]).convert("RGBA") if layer.get("file") else None
            aspect = art.height / art.width if art else layer.get("aspect", 0.56)
            hw, hh = layer["width"] / 2, layer["width"] * aspect / 2
            xa, ya = f.px(layer["x"] - hw, layer["y"] + hh)
            xb, yb = f.px(layer["x"] + hw, layer["y"] - hh)
            w, h = max(1, round(xb - xa)), max(1, round(yb - ya))
            if art:
                art = art.resize((w, h), Image.LANCZOS)
                if layer.get("opacity", 1) < 1:
                    art.putalpha(art.getchannel("A").point(lambda v: round(v * layer["opacity"])))
                im.alpha_composite(art, (round(xa), round(ya)))
            else:
                # Art not painted yet: a labeled box.
                d.rectangle([xa, ya, xb, yb], outline=(255, 120, 200, 255), width=2)
                d.text((xa + 4, ya + 4), f"{layer.get('label', '')} (not painted)", fill=(255, 140, 210, 255))

    layers(spec.get("back", []))
    d = ImageDraw.Draw(im)
    for p in spec.get("platforms", []):
        xa, ya = f.px(p["x1"], p["y"])
        xb, _ = f.px(p["x2"], p["y"])
        d.line([xa, ya, xb, ya], fill=(126, 226, 160, 255), width=2)
    for fi in spec.get("fighters", []):
        xa, ya = f.px(fi["x"] - 25, fi["y"] + 112)
        xb, yb = f.px(fi["x"] + 25, fi["y"])
        d.rectangle([xa, ya, xb, yb], outline=(255, 209, 90, 255), width=2)
    layers(spec.get("front", []))
    im.convert("RGB").save(out)
    print(json.dumps({"width": im.width, "height": im.height}))


def moodboard(src, out, px=40):
    """The concept's palette and light without its layout: tiny, then blurred back up."""
    from PIL import ImageFilter

    im = Image.open(src).convert("RGB")
    w, h = im.size
    small = im.resize((px, max(1, round(px * h / w))), Image.BOX)
    big = small.resize((w, h), Image.BICUBIC).filter(ImageFilter.GaussianBlur(radius=max(2, w // 60)))
    big.save(out)
    print(json.dumps({"width": w, "height": h}))


def main():
    cmd = sys.argv[1]
    if cmd == "blockout":
        blockout(sys.argv[2], sys.argv[3])
    elif cmd == "finish":
        fit = sys.argv[sys.argv.index("--fit") + 1] if "--fit" in sys.argv else None
        finish(sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]), "--cutout" in sys.argv, fit)
    elif cmd == "moodboard":
        moodboard(sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 40)
    elif cmd == "composite":
        composite(sys.argv[2], sys.argv[3])
    else:
        sys.exit(f"unknown command {cmd}")


if __name__ == "__main__":
    main()
