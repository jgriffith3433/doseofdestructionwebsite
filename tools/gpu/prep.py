"""Prepares inputs for the GPU workflows. Called by tools/gpu/jobs.mjs.

    python tools/gpu/prep.py frame <image> <out.png> <width> <height> [fill]
        The image fitted into a width x height frame on flat green, feet near
        the bottom. Transparent cutouts are composited onto the green.
        fill is the share of the frame's height the figure takes (default 0.78).

    python tools/gpu/prep.py motion <video> <out.mp4> <width> <height> <max_frames> [fps]
        A driving video resampled to fps (default 16, the rate Wan makes), fitted
        into the frame and cut to at most max_frames. Prints the frame count.
"""

import json
import subprocess
import sys

from PIL import Image

GREEN = (0, 255, 0)


def frame(src, out, width, height, fill=0.78):
    im = Image.open(src).convert("RGBA")
    box = im.getchannel("A").point(lambda v: 255 if v > 16 else 0).getbbox()
    if box:
        im = im.crop(box)
    scale = min(height * fill / im.height, width * 0.92 / im.width)
    im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
    canvas = Image.new("RGBA", (width, height), (*GREEN, 255))
    bottom = round(height * 0.06)
    canvas.alpha_composite(im, ((width - im.width) // 2, height - bottom - im.height))
    canvas.convert("RGB").save(out)


def motion(src, out, width, height, max_frames, fps=16):
    vf = (
        f"fps={fps},scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black"
    )
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", src, "-vf", vf, "-frames:v", str(max_frames),
         "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", out],
        check=True,
    )
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "json", out],
        check=True, capture_output=True, text=True,
    )
    print(json.loads(probe.stdout)["streams"][0]["nb_read_frames"])


def main():
    cmd = sys.argv[1]
    if cmd == "frame":
        frame(sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]), float(sys.argv[6]) if len(sys.argv) > 6 else 0.78)
    elif cmd == "motion":
        motion(sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6]), int(sys.argv[7]) if len(sys.argv) > 7 else 16)
    else:
        sys.exit(f"unknown command {cmd}")


if __name__ == "__main__":
    main()
