"""Histogram of backdrop margins versus the center of the figure."""

from pathlib import Path
from PIL import Image

SRC = Path(r"C:\Projects\AllTheCharacters")
jobs = [
    ("orchestrator", SRC / "Orchestrator" / "Saved_frame_from_Flow_20261013213132.jpg"),
    ("pyro-singer", next((SRC / "PyroSinger").glob("*.jpg"))),
    ("slice", next((SRC / "Slice").glob("*.jpg"))),
    ("not-an-old-man-yet", next((SRC / "NotAnOldManYet").glob("*.jpg"))),
    ("future-man", SRC / "FutureMan" / "Cyborg_standing_in_neutral_pose_20261013175410.jpg"),
    ("try-belt", next((SRC / "TryBelt").glob("*.jpg"))),
]


def bucket(v):
    edges = (0, 2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 255)
    for index, edge in enumerate(edges):
        if v <= edge:
            return index
    return len(edges) - 1


labels = "<=0 <=2 <=4 <=6 <=8 <=12 <=16 <=24 <=32 <=48 <=64 <=96 >96".split()

for name, path in jobs:
    image = Image.open(path).convert("RGB")
    pixels = image.load()
    w, h = image.size
    margin = [0] * len(labels)
    center = [0] * len(labels)
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            r, g, b = pixels[x, y]
            v = max(r, g, b)
            slot = bucket(v)
            if x < w * 0.12 or x > w * 0.88:
                margin[slot] += 1
            elif w * 0.42 <= x <= w * 0.58 and h * 0.15 <= y <= h * 0.92:
                center[slot] += 1
    print(f"\n{name}")
    print("  margin", dict(zip(labels, margin)))
    print("  center", dict(zip(labels, center)))
