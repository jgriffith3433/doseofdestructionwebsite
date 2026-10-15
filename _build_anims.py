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

Keys per clip: start, end (seconds; without them, one-shots and moves are
trimmed to where the motion is, see still_ends), autotrim (false keeps the whole video), speed (playback speed: 2 is twice as
fast; default from content/anim-clips.json "speed", else 1), flip (the clip faces left), fps,
normalize (scale this clip by its own first frame; on by default for moves),
size (a multiplier on top of that: 1.1 is 10% bigger; "auto" sizes the clip so the
fighter matches their standing reference, see auto_size), tolerance (background keying, default 40).

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
# Wan moves at a real-life pace; a clip can play faster (or slower) than it was made.
SPEED = _CLIP_LIST.get("speed", {})
# The pose each clip starts on (Standing is the side view, anims/_side.png).
START_POSE = {k: v[0] for k, v in _CLIP_LIST.get("frames", {}).items() if isinstance(v, list) and v}

SOURCE_HEIGHT = 720  # Frames are read at this height before keying.
REF_HEIGHT = 300  # A standing fighter is this many pixels tall in the sheets.
MAX_FRAMES = 24
SHEET_WIDTH = 2048
VIDEO = {".mp4", ".mov", ".webm", ".mkv", ".gif", ".avi"}


def folder_to_id(name):
    """'DJWontRead' -> 'dj-wont-read', 'SSBoulder' -> 'ss-boulder'."""
    words = re.findall(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+", name)
    return "-".join(w.lower() for w in words)


def extract(video, start, end, fps, tmp, speed=1.0):
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    if start is not None:
        args += ["-ss", str(start)]
    if end is not None:
        args += ["-to", str(end)]
    # The trim is in the video's own seconds; speed then retimes what's left.
    retime = f"setpts=PTS/{speed}," if speed != 1 else ""
    args += ["-i", str(video), "-vf", f"{retime}fps={fps},scale=-2:{SOURCE_HEIGHT}", str(tmp / "%04d.png")]
    subprocess.run(args, check=True)
    return [Image.open(p).convert("RGB") for p in sorted(tmp.glob("*.png"))]


def background_color(frame):
    """The median of the border pixels: the plain backdrop the clip was shot on."""
    w, h = frame.size
    px = frame.load()
    samples = [px[x, y] for x in range(0, w, 7) for y in (0, 1, h - 2, h - 1)]
    samples += [px[x, y] for y in range(0, h, 7) for x in (0, 1, w - 2, w - 1)]
    return tuple(sorted(c[i] for c in samples)[len(samples) // 2] for i in range(3))


def key(frame, bg, tolerance, k=3):
    """Clear backdrop connected to the frame edge; returns RGBA."""
    diff = ImageChops.difference(frame, Image.new("RGB", frame.size, bg))
    r, g, b = diff.split()
    near = ImageChops.lighter(ImageChops.lighter(r, g), b).point(lambda v: 255 if v < tolerance else 0)
    w, h = near.size
    # Pillow's flood fill is pure Python, so flood the backdrop on a third-size copy (a block
    # counts only when nearly all of it is backdrop), then grow it back out at full size along
    # backdrop pixels so the edges are exact. About 5x faster; the same cutout to within 0.2%.
    small = near.resize((max(1, w // k), max(1, h // k)), Image.BOX).point(lambda v: 255 if v > 200 else 0)
    sw, sh = small.size
    for x in range(0, sw, 2):
        for y in (0, sh - 1):
            if small.getpixel((x, y)) == 255:
                ImageDraw.floodfill(small, (x, y), 128)
    for y in range(0, sh, 2):
        for x in (0, sw - 1):
            if small.getpixel((x, y)) == 255:
                ImageDraw.floodfill(small, (x, y), 128)
    region = small.point(lambda v: 255 if v == 128 else 0).resize((w, h), Image.NEAREST)
    region = ImageChops.multiply(region, near)
    for _ in range(k + 2):
        region = ImageChops.multiply(region.filter(ImageFilter.MaxFilter(3)), near)
    alpha = ImageChops.invert(region).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))
    out = frame.copy()
    if bg[1] > bg[0] + 40 and bg[1] > bg[2] + 40:
        # Green screen: pull the green spill off the edges.
        r, g, b = out.split()
        g = ImageChops.darker(g, ImageChops.add(ImageChops.lighter(r, b), Image.new("L", out.size, 12)))
        out = Image.merge("RGB", (r, g, b))
    out.putalpha(alpha)
    return out


def drop_specks(img, k=4, reach=12):
    """Clears stray bits of backdrop the keying left far from the fighter (a corner pixel,
    a speck of noise): they would count as part of the figure and throw its size off.
    Keeps everything within about k*reach pixels of the solid body, thin parts included."""
    a = img.getchannel("A").point(lambda v: 255 if v > 64 else 0)
    w, h = a.size
    small = a.resize((max(1, w // k), max(1, h // k)), Image.BOX).point(lambda v: 255 if v > 128 else 0)
    body = small.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
    if not body.getbbox():
        return img
    keep = body.filter(ImageFilter.MaxFilter(2 * (reach // 2) + 1)).resize((w, h), Image.NEAREST)
    out = img.copy()
    out.putalpha(ImageChops.multiply(img.getchannel("A"), keep))
    return out


def solid_box(img):
    return img.getchannel("A").point(lambda v: 255 if v > 64 else 0).getbbox()


def still_ends(frames, pad=2, share=0.25):
    """The first and last frame worth keeping: where the motion starts and stops.

    Generated clips often hold their first pose, move, then hold the last. The
    game squeezes a one-shot into a few frames (a landing is 4), so the holds
    are all anyone would see. A frame counts as moving when it differs from
    the one before by more than `share` of the clip's biggest change.
    """
    # The figure's silhouette (far from the corner's backdrop color): background noise doesn't count.
    def silhouette(f):
        small = f.resize((80, 80))
        bg = small.getpixel((1, 1))
        return ImageChops.difference(small, Image.new("RGB", small.size, bg)).convert("L").point(lambda v: 255 if v > 60 else 0)
    masks = [silhouette(f) for f in frames]
    raw = [sum(ImageChops.difference(a, b).histogram()[255:]) for a, b in zip(masks, masks[1:])]
    # Resampled clips repeat a frame now and then; judge each step with its neighbor.
    steps = [max(raw[max(0, i - 1):i + 2]) for i in range(len(raw))]
    if not steps or max(steps) == 0:
        return 0, len(frames) - 1
    moving = [i for i, s in enumerate(steps) if s > max(steps) * share]
    first = max(0, moving[0] - pad)
    last = min(len(frames) - 1, moving[-1] + 1 + pad)
    # Never trim to almost nothing.
    if last - first < 6:
        return 0, len(frames) - 1
    return first, last


def figure_height(img):
    """The keyed figure's height as a share of the image height, or None."""
    img = img.convert("RGB")
    box = solid_box(drop_specks(key(img, background_color(img), 40)))
    return (box[3] - box[1]) / img.height if box else None


def auto_size(video, folder, name, base_scale):
    """The size multiplier that makes this clip's fighter as big as their standing reference.

    Each clip starts on a pose image (content/anim-clips.json "frames"), and the
    pose images share the side view's framing. The video's first frame is that
    pose, so comparing the two gives how far the video zoomed; the side view then
    says how tall standing is at that zoom. Returns (multiplier, how), or (None, why not).
    """
    anims = folder / "anims"
    pose = START_POSE.get(name, "stand")
    recipe = anims / "_recipes" / f"{name}.json"
    if recipe.exists():
        try:
            frames = json.loads(recipe.read_text(encoding="utf-8")).get("frames")
            if isinstance(frames, list) and frames:
                pose = frames[0]
        except (ValueError, OSError):
            pass
    side = anims / "_side.png"
    pose_img = side if pose == "stand" else folder / "poses" / f"{pose}.png"
    if not side.exists() or not pose_img.exists():
        return None, f"no {pose} pose image"
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "first.png"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(video), "-frames:v", "1",
                        "-vf", f"scale=-2:{SOURCE_HEIGHT}", str(out)], check=True)
        first = Image.open(out).convert("RGB")
    stand_h = figure_height(Image.open(side))
    pose_h = pose_img == side and stand_h or figure_height(Image.open(pose_img))
    video_h = figure_height(first)
    if not stand_h or not pose_h or not video_h:
        return None, "couldn't find the fighter"
    # The standing height, in this video's (720-high) pixels.
    standing = stand_h * (video_h / pose_h) * first.height
    return round((REF_HEIGHT / standing) / base_scale, 3), pose


def same_frame(a, b, tolerance=6.0):
    """Whether two frames look the same: mean difference of small greyscale copies, out of 255."""
    small = (64, 64)
    pa = Image.open(a).convert("L").resize(small) if not isinstance(a, Image.Image) else a.convert("L").resize(small)
    pb = Image.open(b).convert("L").resize(small) if not isinstance(b, Image.Image) else b.convert("L").resize(small)
    da, db = pa.getdata(), pb.getdata()
    return sum(abs(x - y) for x, y in zip(da, db)) / len(da) < tolerance


def build_clip(name, video, opts, idle_scale, folder=None):
    loop = name in LOOPS
    fps = opts.get("fps", 15 if loop else 20)
    speed = max(0.25, min(4.0, float(opts.get("speed", SPEED.get(name, 1)))))
    with tempfile.TemporaryDirectory() as tmp:
        frames = extract(video, opts.get("start"), opts.get("end"), fps, Path(tmp), speed)
    if not frames:
        raise SystemExit(f"{video}: no frames")
    # One-shots and moves keep just the motion, unless trimmed by hand.
    trimmed = None
    if not loop and opts.get("start") is None and opts.get("end") is None and opts.get("autotrim", True):
        first, last = still_ends(frames)
        if first > 0 or last < len(frames) - 1:
            trimmed = [round(first / fps, 2), round(last / fps, 2)]
            frames = frames[first:last + 1]
    # A loop made start-to-end on one pose ends on (nearly) its first frame;
    # showing both would hold that pose twice each time round.
    if loop and len(frames) > 2 and same_frame(frames[0], frames[-1]):
        frames = frames[:-1]
    if len(frames) > MAX_FRAMES:
        step = len(frames) / MAX_FRAMES
        frames = [frames[int(i * step)] for i in range(MAX_FRAMES)]

    bg = background_color(frames[0])
    keyed = [drop_specks(key(f, bg, opts.get("tolerance", 40))) for f in frames]
    if opts.get("flip"):
        keyed = [k.transpose(Image.FLIP_LEFT_RIGHT) for k in keyed]

    # A move's strike: the frame whose silhouette is furthest from the first (full extension).
    # The game plays the clip so this frame lands on the move's first active frame.
    hit = None
    if name in MOVES and len(keyed) > 2:
        first_shape = keyed[0].getchannel("A").resize((64, 64))
        reach = [sum(ImageChops.difference(first_shape, k.getchannel("A").resize((64, 64))).histogram()[128:]) for k in keyed]
        hit = opts.get("hit", max(range(len(reach)), key=lambda i: reach[i]))

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
    # Size: by hand (a multiplier), or worked out from the reference (auto).
    auto, auto_from = auto_size(video, folder, name, scale) if folder else (None, None)
    want = opts.get("size", 1)
    size = auto if want == "auto" and auto else want if isinstance(want, (int, float)) and want > 0 else 1
    size = max(0.25, min(4.0, float(size)))
    scale *= size

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
        "source": video.name, "sourceMtime": int(video.stat().st_mtime * 1000), "options": opts, "speed": speed, "autoTrim": trimmed, "hit": hit,
        "size": size, "autoSize": auto, "autoSizeFrom": auto_from,
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
            sheet, meta, _, own_scale = build_clip(only, sources[only], opts_all.get(only, {}), idle_scale, folder)
            if only == "idle":
                manifest["idleScale"] = own_scale
            sheet.save(dest / meta["file"], quality=85, method=4)
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
        sheet, meta, cells, own_scale = build_clip(name, sources[name], opts_all.get(name, {}), idle_scale, folder)
        if name == "idle":
            idle_scale = own_scale
            manifest["idleScale"] = own_scale
        sheet.save(dest / meta["file"], quality=85, method=4)
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
