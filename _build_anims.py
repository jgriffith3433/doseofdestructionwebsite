"""Turn short animation clips into the sprite sheets the game plays.

For each fighter, put clips in  <art root>/<Folder>/anims/<clip>.mp4  where
<clip> is one of the names in CLIPS below (idle.mp4, jab.mp4, fair.mp4 ...).
Each clip should show the fighter side-on, facing right, in place, on a flat
plain background. See docs/animation.md for the full guide.

    python _build_anims.py                       # every fighter that has clips
    python _build_anims.py exit-punk kaelen
    python _build_anims.py exit-punk --clip jab  # one clip; the rest stay as built
    python _build_anims.py --src D:/clips        # a different art root

An optional  anims/clips.json  next to the clips trims or tweaks them:

    { "jab": { "start": 1.2, "end": 1.7 }, "idle": { "flip": true } }

Keys per clip: start, end (seconds), flip (the clip faces left), fps,
normalize (scale this clip by its own first frame; on by default for moves),
tolerance (background keying, default 40).

Writes characters/anim/<id>/<clip>.webp and anims.json, refreshes
characters/anim/index.json, and saves a contact sheet per fighter to
_anim_preview/<id>.png for a quick look.
"""

import argparse
import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent
ART_ROOT = Path(r"C:\Projects\AllTheCharacters")
OUT = ROOT / "characters" / "anim"
PREVIEW = ROOT / "_anim_preview"
IDS = {p.stem for p in (ROOT / "characters" / "img").glob("*.png")}

# Every clip the game knows how to play, shared with devtools. Loops repeat;
# the rest play once, and moves are stretched to fit their frame data.
# "unstanding" clips do not start in a normal standing pose, so they keep the
# idle clip's scale instead of measuring their own.
_CLIP_LIST = json.loads((ROOT / "content" / "anim-clips.json").read_text(encoding="utf-8"))
LOOPS = set(_CLIP_LIST["loops"])
ONCE = set(_CLIP_LIST["once"])
MOVES = set(_CLIP_LIST["moves"])
CLIPS = LOOPS | ONCE | MOVES
UNSTANDING = set(_CLIP_LIST["unstanding"])

SOURCE_HEIGHT = 720  # Frames are read at this height before keying.
REF_HEIGHT = 300  # A standing fighter is this many pixels tall in the sheets.
MAX_FRAMES = 24
SHEET_WIDTH = 2048
VIDEO = {".mp4", ".mov", ".webm", ".mkv", ".gif", ".avi"}


def folder_to_id(name):
    """'DJWontRead' -> 'dj-wont-read', 'SSBoulder' -> 'ss-boulder'."""
    words = re.findall(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+", name)
    return "-".join(w.lower() for w in words)


def extract(video, start, end, fps, tmp):
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    if start is not None:
        args += ["-ss", str(start)]
    if end is not None:
        args += ["-to", str(end)]
    args += ["-i", str(video), "-vf", f"fps={fps},scale=-2:{SOURCE_HEIGHT}", str(tmp / "%04d.png")]
    subprocess.run(args, check=True)
    return [Image.open(p).convert("RGB") for p in sorted(tmp.glob("*.png"))]


def background_color(frame):
    """The median of the border pixels: the plain backdrop the clip was shot on."""
    w, h = frame.size
    px = frame.load()
    samples = [px[x, y] for x in range(0, w, 7) for y in (0, 1, h - 2, h - 1)]
    samples += [px[x, y] for y in range(0, h, 7) for x in (0, 1, w - 2, w - 1)]
    return tuple(sorted(c[i] for c in samples)[len(samples) // 2] for i in range(3))


def key(frame, bg, tolerance):
    """Clear backdrop connected to the frame edge; returns RGBA."""
    diff = ImageChops.difference(frame, Image.new("RGB", frame.size, bg))
    r, g, b = diff.split()
    near = ImageChops.lighter(ImageChops.lighter(r, g), b).point(lambda v: 255 if v < tolerance else 0)
    w, h = near.size
    for x in range(0, w, 5):
        for y in (0, h - 1):
            if near.getpixel((x, y)) == 255:
                ImageDraw.floodfill(near, (x, y), 128)
    for y in range(0, h, 5):
        for x in (0, w - 1):
            if near.getpixel((x, y)) == 255:
                ImageDraw.floodfill(near, (x, y), 128)
    alpha = near.point(lambda v: 0 if v == 128 else 255).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))
    out = frame.copy()
    if bg[1] > bg[0] + 40 and bg[1] > bg[2] + 40:
        # Green screen: pull the green spill off the edges.
        r, g, b = out.split()
        g = ImageChops.darker(g, ImageChops.add(ImageChops.lighter(r, b), Image.new("L", out.size, 12)))
        out = Image.merge("RGB", (r, g, b))
    out.putalpha(alpha)
    return out


def solid_box(img):
    return img.getchannel("A").point(lambda v: 255 if v > 64 else 0).getbbox()


def build_clip(name, video, opts, idle_scale):
    loop = name in LOOPS
    fps = opts.get("fps", 15 if loop else 20)
    with tempfile.TemporaryDirectory() as tmp:
        frames = extract(video, opts.get("start"), opts.get("end"), fps, Path(tmp))
    if not frames:
        raise SystemExit(f"{video}: no frames")
    if len(frames) > MAX_FRAMES:
        step = len(frames) / MAX_FRAMES
        frames = [frames[int(i * step)] for i in range(MAX_FRAMES)]

    bg = background_color(frames[0])
    keyed = [key(f, bg, opts.get("tolerance", 40)) for f in frames]
    if opts.get("flip"):
        keyed = [k.transpose(Image.FLIP_LEFT_RIGHT) for k in keyed]

    boxes = [solid_box(k) for k in keyed]
    if not any(boxes):
        raise SystemExit(f"{video}: keying removed everything; try a lower tolerance in clips.json")
    real = [b for b in boxes if b]
    pad = 6
    ux0 = max(0, min(b[0] for b in real) - pad)
    uy0 = max(0, min(b[1] for b in real) - pad)
    ux1 = min(keyed[0].width, max(b[2] for b in real) + pad)
    uy1 = min(keyed[0].height, max(b[3] for b in real) + pad)

    first = next(b for b in boxes if b)
    standing = first[3] - first[1]
    own_scale = REF_HEIGHT / standing
    normalize = opts.get("normalize", name not in UNSTANDING)
    scale = own_scale if (normalize or idle_scale is None) else idle_scale

    fw = max(1, round((ux1 - ux0) * scale))
    fh = max(1, round((uy1 - uy0) * scale))
    cells = [k.crop((ux0, uy0, ux1, uy1)).resize((fw, fh), Image.LANCZOS) for k in keyed]
    # The feet: under the first frame's figure, at the lowest point any frame reaches.
    ax = round(((first[0] + first[2]) / 2 - ux0) * scale)
    ay = round((max(b[3] for b in real) - uy0) * scale)

    cols = max(1, min(len(cells), SHEET_WIDTH // fw))
    rows = math.ceil(len(cells) / cols)
    sheet = Image.new("RGBA", (cols * fw, rows * fh), (0, 0, 0, 0))
    for i, c in enumerate(cells):
        sheet.paste(c, ((i % cols) * fw, (i // cols) * fh))
    meta = {
        "file": f"{name}.webp", "frames": len(cells), "cols": cols, "rows": rows,
        "fw": fw, "fh": fh, "ax": ax, "ay": ay, "fps": fps, "loop": loop,
        # What it was built from, so devtools can tell when a clip is out of date.
        "source": video.name, "sourceMtime": int(video.stat().st_mtime * 1000), "options": opts,
    }
    return sheet, meta, cells, own_scale


def preview_sheet(char_id, clips):
    """First, middle and last frame of every clip, labeled, on a gray card."""
    thumbs = []
    for name, cells in clips.items():
        picks = [cells[0], cells[len(cells) // 2], cells[-1]]
        h = 160
        row = [c.resize((max(1, round(c.width * h / c.height)), h)) for c in picks]
        w = sum(r.width for r in row) + 8 * len(row) + 8
        card = Image.new("RGBA", (max(w, 140), h + 26), (70, 70, 70, 255))
        x = 4
        for r in row:
            card.alpha_composite(r, (x, 22))
            x += r.width + 8
        ImageDraw.Draw(card).text((6, 4), name, fill=(255, 220, 120, 255))
        thumbs.append(card)
    width = max(t.width for t in thumbs)
    out = Image.new("RGBA", (width, sum(t.height + 6 for t in thumbs)), (40, 40, 40, 255))
    y = 0
    for t in thumbs:
        out.alpha_composite(t, (0, y))
        y += t.height + 6
    PREVIEW.mkdir(exist_ok=True)
    out.save(PREVIEW / f"{char_id}.png")


def build_character(char_id, folder, only=None):
    """Build a fighter's clips. With only, rebuild just that clip and keep the rest."""
    clip_dir = folder / "anims"
    opts_all = {}
    if (clip_dir / "clips.json").exists():
        opts_all = json.loads((clip_dir / "clips.json").read_text(encoding="utf-8"))
    sources = {p.stem.lower(): p for p in clip_dir.iterdir() if p.suffix.lower() in VIDEO}
    unknown = sorted(set(sources) - CLIPS)
    if unknown:
        print(f"  skipping unknown clip names: {', '.join(unknown)} (see CLIPS in this script)")
    names = sorted(set(sources) & CLIPS, key=lambda n: (n != "idle", n))
    dest = OUT / char_id
    manifest_path = dest / "anims.json"

    if only:
        if only not in CLIPS:
            raise SystemExit(f"unknown clip: {only}")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else None
        if not manifest:
            manifest = {"refHeight": REF_HEIGHT, "clips": {}}
        dest.mkdir(parents=True, exist_ok=True)
        old = manifest["clips"].pop(only, None)
        if old and (dest / old["file"]).exists():
            (dest / old["file"]).unlink()
        if only in sources:
            idle_scale = manifest.get("idleScale")
            if only != "idle" and idle_scale is None and "idle" in sources:
                _, _, _, idle_scale = build_clip("idle", sources["idle"], opts_all.get("idle", {}), None)
                manifest["idleScale"] = idle_scale
            sheet, meta, _, own_scale = build_clip(only, sources[only], opts_all.get(only, {}), idle_scale)
            if only == "idle":
                manifest["idleScale"] = own_scale
            sheet.save(dest / meta["file"], quality=85, method=6)
            manifest["clips"][only] = meta
            print(f"  {only:10} {meta['frames']:2} frames  {meta['fw']}x{meta['fh']}")
        else:
            print(f"  {only}: no source clip, removed from the game")
        return write_manifest(char_id, manifest)

    if dest.exists():
        shutil.rmtree(dest)
    if not names:
        return False
    dest.mkdir(parents=True)
    manifest = {"refHeight": REF_HEIGHT, "clips": {}}
    previews = {}
    idle_scale = None
    for name in names:
        sheet, meta, cells, own_scale = build_clip(name, sources[name], opts_all.get(name, {}), idle_scale)
        if name == "idle":
            idle_scale = own_scale
            manifest["idleScale"] = own_scale
        sheet.save(dest / meta["file"], quality=85, method=6)
        manifest["clips"][name] = meta
        previews[name] = cells
        print(f"  {name:10} {meta['frames']:2} frames  {meta['fw']}x{meta['fh']}")
    preview_sheet(char_id, previews)
    return write_manifest(char_id, manifest)


def write_manifest(char_id, manifest):
    dest = OUT / char_id
    if not manifest["clips"]:
        if dest.exists():
            shutil.rmtree(dest)
        return False
    # The version busts browser caches, so a rebuilt sheet shows on reload.
    manifest["version"] = int(time.time())
    (dest / "anims.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    return True


def write_index():
    have = {p.parent.name: True for p in OUT.glob("*/anims.json")}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "index.json").write_text(json.dumps(dict(sorted(have.items())), indent=1), encoding="utf-8")
    return have


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("fighters", nargs="*", help="fighter ids, e.g. exit-punk (default: all with clips)")
    parser.add_argument("--src", type=Path, default=ART_ROOT, help="the folder that holds one folder per fighter")
    parser.add_argument("--clip", help="rebuild only this clip (needs exactly one fighter)")
    args = parser.parse_args()
    if args.clip and len(args.fighters) != 1:
        raise SystemExit("--clip needs exactly one fighter id")

    if not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg is not on PATH")
    folders = {folder_to_id(p.name): p for p in args.src.iterdir() if p.is_dir()}
    bad = sorted(set(folders) - IDS)
    if bad:
        print(f"note: folders that do not match a fighter: {', '.join(bad)}")
    wanted = args.fighters or sorted(i for i, p in folders.items() if (p / "anims").is_dir())
    built = []
    for char_id in wanted:
        if char_id not in IDS:
            sys.exit(f"unknown fighter: {char_id}")
        folder = folders.get(char_id)
        if not folder or not (folder / "anims").is_dir():
            print(f"{char_id}: no anims folder, skipped")
            continue
        print(char_id)
        if build_character(char_id, folder, args.clip):
            built.append(char_id)
    have = write_index()
    print(f"built {len(built)} fighter(s); {len(have)} have animations in the game")
    if built and not args.clip:
        print(f"contact sheets: {PREVIEW}")


if __name__ == "__main__":
    main()
