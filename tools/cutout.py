"""Cut fighters out of their source art with a segmentation model.

Threshold keying can't tell a black coat from a black backdrop; a model can.
Runs in the project's .venv, which has rembg:

    .venv\\Scripts\\python tools\\cutout.py                  # every fighter
    .venv\\Scripts\\python tools\\cutout.py slice susan      # just these
    .venv\\Scripts\\python tools\\cutout.py slice --mode isnet
    .venv\\Scripts\\python tools\\cutout.py --out some/dir  # preview elsewhere

Source images and modes come from content/art-sources.json:
  birefnet  BiRefNet: the cleanest edges and solid dark clothing (default)
  isnet     ISNet: softer, keeps wisps but can let some backdrop through
  union     both masks combined, for wispy edges that fade into the backdrop

Masks are cached in .cache/cutout/, so switching modes is quick. The previous
cutout is backed up to _backup/art/ before it is replaced. Run
_build_lineup.py afterwards to refresh the thumbnails, large images and lineup.
"""

import argparse
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ART_ROOT = Path(os.environ.get("DOD_ART_ROOT", r"C:\Projects\AllTheCharacters"))
CACHE = ROOT / ".cache" / "cutout"
BACKUP = ROOT / "_backup" / "art"
MODELS = {"birefnet": "birefnet-general", "isnet": "isnet-general-use"}
_sessions = {}


def folder_to_id(name):
    return "-".join(w.lower() for w in re.findall(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+", name))


def mask(model, char_id, source):
    """The model's alpha mask for a source image, cached by the source's mtime."""
    cached = CACHE / model / f"{char_id}.png"
    stamp = cached.with_suffix(".txt")
    key = f"{source.name}|{int(source.stat().st_mtime)}"
    if cached.exists() and stamp.exists() and stamp.read_text(encoding="utf-8") == key:
        return Image.open(cached).convert("L")
    from rembg import new_session, remove

    if model not in _sessions:
        _sessions[model] = new_session(MODELS[model])
    t = time.time()
    m = remove(Image.open(source).convert("RGB"), session=_sessions[model], only_mask=True)
    cached.parent.mkdir(parents=True, exist_ok=True)
    m.save(cached)
    stamp.write_text(key, encoding="utf-8")
    print(f"    {model} mask in {time.time() - t:.0f}s", flush=True)
    return m


def cut(char_id, source, mode):
    img = Image.open(source).convert("RGB")
    if mode == "union":
        a = ImageChops.lighter(mask("birefnet", char_id, source), mask("isnet", char_id, source))
    else:
        a = mask(mode, char_id, source)
    a = a.resize(img.size, Image.BILINEAR)
    # Drop the faint haze a model leaves in empty backdrop.
    a = a.point(lambda v: 0 if v < 10 else v)
    out = img.convert("RGBA")
    out.putalpha(a)
    box = a.point(lambda v: 255 if v > 40 else 0).filter(ImageFilter.MaxFilter(5)).getbbox()
    if box:
        pad = 16
        out = out.crop((max(0, box[0] - pad), max(0, box[1] - pad), min(out.width, box[2] + pad), min(out.height, box[3] + pad)))
    return out


def main():
    parser = argparse.ArgumentParser(description="Cut fighters out of their source art.")
    parser.add_argument("fighters", nargs="*")
    parser.add_argument("--mode", choices=["birefnet", "isnet", "union"], help="override art-sources.json")
    parser.add_argument("--out", type=Path, default=ROOT / "characters" / "img")
    parser.add_argument("--file", help="use this image from the fighter's art folder, and remember it")
    args = parser.parse_args()

    sources_path = ROOT / "content" / "art-sources.json"
    raw = json.loads(sources_path.read_text(encoding="utf-8"))
    if args.file:
        if len(args.fighters) != 1:
            sys.exit("--file needs exactly one fighter")
        raw.setdefault(args.fighters[0], {})["file"] = args.file
        if args.mode:
            raw[args.fighters[0]]["mode"] = args.mode
        sources_path.write_text(json.dumps(raw, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    sources = {k: v for k, v in raw.items() if not k.startswith("_")}
    folders = {folder_to_id(p.name): p for p in ART_ROOT.iterdir() if p.is_dir()}
    wanted = args.fighters or sorted(sources)
    live = args.out.resolve() == (ROOT / "characters" / "img").resolve()
    args.out.mkdir(parents=True, exist_ok=True)
    for char_id in wanted:
        if char_id not in sources:
            sys.exit(f"{char_id} is not in content/art-sources.json")
        entry = sources[char_id]
        source = folders[char_id] / entry["file"]
        if not source.exists():
            sys.exit(f"{char_id}: {source} does not exist")
        mode = args.mode or entry.get("mode", "birefnet")
        print(f"{char_id} ({mode})", flush=True)
        out = cut(char_id, source, mode)
        dest = args.out / f"{char_id}.png"
        if live and dest.exists():
            BACKUP.mkdir(parents=True, exist_ok=True)
            shutil.copy2(dest, BACKUP / f"{char_id}-{int(time.time())}.png")
        out.save(dest)
    print(f"wrote {len(wanted)} cutout(s) to {args.out}")


if __name__ == "__main__":
    main()
