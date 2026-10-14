"""Recut dark outfits with a stricter black threshold."""

from collections import deque
from pathlib import Path

from PIL import Image

SRC = Path(r"C:\Projects\AllTheCharacters")
OUT = Path(__file__).resolve().parent / "characters" / "img"

JOBS = [
    ("orchestrator", SRC / "Orchestrator" / "Saved_frame_from_Flow_20261013213132.jpg"),
    ("pyro-singer", next((SRC / "PyroSinger").glob("*.jpg"))),
    ("slice", next((SRC / "Slice").glob("*.jpg"))),
    ("not-an-old-man-yet", next((SRC / "NotAnOldManYet").glob("*.jpg"))),
    ("future-man", SRC / "FutureMan" / "Cyborg_standing_in_neutral_pose_20261013175410.jpg"),
    ("try-belt", next((SRC / "TryBelt").glob("*.jpg"))),
]

# Only pixels at or next to pure black, and touching the frame, count as background.
# Dark cloth is a few levels brighter and has to stay.
LIMIT = 1


def cut(path):
    image = Image.open(path).convert("RGB")
    width, height = image.size
    pixels = image.load()
    background = bytearray(width * height)

    def dark(x, y):
        red, green, blue = pixels[x, y]
        return red <= LIMIT and green <= LIMIT and blue <= LIMIT

    queue = deque()
    for x in range(width):
        for y in (0, height - 1):
            if dark(x, y):
                background[y * width + x] = 1
                queue.append((x, y))
    for y in range(height):
        for x in (0, width - 1):
            index = y * width + x
            if dark(x, y) and not background[index]:
                background[index] = 1
                queue.append((x, y))

    while queue:
        x, y = queue.popleft()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if nx < 0 or ny < 0 or nx >= width or ny >= height:
                continue
            index = ny * width + nx
            if background[index] or not dark(nx, ny):
                continue
            background[index] = 1
            queue.append((nx, ny))

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
    pad = 12
    left = max(0, bbox[0] - pad)
    top = max(0, bbox[1] - pad)
    right = min(width, bbox[2] + pad)
    bottom = min(height, bbox[3] + pad)
    cutout = cutout.crop((left, top, right, bottom))
    cutout.thumbnail((1200, 1400), Image.Resampling.LANCZOS)
    return tighten(cutout)


def tighten(image, pad=64):
    """Drop the smooth studio halo outside the body, without touching the outfit."""
    pixels = image.load()
    width, height = image.size
    xs = []
    ys = []
    for y in range(height):
        for x in range(width):
            red, green, blue, alpha = pixels[x, y]
            if alpha < 16:
                continue
            if max(red, green, blue) - min(red, green, blue) > 18 or max(red, green, blue) > 90:
                xs.append(x)
                ys.append(y)
    if not xs:
        return image
    left = max(0, min(xs) - pad)
    top = max(0, min(ys) - pad)
    right = min(width, max(xs) + pad + 1)
    bottom = min(height, max(ys) + pad + 1)
    for y in range(height):
        for x in range(width):
            if left <= x < right and top <= y < bottom:
                continue
            red, green, blue, alpha = pixels[x, y]
            if alpha:
                pixels[x, y] = (red, green, blue, 0)
    bbox = image.getbbox()
    if not bbox:
        return image
    edge = 8
    return image.crop((
        max(0, bbox[0] - edge),
        max(0, bbox[1] - edge),
        min(width, bbox[2] + edge),
        min(height, bbox[3] + edge),
    ))


def main():
    images = []
    for name, path in JOBS:
        result = cut(path)
        dest = OUT / f"{name}.png"
        result.save(dest, "PNG", optimize=True)
        images.append(result)
        print(name, result.size, dest.name)

    cell_w, cell_h, cols = 360, 640, 3
    sheet = Image.new("RGB", (cols * cell_w, 2 * cell_h), (255, 90, 31))
    for index, image in enumerate(images):
        preview = image.copy()
        preview.thumbnail((cell_w - 16, cell_h - 16), Image.Resampling.LANCZOS)
        canvas = Image.new("RGBA", (cell_w, cell_h), (255, 90, 31, 255))
        canvas.paste(preview, ((cell_w - preview.width) // 2, cell_h - preview.height - 8), preview)
        sheet.paste(canvas.convert("RGB"), ((index % cols) * cell_w, (index // cols) * cell_h))
    sheet_path = Path(__file__).resolve().parent / "_redo_preview.png"
    sheet.save(sheet_path)
    print("preview", sheet_path)


if __name__ == "__main__":
    main()
