"""Set up every fighter's anims folder for making animation clips.

    python tools/make_anim_folders.py

For each fighter in content/fighters.json, makes <art root>/<Folder>/anims/
with:
  _reference.png        the fighter's clean cutout
  _reference-green.png  the fighter on a 1920x1080 pure green frame, ready to
                        use as the first frame for image-to-video
  CLIPS.txt             every clip to make, its file name, and a prompt

Rerun any time: it refreshes those three files and never touches videos.
The build skips anything that isn't a video, so these files are safe there.
"""

import html
import json
import os
import re
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ART_ROOT = Path(os.environ.get("DOD_ART_ROOT", r"C:\Projects\AllTheCharacters"))
GREEN = (0, 255, 0)

# What each clip shows, for the checklist and the prompt.
WHAT = {
    "idle": "standing in a fighting stance, breathing, ready. A seamless loop",
    "walk": "walking forward, a seamless walk cycle",
    "crouch": "crouching low and holding it",
    "fall": "falling through the air, arms out, a loop",
    "shield": "guarding behind a glowing energy shield, holding it",
    "ledge": "hanging from a ledge by the hands",
    "dizzy": "dazed and wobbling on the spot, a loop",
    "helpless": "tumbling down out of control, a loop",
    "hurt": "knocked back by a hit, reeling, a loop",
    "jumpsquat": "crouching quickly to jump",
    "jump": "jumping straight up",
    "land": "landing from a jump with a small crouch",
    "roll": "rolling forward along the ground",
    "dodge": "a quick sidestep dodge on the spot",
    "airdodge": "a quick twisting dodge in midair",
    "climb": "climbing up over a ledge",
    "jab": "a quick light punch forward",
    "ftilt": "a strong forward strike",
    "utilt": "a strike straight upward",
    "dtilt": "a low sweeping strike along the ground",
    "fsmash": "winding up, then a huge forward smash",
    "usmash": "winding up, then a huge upward smash",
    "dsmash": "a powerful low strike to both sides",
    "nair": "a spinning attack in midair",
    "fair": "a forward strike in midair",
    "bair": "a strike backward behind them in midair",
    "uair": "a strike upward above their head in midair",
    "dair": "a stomping strike downward in midair",
    "upb": "a rising special move that launches them upward",
    "nspecial": "a lunging special attack forward",
}


def folder_to_id(name):
    return "-".join(w.lower() for w in re.findall(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+", name))


def id_to_folder(char_id):
    return "".join(w.capitalize() for w in char_id.split("-"))


def green_frame(cutout):
    """The fighter standing in the middle of a 16:9 green frame, about 70% of its height."""
    frame = Image.new("RGBA", (1920, 1080), (*GREEN, 255))
    fig = cutout.copy()
    fig.thumbnail((1500, 760), Image.LANCZOS)
    frame.alpha_composite(fig, ((1920 - fig.width) // 2, 1080 - 150 - fig.height))
    return frame.convert("RGB")


def looks():
    """Each fighter's visual description, from the roster page."""
    page = (ROOT / "characters.html").read_text(encoding="utf-8")
    found = re.finditer(r'href="/characters/([a-z0-9-]+)\.html".*?<h3>.*?</h3>\s*<p>(.*?)</p>', page, re.S)
    return {m.group(1): html.unescape(m.group(2)).strip() for m in found}


def checklist(f, look, clips, labels):
    lines = [
        f"{f['name']}: animation clips",
        "=" * (len(f["name"]) + 17),
        "",
        "Save each clip in this folder with the file name on the left, then open",
        "Dev Tools > Clips and press Process (or Process all waiting).",
        "",
        "Every clip: side view, facing right, staying in place (the game moves",
        "them), full body in frame, locked camera, plain flat pure green",
        "background (#00FF00), no floor or shadow. Moves 0.5 to 2 seconds; trim",
        "longer takes in Dev Tools. Start moves from the standing pose.",
        "Use _reference-green.png as the first frame for image-to-video.",
        "",
        "Prompt (fill in the action):",
        f"  Full-body side view of {f['name']}: {look}",
        "  Facing right, [ACTION]. Stays in place. Locked camera, no camera",
        "  movement. Plain flat pure green background, no floor, no shadow.",
        "  Even studio lighting.",
        "",
    ]
    for title, names in (("Loops", clips["loops"]), ("One-shots", clips["once"]), ("Moves", clips["moves"])):
        lines.append(f"{title}")
        for n in names:
            lines.append(f"  [ ] {n + '.mp4':15} {labels.get(n, n)}: {WHAT.get(n, '')}")
        lines.append("")
    lines.append("Make idle first: it sets the fighter's size for clips that don't start standing.")
    return "\n".join(lines) + "\n"


def main():
    fighters = json.loads((ROOT / "content" / "fighters.json").read_text(encoding="utf-8"))
    clips = json.loads((ROOT / "content" / "anim-clips.json").read_text(encoding="utf-8"))
    folders = {folder_to_id(p.name): p for p in ART_ROOT.iterdir() if p.is_dir()}
    look = looks()
    for f in fighters:
        folder = folders.get(f["id"]) or ART_ROOT / id_to_folder(f["id"])
        anims = folder / "anims"
        anims.mkdir(parents=True, exist_ok=True)
        cutout_path = ROOT / "characters" / "img" / f"{f['id']}.png"
        if cutout_path.exists():
            cutout = Image.open(cutout_path).convert("RGBA")
            cutout.save(anims / "_reference.png")
            green_frame(cutout).save(anims / "_reference-green.png")
        (anims / "CLIPS.txt").write_text(checklist(f, look.get(f["id"], f["blurb"]), clips, clips["labels"]), encoding="utf-8")
        videos = [p.name for p in anims.iterdir() if p.suffix.lower() in {".mp4", ".mov", ".webm", ".mkv", ".gif", ".avi"}]
        print(f"{f['id']:28} {anims}  ({len(videos)} videos)")


if __name__ == "__main__":
    main()
