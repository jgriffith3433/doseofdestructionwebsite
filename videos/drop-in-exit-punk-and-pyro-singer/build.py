#!/usr/bin/env python3
"""Drop In: renders every shot (Pillow + numpy -> ffmpeg), then mixes the song, voices and sfx.
Usage: PYTHONPATH=/tmp/pylib python3 build.py <workdir> [scale=1.0] [only=shot,names]
Inputs in <workdir>: plate.png (Rainbow Full Pipe reference), clips/*.rgba (keyed DoD clips, 640x640 16 fps),
portraits/*.png and portraits/*.mp4 (image.edit stills, video.i2v motion), aud/*.mp3 (song + voices).
All times are cut seconds; the song starts at 1.2 s (118 bpm, bar = 2.034 s)."""
import sys, os, math, random, subprocess, json
from multiprocessing import Pool
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops

W0, H0 = 1920, 1080
WD = sys.argv[1] if len(sys.argv) > 1 else "/tmp/dropin"
SC = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
ONLY = sys.argv[3].split(",") if len(sys.argv) > 3 else None
W, H = int(W0 * SC), int(H0 * SC)
FPS = 24
BEAT = 60 / 118.0
SONG0 = 1.2
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
PW, PH = 2752, 1536            # plate space (2x the stage reference)
FEET_Y = 1058                  # pipe floor in plate space
CX = 1400                      # pipe centre
LIP_L, LIP_R, LIP_Y = 690, 2110, 440

# ---------- caches ----------
_c = {}
def cached(key, fn):
    if key not in _c: _c[key] = fn()
    return _c[key]

def plate_arrays():
    def f():
        im = Image.open(f"{WD}/plate.png").convert("RGB").resize((PW, PH), Image.LANCZOS)
        a = np.asarray(im).astype(np.float32) / 255
        lum = a.mean(axis=2, keepdims=True)
        sat = np.clip(lum + (a - lum) * 1.5, 0, 1)                 # push the rainbow
        sky = np.clip((a[..., 2:3] - a[..., 0:1] - 0.15) * 3, 0, 1) * np.clip(1.4 - np.arange(PH, dtype=np.float32)[:, None, None] / 900, 0, 1)
        night = sat * np.array([0.52, 0.46, 0.80])
        night = night * (1 - sky * 0.55)                          # sky -> deep night
        dark = a * np.array([0.10, 0.09, 0.17]) + 0.008
        lit = np.clip(night * 1.15 + 0.015, 0, 1)
        # rainbow tracks stay bright when lit; sky goes to a dusk glow
        return dark, lit
    return cached("plate", f)

def clip_frames(name, scale):
    def f():
        raw = np.fromfile(f"{WD}/clips/{name}.rgba", dtype=np.uint8).reshape(-1, 640, 640, 4)
        out = []
        for fr in raw:
            im = Image.fromarray(fr, "RGBA").crop((60, 40, 580, 600))   # trim the empty margins
            sz = (int(520 * scale), int(560 * scale))
            out.append(im.resize(sz, Image.LANCZOS))
        return out
    return cached(("clip", name, scale), f)

# feet anchor inside the trimmed sprite (x centre, y feet) in unscaled px
FEET = (260 - 0, 545 - 40)

def sprite(name, t, scale, loop=True, flip=False, speed=1.0, tint=None, rot=0, frame=None):
    fr = clip_frames(name, scale)
    i = int(t * 16 * speed) if frame is None else frame
    i = i % len(fr) if loop else min(max(i, 0), len(fr) - 1)
    im = fr[i]
    if flip: im = im.transpose(Image.FLIP_LEFT_RIGHT)
    if tint is not None:
        r, g, b, a = im.split()
        rgb = Image.merge("RGB", (r, g, b))
        arr = np.asarray(rgb).astype(np.float32) * np.array(tint)
        im = Image.merge("RGBA", (*Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).split(), a))
    ax, ay = FEET[0] * scale, FEET[1] * scale
    if flip: ax = im.width - ax
    if rot:
        c = (ax, ay)
        im = im.rotate(rot, resample=Image.BICUBIC, center=c, expand=False)
    return im, ax, ay

def paste(canvas, im, ax, ay, x, y):
    canvas.alpha_composite(im, (int(x - ax), int(y - ay))) if (0 <= x - ax and 0 <= y - ay and x - ax + im.width <= canvas.width and y - ay + im.height <= canvas.height) else paste_clip(canvas, im, int(x - ax), int(y - ay))

def paste_clip(canvas, im, x0, y0):
    cw, ch = canvas.size
    sx, sy = max(0, -x0), max(0, -y0)
    ex, ey = min(im.width, cw - x0), min(im.height, ch - y0)
    if ex <= sx or ey <= sy: return
    canvas.alpha_composite(im.crop((sx, sy, ex, ey)), (x0 + sx, y0 + sy))

def ease(u): u = min(1, max(0, u)); return u * u * (3 - 2 * u)
def lerp(a, b, u): return a + (b - a) * u
def clamp(x, a=0, b=1): return max(a, min(b, x))

def pipe_y(x):
    """feet y of something riding the pipe at plate x (flat deck, curved ramps, wall at the lips)."""
    d = abs(x - CX)
    flat = 330
    if d <= flat: return FEET_Y
    k = clamp((d - flat) / (720 - flat))
    return FEET_Y - (LIP_Y_DEPTH * (k * k))
LIP_Y_DEPTH = 560
def pipe_ang(x):
    e = 6
    dy = pipe_y(x + e) - pipe_y(x - e)
    return math.degrees(math.atan2(dy, 2 * e))

# ---------- scene pieces ----------
def base_plate(lit, wipe=None):
    dark, bright = plate_arrays()
    if wipe is None:
        a = dark * (1 - lit) + bright * lit
    else:   # wipe: x position (plate px) up to which the pipe is lit
        xs = np.arange(PW, dtype=np.float32)
        m = np.clip((wipe - xs) / 260 + 0.5, 0, 1)[None, :, None] * lit
        a = dark * (1 - m) + bright * m
    return Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8)).convert("RGBA")

def board(canvas, x, y, ang, scale=1.0):
    bw, bh = int(170 * scale), int(60 * scale)
    im = Image.new("RGBA", (bw + 20, bh + 20), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cy = bh // 2 + 10
    d.rounded_rectangle((10, cy - int(10 * scale), 10 + bw, cy + int(4 * scale)), 8, fill=(232, 196, 40, 255), outline=(150, 30, 30, 255), width=3)
    d.rectangle((10 + int(40 * scale), cy - int(8 * scale), 10 + int(60 * scale), cy + 2), fill=(190, 40, 40, 255))
    for wx in (30, bw - 20):
        d.ellipse((10 + wx - 9, cy + int(2 * scale), 10 + wx + 9, cy + int(2 * scale) + 18), fill=(235, 235, 235, 255), outline=(40, 40, 40, 255), width=3)
    im = im.rotate(-ang, resample=Image.BICUBIC, center=((bw + 20) / 2, cy))
    canvas.alpha_composite(im, (int(x - (bw + 20) / 2), int(y - cy - 8 * scale)))

def sparks(canvas, pts, t, seed=1, n=26, col=(255, 190, 80)):
    """pts(tt) -> (x, y, angle_deg) of the board at time tt; sparks trail behind."""
    d = ImageDraw.Draw(canvas)
    rnd = random.Random(seed)
    for i in range(n):
        age = rnd.random() * 0.45
        x, y, a = pts(t - age)
        vx, vy = -rnd.uniform(120, 480), -rnd.uniform(40, 360)
        sx, sy = x + vx * age, y + vy * age + 700 * age * age
        r = rnd.uniform(3, 7) * (1 - age / 0.5)
        d.ellipse((sx - r, sy - r, sx + r, sy + r), fill=col + (255,))

def ember_overlay(img, t, n=90, seed=3, speed=70, warm=(255, 150, 60)):
    d = ImageDraw.Draw(img, "RGBA")
    rnd = random.Random(seed)
    w, h = img.size
    for i in range(n):
        x0, y0, sp, ph, r = rnd.random() * w, rnd.random() * h, rnd.uniform(0.5, 1.6) * speed * (h / 1080), rnd.random() * 6.28, rnd.uniform(1.5, 4.5) * (h / 1080)
        x = (x0 + math.sin(t * 1.3 + ph) * 28) % w
        y = (y0 - sp * t) % h
        a = int(150 + 100 * math.sin(t * 5 + ph))
        d.ellipse((x - r, y - r, x + r, y + r), fill=warm + (a,))

def confetti(img, t, n=260, seed=5, speed=330):
    d = ImageDraw.Draw(img, "RGBA")
    rnd = random.Random(seed)
    w, h = img.size
    cols = [(255, 70, 70), (255, 190, 40), (70, 200, 255), (110, 230, 120), (220, 90, 255), (255, 255, 255)]
    for i in range(n):
        x0, y0, sp, ph, sz = rnd.random() * w, rnd.random() * h, rnd.uniform(0.6, 1.4) * speed * (h / 1080), rnd.random() * 6.28, rnd.uniform(7, 16) * (h / 1080)
        x = (x0 + math.sin(t * 2 + ph) * 60) % w
        y = (y0 + sp * t) % h
        a = t * 5 + ph
        c, s = math.cos(a), math.sin(a)
        k = abs(math.cos(t * 4 + ph)) * 0.8 + 0.2
        pts = [(x + (dx * c - dy * s * k), y + (dx * s + dy * c * k)) for dx, dy in ((-sz, -sz / 2), (sz, -sz / 2), (sz, sz / 2), (-sz, sz / 2))]
        d.polygon(pts, fill=rnd.choice(cols) + (235,))

def bloom(arr, strength=0.35):
    im = Image.fromarray(arr)
    small = im.resize((max(8, W // 8), max(8, H // 8)), Image.BILINEAR).filter(ImageFilter.GaussianBlur(6))
    big = np.asarray(small.resize((W, H), Image.BILINEAR)).astype(np.float32)
    out = arr.astype(np.float32) + big * strength
    return np.clip(out, 0, 255).astype(np.uint8)

_vig = {}
def vignette(arr, amt=0.5):
    key = (W, H)
    if key not in _vig:
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        r = np.sqrt(((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2)
        _vig[key] = np.clip(1 - np.clip(r - 0.55, 0, 1) * 0.9, 0.15, 1)[..., None]
    v = _vig[key]
    return (arr.astype(np.float32) * (1 - amt + amt * v)).astype(np.uint8)

def camera(plate_img, cx, cy, w, rot=0, shake=0, t=0):
    h = w * 9 / 16
    if shake:
        cx += math.sin(t * 61) * shake + math.sin(t * 37 + 1) * shake * 0.7
        cy += math.cos(t * 53) * shake * 0.8
    x0, y0 = cx - w / 2, cy - h / 2
    x0 = clamp(x0, 0, plate_img.width - w); y0 = clamp(y0, 0, plate_img.height - h)
    box = (x0, y0, x0 + w, y0 + h)
    im = plate_img.convert("RGB").resize((W, H), Image.BILINEAR, box=box)
    if rot:
        z = 1 + abs(rot) * 0.03
        im = im.rotate(rot, resample=Image.BILINEAR, expand=False)
        cw, ch = W / z, H / z
        im = im.resize((W, H), Image.BILINEAR, box=((W - cw) / 2, (H - ch) / 2, (W + cw) / 2, (H + ch) / 2))
    return im

def flash(arr, a, col=(255, 255, 255)):
    if a <= 0: return arr
    return np.clip(arr.astype(np.float32) * (1 - a) + np.array(col, np.float32) * a, 0, 255).astype(np.uint8)

def whip_blur(im, u):
    """horizontal motion-blur feel for a whip-pan: u in 0..1 over the first frames."""
    if u >= 1: return im
    r = int((1 - u) * 38 * SC) + 1
    return im.filter(ImageFilter.BoxBlur(r)) if r > 2 else im

def pulse(t, k=3.5): ph = ((t - SONG0) / BEAT) % 1; return math.exp(-k * ph)

# ---------- portraits ----------
def portrait_source(name, t):
    """returns a PIL RGB image: frame of the i2v clip at t (held on its last frame), else the still."""
    def f():
        mp4 = f"{WD}/portraits/{name}.mp4"
        if os.path.exists(mp4):
            p = subprocess.run(["ffmpeg", "-v", "error", "-i", mp4, "-vf", "scale=1344:768:flags=lanczos,fps=24,format=rgb24", "-f", "rawvideo", "-"], capture_output=True)
            fr = np.frombuffer(p.stdout, np.uint8).reshape(-1, 768, 1344, 3)
            return [Image.fromarray(x) for x in fr], True
        return [Image.open(f"{WD}/portraits/{name}.png").convert("RGB").resize((1344, 768))], False
    frames, moving = cached(("por", name), f)
    if not moving: return frames[0]
    i = min(int(t * 24), len(frames) - 1)
    return frames[i]

def portrait_shot(name, focus, w0, w1, t, dur, flip=False, rot=0, shake=0, whip=False, ember=True, glow=1.0, tilt_end=None):
    src = portrait_source(name, t)
    if flip: src = src.transpose(Image.FLIP_LEFT_RIGHT)
    u = ease(t / dur)
    fx, fy = focus
    if flip: fx = 1344 - fx
    w = lerp(w0, w1, u)
    im = camera(src.convert("RGBA"), fx, fy, w, rot=rot if tilt_end is None else lerp(rot, tilt_end, u), shake=shake, t=t)
    if whip: im = whip_blur(im, t / 0.28)
    return im

# ---------- global overlays ----------
LYRICS = []
def add_lyrics():
    bar2 = 4 * BEAT * 2   # two bars: 4.068 s
    v1 = ["They hand me a light and they tell me when to burn.", "Opener, closer, I wait for my turn.", "Every night the same song, a different crowd.", "I've been loud so long I forgot how loud."]
    ch = ["Drop in, drop in, don't look at the floor.", "Fire on the way down and a little bit more.", "Drop in, drop in, it's the only way through.", "Nobody came for the plan. They came for you."]
    v2 = ["I've got one skateboard and no record to show.", "I can't hold a note but I know where to go.", "Don't ask me for rhythm, I've got speed instead.", "I just don't stop till the thing's been said."]
    for start, lines, who in ((9.3, v1, "py"), (25.6, ch, "both"), (41.9, v2, "ep"), (69.0, ch, "both"), (85.3, ch, "both")):
        for i, l in enumerate(lines):
            LYRICS.append((start + i * bar2, start + (i + 1) * bar2 - 0.15, l, who))
add_lyrics()

_font = {}
def font(sz):
    if sz not in _font: _font[sz] = ImageFont.truetype(FONT, sz)
    return _font[sz]

def draw_lyrics(img, t):
    for a, b, text, who in LYRICS:
        if a - 0.05 <= t <= b:
            d = ImageDraw.Draw(img, "RGBA")
            fs = int(70 * SC)
            f = font(fs)
            words = text.split(" ")
            # two lines when long
            lines = [text] if len(text) < 36 else [" ".join(words[:len(words) // 2]), " ".join(words[len(words) // 2:])]
            prog = clamp((t - a) / (b - a - 0.5))
            total = sum(len(x) for x in lines)
            shown = 0
            y = H - int(250 * SC) - (len(lines) - 1) * int(40 * SC)
            for ln in lines:
                tw = d.textlength(ln, font=f)
                x = (W - tw) / 2
                d.text((x, y), ln, font=f, fill=(255, 255, 255, 255), stroke_width=int(7 * SC), stroke_fill=(10, 8, 20, 255))
                frac = clamp((prog * total - shown) / max(1, len(ln)))
                if frac > 0:
                    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
                    ld = ImageDraw.Draw(layer)
                    col = (255, 205, 60, 255) if who != "ep" else (120, 220, 255, 255)
                    ld.text((x, y), ln, font=f, fill=col, stroke_width=int(7 * SC), stroke_fill=(10, 8, 20, 255))
                    mask = Image.new("L", img.size, 0)
                    ImageDraw.Draw(mask).rectangle((0, 0, x + tw * frac, H), fill=255)
                    img.paste(layer, (0, 0), ImageChops.multiply(mask, layer.split()[3]))
                shown += len(ln)
                y += int(88 * SC)
            return

KO_T = [46.5, 50.9, 53.5]
def draw_scoreboard(img, t, force=None):
    n = sum(1 for k in KO_T if t >= k) if force is None else force
    d = ImageDraw.Draw(img, "RGBA")
    x0, y0 = W - int(420 * SC), int(40 * SC)
    d.rounded_rectangle((x0, y0, x0 + int(380 * SC), y0 + int(120 * SC)), int(14 * SC), fill=(10, 10, 30, 210), outline=(255, 190, 40, 255), width=int(4 * SC))
    d.text((x0 + int(20 * SC), y0 + int(10 * SC)), "KOs", font=font(int(44 * SC)), fill=(255, 190, 40, 255))
    for i in range(3):
        cx = x0 + int((150 + i * 70) * SC); cy = y0 + int(62 * SC); r = int(24 * SC)
        lit = i < n
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(255, 90, 60, 255) if lit else (50, 50, 70, 255), outline=(255, 255, 255, 200), width=int(3 * SC))
    d.text((x0 + int(20 * SC), y0 + int(62 * SC)), f"{n}/3", font=font(int(40 * SC)), fill=(255, 255, 255, 255))

# ---------- shots ----------
SHOTS = []
def shot(name, a, b):
    def deco(fn):
        SHOTS.append((name, a, b, fn)); return fn
    return deco

def stage_actors(canvas, t, T, specs):
    for s in specs: s(canvas, t, T)

def actor(name, x, y, scale=1.25, flip=False, tint=None, speed=1.0, rot=0, loop=True, frame=None, t_off=0):
    def f(canvas, t, T):
        im, ax, ay = sprite(name, t + t_off, scale, loop=loop, flip=flip, speed=speed, tint=tint, rot=rot, frame=frame)
        px, py = (x(t) if callable(x) else x), (y(t) if callable(y) else y)
        paste(canvas, im, ax, ay, px, py)
    return f

def skater_path(x0, x1, T, pause=0.0, bounce=0, phase=0):
    """x(t) moving x0->x1 with ease; y follows the pipe."""
    def xf(t): return lerp(x0, x1, ease(t / T))
    return xf

def skater(xf, scale=1.1, flip=False, tint=None, lean=True, name="ep_idle", yoff=0, air=0):
    def f(canvas, t, T):
        x = xf(t); y = pipe_y(x) - yoff - air * math.sin(clamp(t / T) * math.pi)
        ang = pipe_ang(x) if lean else 0
        board(canvas, x, y + 8, ang if not flip else -ang, scale * 0.9)
        im, ax, ay = sprite(name, t, scale, flip=flip, tint=tint, rot=-ang * 0.6)
        paste(canvas, im, ax, ay, x, y - 6)
    return f

def sky_flames(canvas, t, xs, base_y, h=420, seed=7):
    d = ImageDraw.Draw(canvas, "RGBA")
    rnd = random.Random(seed)
    for x in xs:
        for i in range(34):
            ph = rnd.random() * 6.28
            age = ((t * 1.4 + rnd.random()) % 1)
            fx = x + math.sin(t * 6 + ph) * 26 * (1 - age) + (rnd.random() - .5) * 40
            fy = base_y - age * h
            r = (1 - age) * 46 + 6
            c = (255, int(210 - 150 * age), int(60 - 40 * age), int(220 * (1 - age)))
            d.ellipse((fx - r, fy - r, fx + r, fy + r), fill=c)

def fire_burst(canvas, x, y, u, big=1.0):
    """u: seconds since impact."""
    if u < 0: return
    d = ImageDraw.Draw(canvas, "RGBA")
    r = (30 + 190 * (1 - math.exp(-u * 6))) * big
    a = int(200 * math.exp(-u * 2.6))
    for k, col in ((1.0, (255, 120, 30)), (0.7, (255, 190, 60)), (0.4, (255, 245, 200))):
        rr = r * k
        d.ellipse((x - rr, y - rr, x + rr, y + rr), fill=col + (int(a * (0.5 + 0.5 * k)),))
    # shock ring
    rr = r * 1.35
    d.ellipse((x - rr, y - rr, x + rr, y + rr), outline=(255, 255, 255, int(a)), width=max(3, int(14 * math.exp(-u * 3))))
    rnd = random.Random(11)
    for i in range(36):
        ang = rnd.random() * 6.28; sp = rnd.uniform(300, 1100)
        px, py = x + math.cos(ang) * sp * u, y + math.sin(ang) * sp * u + 500 * u * u
        rr = 7 * math.exp(-u * 1.5)
        d.ellipse((px - rr, py - rr, px + rr, py + rr), fill=(255, 220, 120, int(255 * math.exp(-u * 1.4))))

def speed_lines(img, t, direction=1, n=26, seed=2, alpha=150):
    d = ImageDraw.Draw(img, "RGBA")
    rnd = random.Random(seed + int(t * 24) % 5)
    for i in range(n):
        y = rnd.random() * H; x = rnd.random() * W; L = rnd.uniform(0.15, 0.4) * W
        d.line((x, y, x - direction * L, y + rnd.uniform(-6, 6)), fill=(255, 255, 255, alpha), width=max(1, int(rnd.uniform(2, 5) * SC)))

def crowd(canvas, t, specs, tint=(0.05, 0.05, 0.09), y=1536, scale=1.35, lit=0.0):
    """specs: (name, x, phase). silhouettes along the bottom of plate space."""
    for name, x, ph in specs:
        tn = tuple(c + (1 - c) * lit for c in tint) if lit else tint
        im, ax, ay = sprite(name, t + ph, scale, tint=tn)
        paste(canvas, im, ax, ay, x, y + 40 + 14 * math.sin(t * 6 + ph * 3))

def finish(frame_img, t, T, lit_flash=0.0, bloom_s=0.3, vig=0.5, overlay=None, lyrics=True, score=None, fadein=None, fadeout=None):
    if overlay: overlay(frame_img)
    arr = np.asarray(frame_img.convert("RGB"))
    arr = bloom(arr, bloom_s)
    arr = vignette(arr, vig)
    arr = flash(arr, lit_flash)
    out = Image.fromarray(arr)
    return out

# ---- the shots ----
CROWD3 = [("blog-man_clip_idle", 700, 0.0), ("chooser_clip_jump", 1250, 0.3), ("got-ur-back_clip_idle", 1900, 0.6)]
CROWD_SIL = [("blog-man_clip_idle", 330, 0.0), ("chooser_clip_jump", 760, 0.3), ("got-ur-back_clip_idle", 1180, 0.6), ("chooser_clip_idle", 1640, 0.1), ("blog-man_clip_jump", 2100, 0.5), ("got-ur-back_clip_jump", 2500, 0.2)]

def plate_shot(lit, wipe=None): return base_plate(lit, wipe)

@shot("s01_hook_fire", 0.0, 1.0)
def s01(t, T):
    # crash cymbal: pipe goes from black to rainbow, end to end, as a ribbon of fire is exhaled.
    prog = ease(t / 0.8)
    wipe = lerp(300, PW + 300, prog)
    plate = plate_shot(1.0, wipe)
    plate = Image.fromarray((np.asarray(plate.convert("RGB")).astype(np.float32) * (0.35 + 0.65 * clamp(prog * 3))).astype(np.uint8)).convert("RGBA")
    # ribbon of fire from her mouth along the pipe
    d = ImageDraw.Draw(plate, "RGBA")
    x0, y0 = 760, 760
    for i in range(70):
        s_ = i / 69
        if s_ * 2400 + x0 > wipe + 200: break
        x = x0 + s_ * 2200
        y = y0 + math.sin(s_ * 9 + t * 14) * 36 * (1 - s_ * 0.3) - s_ * 200
        r = 34 * (1 - s_ * 0.7)
        for k, (rr, col) in enumerate(((1.8, (255, 120, 20, 90)), (1.0, (255, 190 - int(110 * s_), 50, 230)), (0.5, (255, 250, 200, 255)))):
            d.ellipse((x - r * rr, y - r * rr, x + r * rr, y + r * rr), fill=col)
    # Pyro Singer on the left lip, breathing it out
    im, ax, ay = sprite("py_nspecial", t, 1.1, loop=False, speed=1.0)
    paste(plate, im, ax, ay, 700, LIP_Y + 8)
    cam = camera(plate, lerp(1100, 1250, ease(t)), 800, lerp(2200, 1900, ease(t)), shake=14 * math.exp(-t * 6), t=t)
    return finish(cam, t, T, lit_flash=0.5 * math.exp(-t * 9), bloom_s=0.45)

@shot("s02_eyes_ecu", 1.0, 2.6)
def s02(t, T):
    im = portrait_shot("py_eyes", (672, 240), 560, 420, t, T, shake=3)
    ember_overlay(im, t, 50, 9)
    return finish(im, t, T, bloom_s=0.4)

@shot("s03_pyro_mcu", 2.6, 5.4)
def s03(t, T):
    im = portrait_shot("py_eyes2", (672, 330), 1000, 820, t, T)
    ember_overlay(im, t + 3, 40, 10)
    return finish(im, t, T)

@shot("s04_punk_dont", 5.4, 7.4)
def s04(t, T):
    im = portrait_shot("ep_shy", (672, 330), 1100, 900, t, T, rot=-4, tilt_end=-2)
    return finish(im, t, T, bloom_s=0.2)

@shot("s05_pyro_nobody", 7.4, 9.3)
def s05(t, T):
    im = portrait_shot("py_brow", (700, 330), 1150, 780, t, T, whip=True, flip=True)
    ember_overlay(im, t, 30, 12)
    return finish(im, t, T, bloom_s=0.35)

def lit_for(t, base=0.55, k=0.35): return clamp(base * 0.9 + 0.2 + k * pulse(t) * 0.5)

@shot("s06_v1_ms_pan", 9.3, 12.3)
def s06(t, T):
    g = 9.3 + t
    plate = plate_shot(lit_for(g, 0.45, 0.5))
    stage_actors(plate, t, T, [actor("py_jab", lambda t: lerp(1500, 1260, ease(t / T)), FEET_Y + 4, scale=1.35)])
    cam = camera(plate, lerp(1700, 1250, ease(t / T)), 860, lerp(1500, 1200, ease(t / T)), shake=3, t=t)
    ember_overlay(cam, t, 60, 4)
    return finish(cam, t, T, bloom_s=0.4)

@shot("s07_v1_ws_low", 12.3, 15.3)
def s07(t, T):
    g = 12.3 + t
    plate = plate_shot(lit_for(g, 0.4, 0.55))
    d = ImageDraw.Draw(plate, "RGBA")
    # spotlight cone on her
    d.polygon([(1400 - 90, 120), (1400 + 90, 120), (1400 + 380, FEET_Y), (1400 - 380, FEET_Y)], fill=(255, 235, 190, 46))
    stage_actors(plate, t, T, [actor("py_idle", CX - 60, FEET_Y + 4, scale=1.25)])
    crowd(plate, t, CROWD_SIL[:4], scale=1.3)
    cam = camera(plate, CX, lerp(1040, 960, ease(t / T)), lerp(1500, 1750, ease(t / T)), shake=2, t=t)
    return finish(cam, t, T, bloom_s=0.4)

@shot("s08_v1_cu_honest", 15.3, 18.0)
def s08(t, T):
    im = portrait_shot("py_sing_i2v", (640, 330), 900, 640, t, T, shake=2)
    ember_overlay(im, t, 70, 13)
    return finish(im, t, T, bloom_s=0.45)

@shot("s09_v1_cu_fire_hair", 18.0, 21.0)
def s09(t, T):
    im = portrait_shot("py_sing", (780, 300), 1100, 760, t, T, shake=3, rot=2)
    d = ImageDraw.Draw(im, "RGBA")
    # fire ripples through her hair on the high note
    rnd = random.Random(21)
    for i in range(70):
        ph = rnd.random() * 6.28
        age = (t * 1.6 + rnd.random()) % 1
        x = W * (0.12 + rnd.random() * 0.42) + math.sin(t * 7 + ph) * 22
        y = H * 0.20 - age * H * 0.2 + rnd.random() * 80
        r = (1 - age) * 15 * SC + 2
        d.ellipse((x - r, y - r * 2.2, x + r, y + r * 1.2), fill=(255, int(150 - 100 * age), 30, int(120 * (1 - age))))
    ember_overlay(im, t, 90, 14, speed=130)
    return finish(im, t, T, bloom_s=0.55, lit_flash=0.12 * pulse(18.0 + t))

@shot("s10_drop_in_crane", 21.0, 23.3)
def s10(t, T):
    g = 21.0 + t
    plate = plate_shot(lit_for(g, 0.6, 0.4))
    u = ease(t / T)
    x = lerp(LIP_L + 20, CX - 380, u)
    y = lerp(LIP_Y - 10, pipe_y(CX - 380), u ** 1.7) if u > 0.18 else LIP_Y - 10
    ang = 55 * (1 - u)
    board(plate, x, y + 8, ang if u > .1 else 0, 1.1)
    im, ax, ay = sprite("ep_jump", t, 1.25, rot=-ang * 0.5, loop=False)
    paste(plate, im, ax, ay, x, y - 6)
    sparks(plate, lambda tt: (lerp(LIP_L + 20, CX - 380, ease(clamp(tt / T))), (lerp(LIP_Y - 10, pipe_y(CX - 380), ease(clamp(tt / T)) ** 1.7)), 0), t, n=30)
    cam = camera(plate, CX, lerp(520, 900, u), lerp(2300, 1500, u), shake=4, t=t)
    speed_lines(cam, t, 1, 14, alpha=90)
    return finish(cam, t, T, lit_flash=0.25 * math.exp(-t * 8))

@shot("s11_drop_in_orbit", 23.3, 25.6)
def s11(t, T):
    g = 23.3 + t
    plate = plate_shot(lit_for(g, 0.6, 0.4))
    xf = lambda tt: lerp(CX - 380, CX + 560, ease(clamp(tt / T)))
    sk = skater(xf)
    # his shadow stretches across the rainbow
    d = ImageDraw.Draw(plate, "RGBA")
    sx = xf(t); L = 360 + 260 * (t / T)
    d.polygon([(sx - 30, FEET_Y + 4), (sx + 40, FEET_Y + 4), (sx + 40 + L, FEET_Y - 40), (sx + L - 30, FEET_Y - 40)], fill=(10, 0, 30, 130))
    stage_actors(plate, t, T, [sk])
    sparks(plate, lambda tt: (xf(tt), pipe_y(xf(tt)), 0), t, n=34)
    ang = lerp(-9, 9, t / T)
    cam = camera(plate, lerp(CX - 300, CX + 380, ease(t / T)), 960, lerp(1250, 1000, ease(t / T)), rot=ang, shake=3, t=t)
    speed_lines(cam, t, 1, 10, alpha=70)
    return finish(cam, t, T)

def duo(canvas, t, T, g, px=CX - 520, ex_fn=None, py_name="py_idle", ex_name="ep_idle"):
    stage_actors(canvas, t, T, [actor(py_name, px, FEET_Y + 4, scale=1.25)])
    ex_fn = ex_fn or (lambda tt: CX + 360 + 340 * math.sin(tt * 1.1))
    stage_actors(canvas, t, T, [skater(ex_fn, scale=1.15, name=ex_name)])
    sparks(canvas, lambda tt: (ex_fn(tt), pipe_y(ex_fn(tt)), 0), t, n=26)

@shot("s12_chorus_two_shot", 25.6, 29.0)
def s12(t, T):
    g = 25.6 + t
    plate = plate_shot(lit_for(g, 0.8, 0.2))
    duo(plate, t, T, g)
    cam = camera(plate, lerp(CX - 100, CX + 100, ease(t / T)), 900, lerp(1500, 1200, ease(t / T)), shake=3, t=t)
    ember_overlay(cam, t, 60, 6)
    return finish(cam, t, T, lit_flash=0.2 * (math.exp(-t * 9)), bloom_s=0.4)

@shot("s13_chorus_orbit", 29.0, 32.4)
def s13(t, T):
    g = 29.0 + t
    plate = plate_shot(lit_for(g, 0.85, 0.15))
    xf = lambda tt: lerp(CX + 650, CX - 650, ease(clamp(tt / T)))
    d = ImageDraw.Draw(plate, "RGBA")
    sx = xf(t)
    d.polygon([(sx - 30, FEET_Y + 4), (sx + 40, FEET_Y + 4), (sx - 40 - 620, FEET_Y - 55), (sx - 640, FEET_Y - 55)], fill=(10, 0, 30, 120))
    stage_actors(plate, t, T, [skater(xf, scale=1.2, flip=True)])
    sparks(plate, lambda tt: (xf(tt), pipe_y(xf(tt)), 0), t, n=34, seed=4)
    cam = camera(plate, lerp(CX + 500, CX - 500, ease(t / T)), lerp(930, 1000, t / T), lerp(1100, 1500, ease(t / T)), rot=lerp(8, -8, t / T), shake=3, t=t)
    return finish(cam, t, T)

@shot("s14_chorus_fire_arc", 32.4, 36.0)
def s14(t, T):
    g = 32.4 + t
    plate = plate_shot(lit_for(g, 0.9, 0.1))
    stage_actors(plate, t, T, [actor("py_fair", CX - 500, FEET_Y + 4, scale=1.25)])
    ex_fn = lambda tt: lerp(CX + 700, CX - 100, ease(clamp(tt / T)))
    stage_actors(plate, t, T, [skater(ex_fn, scale=1.15)])
    sparks(plate, lambda tt: (ex_fn(tt), pipe_y(ex_fn(tt)), 0), t, n=30, seed=9)
    d = ImageDraw.Draw(plate, "RGBA")
    # fire arc thrown from her hand over his head: "fire on the way down"
    for i in range(46):
        s_ = i / 45
        if s_ > clamp(t / 1.2): break
        x = lerp(CX - 380, CX + 520, s_); y = 640 - math.sin(s_ * math.pi) * 330 + 60 * s_
        r = 30 * (1 - 0.6 * s_) + 6
        d.ellipse((x - r, y - r, x + r, y + r), fill=(255, int(200 - 100 * s_), 40, 215))
    cam = camera(plate, lerp(CX - 300, CX + 200, ease(t / T)), 860, 1500, shake=4, t=t)
    return finish(cam, t, T, bloom_s=0.5)

@shot("s15_chorus_cu_sing", 36.0, 38.0)
def s15(t, T):
    im = portrait_shot("py_sing_i2v", (640, 330), 700, 560, t, T + 1, flip=True, shake=3)
    confetti(im, t, 40, 31, speed=140)
    ember_overlay(im, t, 50, 15)
    return finish(im, t, T, bloom_s=0.5, lit_flash=0.1 * pulse(36 + t))

@shot("s16_chorus_ws_hold", 38.0, 39.9)
def s16(t, T):
    g = 38.0 + t
    plate = plate_shot(lit_for(g, 0.9, 0.1))
    stage_actors(plate, t, T, [actor("py_idle", LIP_L + 90, LIP_Y + 8, scale=1.15), actor("ep_idle", LIP_R - 90, LIP_Y + 8, scale=1.15, flip=True)])
    cam = camera(plate, CX, 640, lerp(2000, 1700, ease(t / T)), shake=3, t=t)
    return finish(cam, t, T, bloom_s=0.5)

@shot("s17_react_pyro_brow", 39.9, 41.1)
def s17(t, T):
    im = portrait_shot("py_brow", (690, 330), 1000, 780, t, T, shake=0)
    return finish(im, t, T, bloom_s=0.3)

@shot("s18_react_punk_iknow", 41.1, 43.2)
def s18(t, T):
    im = portrait_shot("ep_shy", (672, 330), 900, 700, t, T + 0.5, flip=True)
    return finish(im, t, T, bloom_s=0.2)

@shot("s19_v2_walk", 43.2, 45.0)
def s19(t, T):
    g = 43.2 + t
    plate = plate_shot(lit_for(g, 0.75, 0.2))
    xf = lambda tt: lerp(CX - 640, CX - 250, clamp(tt / T))
    stage_actors(plate, t, T, [actor("ep_walk", xf, FEET_Y + 4, scale=1.25)])
    cam = camera(plate, lerp(CX - 520, CX - 220, t / T), 930, 1150, shake=7, t=t)
    return finish(cam, t, T)

def ko_shot(name, a, b, contact, rival, hit_clip, flip_dir, cam_fn, flash_big=0.6, slow=0.35, fire_from=None):
    def render(t, T):
        g = a + t
        plate = plate_shot(lit_for(g, 0.8, 0.2))
        sgn = -1 if flip_dir else 1
        rx0 = CX + sgn * 260
        # skater approaches, punches (fsmash) on contact
        sx = lambda tt: lerp(CX - sgn * 640, CX - sgn * 40, ease(clamp(tt / contact)))
        sxx = sx(min(t, contact))
        # slow motion after the hit
        ts = contact + (t - contact) * slow if t > contact else t
        if t < contact:
            stage_actors(plate, t, T, [skater(sx, scale=1.2, flip=flip_dir)])
            im, ax, ay = sprite(rival + "_idle", t, 1.6, flip=not flip_dir)
            paste(plate, im, ax, ay, rx0, FEET_Y + 6)
        else:
            u = t - contact
            fidx = min(int(ts * 16 * 0.9 - contact * 16 * 0.9 + 8), 56)
            im, ax, ay = sprite("ep_fsmash", 0, 1.6, flip=flip_dir, frame=max(8, min(8 + int(u * 16 * slow * 1.4), 40)))
            paste(plate, im, ax, ay, sxx, FEET_Y + 6)
            # rival launched
            vs = u * slow * 2.4
            rx = rx0 + sgn * (900 * vs)
            ry = FEET_Y - 700 * vs + 380 * vs * vs
            im, ax, ay = sprite(rival + "_hurt", 0, 1.6, flip=not flip_dir, frame=int(min(u * 16 * slow * 1.3, 40)))
            paste(plate, im, ax, ay, rx, ry)
            fire_burst(plate, rx0 + sgn * 40, FEET_Y - 170, u * slow * 1.9, big=1.0)
            if fire_from is not None:
                im, ax, ay = sprite("py_fair", ts, 1.6, flip=fire_from[2])
                paste(plate, im, ax, ay, fire_from[0], fire_from[1])
        cx_, cy_, w_, rot_ = cam_fn(t / T)
        cam = camera(plate, cx_, cy_, w_, rot=rot_, shake=(2 + (24 * math.exp(-(t - contact) * 5) if t >= contact else 0)), t=t)
        if t >= contact:
            speed_lines(cam, t, sgn, 18, alpha=int(140 * math.exp(-(t - contact) * 2)))
        fl = flash_big * math.exp(-(t - contact) * 14) if t >= contact else 0
        return finish(cam, t, T, lit_flash=fl, bloom_s=0.5)
    SHOTS.append((name, a, b, render))

ko_shot("s20_ko1", 45.0, 47.5, 1.5, "kaelen", "ep_fsmash", False,
        lambda u: (lerp(CX - 200, CX + 200, ease(u)), 900, lerp(1500, 1250, ease(u)), 0),
        fire_from=(LIP_L + 80, LIP_Y + 8, False))

@shot("s21_cu_punk_nervous", 47.5, 49.3)
def s21(t, T):
    im = portrait_shot("ep_grin", (672, 330), 1000, 760, t, T + 1, shake=3)
    speed_lines(im, t, 1, 10, alpha=60)
    return finish(im, t, T, bloom_s=0.35)

ko_shot("s22_ko2", 49.3, 52.3, 1.6, "shutup-bot", "ep_fsmash", True,
        lambda u: (lerp(CX + 300, CX - 250, ease(u)), 920, lerp(1300, 1700, ease(u)), lerp(7, -7, u)),
        fire_from=(LIP_R - 80, LIP_Y + 8, True))
ko_shot("s23_ko3", 52.3, 54.8, 1.2, "kaelen", "ep_fsmash", False,
        lambda u: (CX, lerp(980, 820, ease(u)), lerp(1900, 1100, ease(u)), 0), flash_big=0.85, slow=0.28,
        fire_from=(LIP_L + 80, LIP_Y + 8, False))

@shot("s24_scoreboard", 54.8, 56.3)
def s24(t, T):
    im = Image.new("RGB", (W, H), (8, 6, 22))
    d = ImageDraw.Draw(im, "RGBA")
    # TV-style scoreboard flipping to 3
    d.rounded_rectangle((W * 0.3, H * 0.2, W * 0.7, H * 0.62), 40, fill=(14, 12, 40, 255), outline=(255, 190, 40, 255), width=int(8 * SC))
    d.text((W * 0.5, H * 0.28), "KOs", font=font(int(90 * SC)), fill=(255, 190, 40), anchor="mm")
    n = 2 if t < 0.35 else 3
    sc = 1 + 0.25 * math.exp(-(t - 0.35) * 9) if t >= 0.35 else 1
    d.text((W * 0.5, H * 0.46), str(n), font=font(int(360 * SC * sc)), fill=(255, 255, 255), anchor="mm")
    d.text((W * 0.5, H * 0.58), "SCORED IN KOs", font=font(int(40 * SC)), fill=(150, 150, 190), anchor="mm")
    confetti(im, t * 1.5, 80, 40) if t > 0.35 else None
    return finish(im, t, T, lit_flash=0.7 * math.exp(-(t - 0.35) * 14) if t >= 0.35 else 0, bloom_s=0.4)

@shot("s25_crowd_roar", 56.3, 58.2)
def s25(t, T):
    g = 56.3 + t
    plate = plate_shot(lit_for(g, 0.85, 0.15))
    crowd(plate, t, [("blog-man_clip_jump", 1000, 0.0), ("chooser_clip_jump", 1400, 0.3), ("got-ur-back_clip_jump", 1800, 0.6)], tint=(1, 1, 1), y=1330, scale=1.5)
    cam = camera(plate, 1400, lerp(1000, 940, t / T), lerp(1500, 1250, t / T), shake=8, t=t)
    confetti(cam, t, 60, 41)
    return finish(cam, t, T, bloom_s=0.4)

@shot("s26_bridge_long", 58.2, 62.6)
def s26(t, T):
    # everything cuts out but the sustained note and the pipe: both on the lip, from behind (silhouettes)
    plate = plate_shot(0.16 + 0.04 * math.sin(t * 2))
    sil = (0.04, 0.03, 0.08)
    d = ImageDraw.Draw(plate, "RGBA")
    stage_actors(plate, t, T, [actor("py_idle", LIP_L - 40, LIP_Y + 6, scale=1.15, tint=sil), actor("ep_idle", LIP_L + 150, LIP_Y + 6, scale=1.15, tint=sil)])
    cam = camera(plate, lerp(CX - 150, CX - 330, ease(t / T)), lerp(780, 700, ease(t / T)), lerp(1900, 1450, ease(t / T)), t=t)
    ember_overlay(cam, t, 50, 17, speed=40)
    return finish(cam, t, T, bloom_s=0.3, vig=0.7)

@shot("s27_pyro_three", 62.6, 66.3)
def s27(t, T):
    im = portrait_shot("py_eyes2", (672, 340), 1150, 850, t, T)
    ember_overlay(im, t, 30, 18, speed=40)
    return finish(im, t, T, bloom_s=0.3, vig=0.7)

@shot("s28_punk_again", 66.3, 69.0)
def s28(t, T):
    im = portrait_shot("ep_grin", (672, 330), 1300, 820, t, T, rot=3, tilt_end=0)
    ember_overlay(im, t, 30, 19, speed=40)
    return finish(im, t, T, bloom_s=0.4, vig=0.7, lit_flash=0.6 * max(0, (t - (T - 0.12)) / 0.12))

@shot("s29_final_crane", 69.0, 81.0)
def s29(t, T):
    g = 69.0 + t
    plate = plate_shot(clamp(0.9 + 0.1 * pulse(g)))
    xf = lambda tt: CX + 700 * math.sin(tt * 0.95)
    stage_actors(plate, t, T, [actor("py_idle", CX - 420, FEET_Y + 4, scale=1.3)])
    stage_actors(plate, t, T, [skater(xf, scale=1.15, flip=False, air=40)])
    sparks(plate, lambda tt: (xf(tt), pipe_y(xf(tt)), 0), t, n=34, seed=7)
    sky_flames(plate, t, [LIP_L - 30, LIP_R + 30], LIP_Y + 40, 480)
    crowd(plate, t, CROWD_SIL, scale=1.35, tint=(0.10, 0.08, 0.14))
    u = ease(t / T)
    cam = camera(plate, CX, lerp(420, 1200, u), lerp(2352, 1500, u), shake=2, t=t)
    confetti(cam, t, 300, 5)
    return finish(cam, t, T, bloom_s=0.5, lit_flash=0.25 * math.exp(-t * 7))

def cheer_shot(name, a, b, who, kind):
    def render(t, T):
        g = a + t
        plate = plate_shot(clamp(0.8 + 0.2 * pulse(g)))
        x = 1400
        sp = sprite(who, t, 1.9, tint=(1, 1, 1))
        paste(plate, sp[0], sp[1], sp[2], x, 1250 + (-60 * abs(math.sin(t * 7)) if kind == "jump" else 0))
        d = ImageDraw.Draw(plate, "RGBA")
        if kind == "cry":
            rnd = random.Random(8)
            for i in range(14):
                age = (t * 1.2 + rnd.random()) % 1
                tx = x - 28 + rnd.choice((-1, 1)) * (14 + rnd.random() * 6); ty = 870 + age * 190
                d.ellipse((tx - 8, ty - 11, tx + 8, ty + 11), fill=(130, 210, 255, int(230 * (1 - age))))
        if kind == "scribble":
            d.rounded_rectangle((x + 40, 1050, x + 330, 1260), 12, fill=(250, 245, 225, 255), outline=(90, 70, 40, 255), width=5)
            for k in range(6):
                d.line((x + 70, 1090 + k * 28, x + 70 + 40 + (k * 50 + t * 300) % 200, 1090 + k * 28 + math.sin(t * 30 + k) * 5), fill=(30, 30, 60, 255), width=4)
        cam = camera(plate, x, 1000, lerp(1500, 1250, t / T), shake=6, t=t)
        confetti(cam, t, 120, 50 + hash(who) % 5)
        return finish(cam, t, T, bloom_s=0.4)
    SHOTS.append((name, a, b, render))

cheer_shot("s30_cheer_gub", 81.0, 82.5, "got-ur-back_clip_hurt", "cry")
cheer_shot("s31_cheer_chooser", 82.5, 83.9, "chooser_clip_jump", "jump")
cheer_shot("s32_cheer_blog", 83.9, 85.3, "blog-man_clip_idle", "scribble")

@shot("s33_final_cu", 85.3, 89.0)
def s33(t, T):
    im = portrait_shot("py_sing_i2v", (640, 330), 640, 900, t, T + 1, shake=3)
    confetti(im, t, 120, 33, speed=240)
    ember_overlay(im, t, 60, 16, speed=120)
    return finish(im, t, T, bloom_s=0.55, lit_flash=0.2 * pulse(85.3 + t))

@shot("s34_final_two_shot", 89.0, 93.0)
def s34(t, T):
    g = 89.0 + t
    plate = plate_shot(clamp(0.9 + 0.1 * pulse(g)))
    ex = lambda tt: CX + 300 + 360 * math.sin(tt * 1.3)
    stage_actors(plate, t, T, [actor("py_jab", CX - 100, FEET_Y + 4, scale=1.3, flip=False)])
    stage_actors(plate, t, T, [skater(ex, scale=1.15, air=50)])
    sparks(plate, lambda tt: (ex(tt), pipe_y(ex(tt)), 0), t, n=30, seed=3)
    sky_flames(plate, t, [LIP_L - 30, LIP_R + 30], LIP_Y + 40, 480, seed=8)
    cam = camera(plate, lerp(CX - 350, CX + 350, ease(t / T)), 860, lerp(1300, 1600, ease(t / T)), rot=lerp(-6, 6, t / T), shake=3, t=t)
    confetti(cam, t, 200, 6)
    return finish(cam, t, T, bloom_s=0.5)

@shot("s35_final_follow", 93.0, 97.0)
def s35(t, T):
    g = 93.0 + t
    plate = plate_shot(clamp(0.9 + 0.1 * pulse(g)))
    xf = lambda tt: lerp(CX + 800, CX - 800, ease(clamp(tt / T)))
    stage_actors(plate, t, T, [skater(xf, scale=1.2, flip=True, air=60)])
    sparks(plate, lambda tt: (xf(tt), pipe_y(xf(tt)), 0), t, n=40, seed=12)
    d = ImageDraw.Draw(plate, "RGBA")
    stage_actors(plate, t, T, [actor("py_fair", LIP_L + 80, LIP_Y + 8, scale=1.15)])
    sky_flames(plate, t, [LIP_L + 20, LIP_R - 20], LIP_Y + 40, 520, seed=9)
    sx = xf(t)
    cam = camera(plate, sx + 100, 940, 1250, rot=lerp(5, -5, t / T), shake=4, t=t)
    confetti(cam, t, 200, 7)
    speed_lines(cam, t, -1, 14, alpha=70)
    return finish(cam, t, T, bloom_s=0.5)

@shot("s36_final_pullout", 97.0, 101.6)
def s36(t, T):
    g = 97.0 + t
    u = ease(t / T)
    plate = plate_shot(lerp(1.0, 0.45, u))
    stage_actors(plate, t, T, [actor("py_idle", CX - 420, FEET_Y + 4, scale=1.3)])
    stage_actors(plate, t, T, [skater(lambda tt: CX + 480 + 80 * math.sin(tt), scale=1.15)])
    sky_flames(plate, t, [LIP_L - 30, LIP_R + 30], LIP_Y + 40, 480)
    crowd(plate, t, CROWD_SIL, scale=1.35, tint=(0.10, 0.08, 0.14))
    cam = camera(plate, CX, lerp(900, 770, u), lerp(1150, 2400, u), t=t)
    confetti(cam, t, 300, 5)
    return finish(cam, t, T, bloom_s=0.5)

@shot("s37_quiet_pipe", 101.6, 103.4)
def s37(t, T):
    plate = plate_shot(0.18 - 0.03 * t)
    cam = camera(plate, CX, 820, lerp(1500, 1380, t / T), t=t)
    ember_overlay(cam, t, 90, 22, speed=45)
    return finish(cam, t, T, bloom_s=0.4, vig=0.7)

@shot("s38_flat", 103.4, 105.6)
def s38(t, T):
    im = portrait_shot("py_eyes", (672, 330), 1000, 860, t, T)
    ember_overlay(im, t, 50, 23, speed=40)
    return finish(im, t, T, bloom_s=0.3, vig=0.7)

@shot("s39_chorus_line", 105.6, 107.6)
def s39(t, T):
    im = portrait_shot("ep_shy2", (672, 330), 1000, 800, t, T, flip=True)
    ember_overlay(im, t, 40, 24, speed=40)
    return finish(im, t, T, bloom_s=0.3, vig=0.7)

@shot("s40_stay_flat", 107.6, 110.4)
def s40(t, T):
    im = portrait_shot("py_smile", (672, 330), 1000, 760, t, T)
    ember_overlay(im, t, 40, 25, speed=40)
    return finish(im, t, T, bloom_s=0.35, vig=0.7)

@shot("s41_endcard", 110.4, 111.9)
def s41(t, T):
    im = Image.new("RGB", (W, H), (11, 11, 14))
    d = ImageDraw.Draw(im)
    d.text((W / 2, H / 2 - 30 * SC), "DOSE OF DESTRUCTION", font=font(int(104 * SC)), fill=(232, 201, 160), anchor="mm")
    d.text((W / 2, H / 2 + 90 * SC), "Made with Hawkes Gen · hawkesgen.ai", font=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", int(38 * SC)), fill=(154, 154, 154), anchor="mm")
    return im

# which shots show which overlays
NO_LYRICS = {"s24_scoreboard", "s41_endcard"}
FIGHT = {"s19_v2_walk", "s20_ko1", "s21_cu_punk_nervous", "s22_ko2", "s23_ko3", "s25_crowd_roar"}

def render_shot(name):
    name, a, b, fn = [x for x in SHOTS if x[0] == name][0]
    T = b - a
    n = int(round(T * FPS))
    out = f"{WD}/shots/{name}.mp4"
    os.makedirs(f"{WD}/shots", exist_ok=True)
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                          "-c:v", "libx264", "-crf", "17", "-pix_fmt", "yuv420p", out], stdin=subprocess.PIPE)
    for i in range(n):
        t = i / FPS
        im = fn(t, T)
        if name not in NO_LYRICS:
            draw_lyrics(im, a + t)
        if name in FIGHT:
            draw_scoreboard(im, a + t)
        if name in ("s20_ko1", "s22_ko2", "s23_ko3", "s19_v2_walk"):
            pass
        p.stdin.write(np.asarray(im.convert("RGB"), dtype=np.uint8).tobytes())
    p.stdin.close(); p.wait()
    return name

if __name__ == "__main__":
    shots = [s for s in SHOTS if ONLY is None or s[0] in ONLY or any(s[0].startswith(o) for o in ONLY)]
    with Pool(7) as pool:
        for r in pool.imap_unordered(render_shot, [x[0] for x in shots]):
            print("done", r, flush=True)
