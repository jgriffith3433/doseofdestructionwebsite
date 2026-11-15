"""Fringe cleanup, sheet unpack/pack and half-size sheets for tools/smooth-clips.mjs.

Used by the Node orchestrator; needs Pillow. Keep sheets WebP, max side 2048.
"""

from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter

SHEET_MAX = 2048
KEY_GREEN = (0, 255, 0)


def load_manifest(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def save_manifest(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")


def unpack_sheet(sheet: Image.Image, meta: dict) -> list[Image.Image]:
    fw, fh, cols = meta["fw"], meta["fh"], meta["cols"]
    frames = []
    for i in range(meta["frames"]):
        col, row = i % cols, i // cols
        frames.append(sheet.crop((col * fw, row * fh, (col + 1) * fw, (row + 1) * fh)).convert("RGBA"))
    return frames


def pack_frames(frames: list[Image.Image], fw: int | None = None, fh: int | None = None):
    if not frames:
        raise ValueError("no frames")
    if fw is None:
        fw = max(f.width for f in frames)
    if fh is None:
        fh = max(f.height for f in frames)
    sized = []
    for f in frames:
        if f.size != (fw, fh):
            canvas = Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
            canvas.alpha_composite(f, (0, 0))
            sized.append(canvas)
        else:
            sized.append(f)
    cols = max(1, min(len(sized), SHEET_MAX // max(1, fw)))
    rows = math.ceil(len(sized) / cols)
    if cols * fw > SHEET_MAX or rows * fh > SHEET_MAX:
        # Drop frames evenly until it fits.
        while len(sized) > 2 and (math.ceil(len(sized) / cols) * fh > SHEET_MAX or cols * fw > SHEET_MAX):
            step = len(sized) / (len(sized) - 1)
            sized = [sized[int(i * step)] for i in range(len(sized) - 1)]
            cols = max(1, min(len(sized), SHEET_MAX // max(1, fw)))
            rows = math.ceil(len(sized) / cols)
    rows = math.ceil(len(sized) / cols)
    sheet = Image.new("RGBA", (cols * fw, rows * fh), (0, 0, 0, 0))
    for i, cell in enumerate(sized):
        sheet.paste(cell, ((i % cols) * fw, (i // cols) * fh))
    return sheet, len(sized), cols, rows, fw, fh


def erode_alpha(img: Image.Image, px: int = 1) -> Image.Image:
    """Shrink opaque coverage by px (MinFilter)."""
    out = img.copy()
    a = out.getchannel("A")
    for _ in range(max(1, px)):
        a = a.filter(ImageFilter.MinFilter(3))
    out.putalpha(a)
    return out


def decontaminate(img: Image.Image, key: tuple[int, int, int] = KEY_GREEN) -> Image.Image:
    """Push edge RGB away from the key colour (vectorised spill pull + opaque bleed)."""
    r, g, b, a = img.split()
    # Bleed solid colour into partial-alpha pixels so keyed fringe doesn't keep the backdrop tint.
    solid = a.point(lambda v: 255 if v >= 200 else 0)
    # Dilate the solid silhouette one pixel and use it as the colour source.
    bleed = solid.filter(ImageFilter.MaxFilter(3))
    # Where we have solid colour nearby, prefer that RGB; keep current RGB under the solid mask.
    def channel(ch: Image.Image) -> Image.Image:
        # Average of neighbours via blur, then take from solid regions only.
        smeared = ImageChops.multiply(ch, solid).filter(ImageFilter.BoxBlur(1))
        # Re-normalising blur is approximate; fall back to spill-fixed original under no solid.
        return Image.composite(ch, ImageChops.lighter(ch, smeared), solid)

    r2, g2, b2 = channel(r), channel(g), channel(b)
    # Green-screen spill: clamp G toward max(R, B) everywhere the pixel isn't fully opaque.
    if key[1] > key[0] + 40 and key[1] > key[2] + 40:
        lim = ImageChops.add(ImageChops.lighter(r2, b2), Image.new("L", img.size, 6))
        g2 = ImageChops.darker(g2, lim)
    edge = a.point(lambda v: 255 if 0 < v < 255 else 0)
    r = Image.composite(r2, r, edge)
    g = Image.composite(g2, g, edge)
    b = Image.composite(b2, b, edge)
    out = Image.merge("RGBA", (r, g, b, a))
    return out


def feather_alpha(img: Image.Image, px: int = 1) -> Image.Image:
    out = img.copy()
    a = out.getchannel("A")
    # Soften the edge without growing a key-coloured halo past the eroded silhouette.
    radius = 0.7 * max(1, px)
    soft = a.filter(ImageFilter.GaussianBlur(radius))
    mask = a.point(lambda v: 255 if v > 0 else 0)
    out.putalpha(ImageChops.multiply(soft, mask))
    return out


def fringe_clean(img: Image.Image) -> Image.Image:
    """Erode 1 px → decontaminate edge colour → feather 1 px."""
    return feather_alpha(decontaminate(erode_alpha(img, 1)), 1)


def half_sheet(sheet: Image.Image) -> Image.Image:
    w, h = sheet.size
    return sheet.resize((max(1, w // 2), max(1, h // 2)), Image.LANCZOS)


def save_webp(img: Image.Image, path: Path) -> None:
    img.save(path, "WEBP", quality=85, method=4)


def composite_green(frames: list[Image.Image]) -> list[Image.Image]:
    out = []
    for f in frames:
        bg = Image.new("RGBA", f.size, (*KEY_GREEN, 255))
        bg.alpha_composite(f)
        out.append(bg.convert("RGB"))
    return out


def write_png_sequence(frames: list[Image.Image], folder: Path) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    for i, f in enumerate(frames):
        f.save(folder / f"{i:04d}.png")


def encode_mp4(png_dir: Path, fps: float, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    # libx264 needs even width/height; pad with key green if a cell is odd.
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-framerate", str(fps),
            "-i", str(png_dir / "%04d.png"),
            "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:color=0x00FF00",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
            str(out),
        ],
        check=True,
    )


def key_green_frame(frame: Image.Image, tolerance: int = 40) -> Image.Image:
    """Key a flat green backdrop to alpha (edge-connected)."""
    rgb = frame.convert("RGB")
    w, h = rgb.size
    bg = KEY_GREEN
    diff = ImageChops.difference(rgb, Image.new("RGB", (w, h), bg))
    r, g, b = diff.split()
    near = ImageChops.lighter(ImageChops.lighter(r, g), b).point(lambda v: 255 if v < tolerance else 0)
    from PIL import ImageDraw

    marked = near.copy()
    for x in range(0, w, 2):
        for y in (0, h - 1):
            if marked.getpixel((x, y)) == 255:
                ImageDraw.floodfill(marked, (x, y), 128)
    for y in range(0, h, 2):
        for x in (0, w - 1):
            if marked.getpixel((x, y)) == 255:
                ImageDraw.floodfill(marked, (x, y), 128)
    region = marked.point(lambda v: 255 if v == 128 else 0)
    alpha = ImageChops.invert(region)
    out = rgb.copy()
    # Spill pull.
    rr, gg, bb = out.split()
    gg = ImageChops.darker(gg, ImageChops.add(ImageChops.lighter(rr, bb), Image.new("L", out.size, 12)))
    out = Image.merge("RGB", (rr, gg, bb))
    out.putalpha(alpha)
    return out


def extract_video_frames(video: Path, fps: float | None, tmp: Path) -> list[Image.Image]:
    tmp.mkdir(parents=True, exist_ok=True)
    for p in tmp.glob("*.png"):
        p.unlink()
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(video)]
    if fps:
        args += ["-vf", f"fps={fps}"]
    args.append(str(tmp / "%04d.png"))
    subprocess.run(args, check=True)
    return [Image.open(p).convert("RGBA") for p in sorted(tmp.glob("*.png"))]


def fringe_clean_sheet(fighter_dir: Path, clip: str, make_half: bool = True) -> dict:
    """Fringe-clean one existing sheet in place; keep frame count, layout and fps."""
    manifest_path = fighter_dir / "anims.json"
    data = load_manifest(manifest_path)
    meta = data["clips"][clip]
    sheet = Image.open(fighter_dir / meta["file"]).convert("RGBA")
    fw, fh, cols, rows = meta["fw"], meta["fh"], meta["cols"], meta["rows"]
    frames = [fringe_clean(f) for f in unpack_sheet(sheet, meta)]
    if len(frames) != meta["frames"]:
        raise SystemExit(f"{clip}: unpack got {len(frames)} frames, manifest says {meta['frames']}")
    # Paste into the original grid so packing never drops frames (wide sheets stay as-authored).
    packed = Image.new("RGBA", (cols * fw, rows * fh), (0, 0, 0, 0))
    for i, cell in enumerate(frames):
        if cell.size != (fw, fh):
            canvas = Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
            canvas.alpha_composite(cell, (0, 0))
            cell = canvas
        packed.paste(cell, ((i % cols) * fw, (i // cols) * fh))
    save_webp(packed, fighter_dir / meta["file"])
    half_name = meta["file"].replace(".webp", ".half.webp")
    if make_half:
        save_webp(half_sheet(packed), fighter_dir / half_name)
        meta["halfFile"] = half_name
    meta["fringe"] = True
    data["clips"][clip] = meta
    data["version"] = int(data.get("version") or 0) + 1
    save_manifest(manifest_path, data)
    return meta


def prepare_source_video(fighter_dir: Path, clip: str, out_mp4: Path, work: Path) -> dict:
    """Unpack a sheet, composite on green, encode an mp4 at the clip's fps."""
    data = load_manifest(fighter_dir / "anims.json")
    meta = data["clips"][clip]
    sheet = Image.open(fighter_dir / meta["file"]).convert("RGBA")
    frames = unpack_sheet(sheet, meta)
    greened = composite_green(frames)
    seq = work / "seq"
    write_png_sequence(greened, seq)
    encode_mp4(seq, float(meta["fps"]), out_mp4)
    return {"fighter": fighter_dir.name, "clip": clip, "fps": meta["fps"], "frames": meta["frames"], "video": str(out_mp4)}


def pack_interpolated(
    fighter_dir: Path,
    clip: str,
    video: Path,
    target_fps: float = 30.0,
    work: Path | None = None,
) -> dict:
    """Key + fringe-clean an interpolated video and write the sheet at target_fps."""
    from tempfile import TemporaryDirectory

    data = load_manifest(fighter_dir / "anims.json")
    old = data["clips"][clip]
    with TemporaryDirectory() as td:
        raw = extract_video_frames(video, target_fps, Path(td) / "raw")
        keyed = [fringe_clean(key_green_frame(f)) for f in raw]
        if not keyed:
            raise SystemExit(f"{video}: no frames")
        # Drop a duplicated loop wrap frame.
        if old.get("loop") and len(keyed) > 2:
            a = keyed[0].resize((32, 32)).convert("L")
            b = keyed[-1].resize((32, 32)).convert("L")
            if sum(abs(x - y) for x, y in zip(a.getdata(), b.getdata())) / (32 * 32) < 8:
                keyed = keyed[:-1]
        # Short sources (1–2 frame idles) barely grow under FILM: hold-duplicate so the
        # clip keeps a sensible loop length at target_fps instead of flashing.
        # Prefer the interpolated video's own duration (ffprobe); fall back to the
        # pre-smooth frame count when the manifest was already rewritten at 30 fps.
        duration = None
        try:
            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=noprint_wrappers=1:nokey=1", str(video)],
                check=True, capture_output=True, text=True,
            ).stdout.strip()
            duration = float(probe)
        except (ValueError, subprocess.CalledProcessError, OSError):
            duration = None
        if duration is None or duration < 0.05:
            old_fps = float(old.get("fps") or 15)
            old_n = int(old.get("frames") or len(keyed))
            duration = old_n / max(0.1, old_fps)
        # Near-static idles (FILM can't invent motion from 1–3 frames): hold to ~1 s at 30 fps
        # so the loop doesn't flash. Longer clips keep their real duration.
        if old.get("loop") and len(keyed) <= 4:
            duration = max(duration, 1.0)
        want_n = max(len(keyed), int(round(duration * target_fps)))
        want_n = min(want_n, 48)
        if len(keyed) < want_n:
            held = []
            for i in range(want_n):
                held.append(keyed[min(len(keyed) - 1, i * len(keyed) // want_n)])
            keyed = held
        # Fit to same cell aspect as before when possible: use union bbox.
        boxes = [f.getchannel("A").point(lambda v: 255 if v > 16 else 0).getbbox() for f in keyed]
        real = [b for b in boxes if b]
        if not real:
            raise SystemExit(f"{video}: keying removed everything")
        pad = 4
        ux0 = max(0, min(b[0] for b in real) - pad)
        uy0 = max(0, min(b[1] for b in real) - pad)
        ux1 = min(keyed[0].width, max(b[2] for b in real) + pad)
        uy1 = min(keyed[0].height, max(b[3] for b in real) + pad)
        # Keep the fighter at the previous frame height so gameplay scale stays stable.
        crop_h = max(1, uy1 - uy0)
        scale = old["fh"] / crop_h
        fw = max(1, round((ux1 - ux0) * scale))
        fh = max(1, round(crop_h * scale))
        # Cap width so a row still fits under 2048.
        if fw > SHEET_MAX:
            s = SHEET_MAX / fw
            fw = SHEET_MAX
            fh = max(1, round(fh * s))
            scale *= s
        cells = [k.crop((ux0, uy0, ux1, uy1)).resize((fw, fh), Image.LANCZOS) for k in keyed]
        # Cap frame count to what fits in 2048.
        cols = max(1, min(len(cells), SHEET_MAX // fw))
        max_frames = cols * (SHEET_MAX // fh)
        if len(cells) > max_frames:
            step = len(cells) / max_frames
            cells = [cells[int(i * step)] for i in range(max_frames)]
        first_box = boxes[0] or real[0]
        ax = round(((first_box[0] + first_box[2]) / 2 - ux0) * scale)
        ay = round((max(b[3] for b in real) - uy0) * scale)
        packed, n, cols, rows, fw, fh = pack_frames(cells, fw, fh)
        save_webp(packed, fighter_dir / old["file"])
        half_name = old["file"].replace(".webp", ".half.webp")
        save_webp(half_sheet(packed), fighter_dir / half_name)
        meta = dict(old)
        meta.update({
            "frames": n, "cols": cols, "rows": rows, "fw": fw, "fh": fh,
            "ax": ax, "ay": ay, "fps": target_fps, "halfFile": half_name,
            "fringe": True, "smoothed": True, "source": video.name,
        })
        # feet / stride go stale; fit-feet.mjs refreshes them.
        for k in ("feet", "stride", "travel", "slip"):
            meta.pop(k, None)
        data["clips"][clip] = meta
        data["version"] = int(data.get("version") or 0) + 1
        save_manifest(fighter_dir / "anims.json", data)
        return meta


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: smooth_clips_lib.py fringe|prepare|pack ...", file=sys.stderr)
        return 2
    cmd = argv[1]
    if cmd == "fringe":
        # fringe <fighter_dir> <clip>
        fringe_clean_sheet(Path(argv[2]), argv[3])
        return 0
    if cmd == "prepare":
        # prepare <fighter_dir> <clip> <out.mp4> <work_dir>
        info = prepare_source_video(Path(argv[2]), argv[3], Path(argv[4]), Path(argv[5]))
        print(json.dumps(info))
        return 0
    if cmd == "pack":
        # pack <fighter_dir> <clip> <video> [fps]
        fps = float(argv[5]) if len(argv) > 5 else 30.0
        meta = pack_interpolated(Path(argv[2]), argv[3], Path(argv[4]), fps)
        print(json.dumps({"frames": meta["frames"], "fps": meta["fps"], "fw": meta["fw"], "fh": meta["fh"]}))
        return 0
    print(f"unknown command {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
