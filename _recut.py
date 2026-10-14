"""Recut from the source photos with a low black threshold.

Only near-black pixels that touch the frame are cleared. Dark clothing stays
because it is a few levels brighter than the backdrop and the flood stops there.
"""

from collections import deque
from pathlib import Path

from PIL import Image

SRC = Path(r"C:\Projects\AllTheCharacters")
PREVIEW = Path(__file__).resolve().parent / "_preview"

JOBS = [
    ("orchestrator", SRC / "Orchestrator" / "Saved_frame_from_Flow_20261013213132.jpg", 4),
    ("pyro-singer", next((SRC / "PyroSinger").glob("*.jpg")), 6),
    ("slice", next((SRC / "Slice").glob("*.jpg")), 10),
    ("not-an-old-man-yet", next((SRC / "NotAnOldManYet").glob("*.jpg")), 4),
    ("future-man", SRC / "FutureMan" / "Cyborg_standing_in_neutral_pose_20261013175410.jpg", 8),
    ("try-belt", next((SRC / "TryBelt").glob("*.jpg")), 4),
]


def cut(path, limit):
    image = Image.open(path).convert("RGB")
    width, height = image.size
    pixels = image.load()
    background = bytearray(width * height)
    queue = deque()

    def dark(x, y):
        red, green, blue = pixels[x, y]
        return red <= limit and green <= limit and blue <= limit

    def consider(x, y):
        index = y * width + x
        if background[index] or not dark(x, y):
            return
        background[index] = 1
        queue.append((x, y))

    for x in range(width):
        consider(x, 0)
        consider(x, height - 1)
    for y in range(height):
        consider(0, y)
        consider(width - 1, y)

    while queue:
        x, y = queue.popleft()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < width and 0 <= ny < height:
                consider(nx, ny)

    cutout = image.convert("RGBA")
    out = cutout.load()
    for y in range(height):
        row = y * width
        for x in range(width):
            if background[row + x]:
                red, green, blue, _alpha = out[x, y]
                out[x, y] = (red, green, blue, 0)

    bbox = cutout.getbbox()
    if not bbox:
        raise RuntimeError(f"empty cutout: {path}")
    pad = 8
    cutout = cutout.crop((
        max(0, bbox[0] - pad),
        max(0, bbox[1] - pad),
        min(width, bbox[2] + pad),
        min(height, bbox[3] + pad),
    ))
    cutout.thumbnail((900, 1100), Image.Resampling.LANCZOS)
    return cutout


def main():
    PREVIEW.mkdir(exist_ok=True)
    images = []
    for name, path, limit in JOBS:
        result = cut(path, limit)
        result.save(PREVIEW / f"{name}.png")
        images.append(result)
        print(name, "limit", limit, result.size)

    cell_w, cell_h, cols = 360, 640, 3
    sheet = Image.new("RGB", (cols * cell_w, 2 * cell_h), (255, 90, 31))
    for index, image in enumerate(images):
        preview = image.copy()
        preview.thumbnail((cell_w - 12, cell_h - 12), Image.Resampling.LANCZOS)
        canvas = Image.new("RGBA", (cell_w, cell_h), (255, 90, 31, 255))
        canvas.paste(
            preview,
            ((cell_w - preview.width) // 2, (cell_h - preview.height) // 2),
            preview,
        )
        sheet.paste(canvas.convert("RGB"), ((index % cols) * cell_w, (index // cols) * cell_h))
    sheet_path = Path(__file__).resolve().parent / "_redo_preview.png"
    sheet.save(sheet_path)
    print("preview", sheet_path)


if __name__ == "__main__":
    main()
