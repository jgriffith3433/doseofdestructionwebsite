// Character select: the big render. The hovered fighter plays their idle clip, large, in the colour look being picked,
// under the stage's light (content/stages.json `light`: ambient multiply, a warm key from one side, a cool rim on the
// other, the same numbers the match's fighter light reads) with a floor shadow and a spotlight cone. A pick plays the
// confirm pose: the taunt clip when the fighter has one, else the win / jump clip, with a hop and a flash ring.
// Drawn on one canvas that the select keeps; `show` swaps the fighter, `confirm` plays the pose.

import { CHARACTERS, type CharacterDef } from '../sim/characters.ts';
import { STAGES } from '../sim/stage.ts';
import { loadAnimSet, type AnimSet, type Clip } from '../render/anims.ts';
import { lookOf, recolorUrl } from '../looks.ts';
import { WINNER_CLIPS } from '../victory.ts';

/** The pose a pick plays, in order of preference (a fighter with a `taunt` clip plays it). */
export const CONFIRM_CLIPS = ['taunt', ...WINNER_CLIPS.filter((k) => k !== 'taunt')];
/** How long the confirm pose plays before the fighter goes back to idle, in ms. */
export const CONFIRM_MS = 1300;

const images = new Map<string, Promise<HTMLImageElement | null>>();
function image(url: string): Promise<HTMLImageElement | null> {
  let p = images.get(url);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
    images.set(url, p);
  }
  return p;
}

/** The clip the confirm pose plays for a fighter's set. */
export function confirmClip(set: AnimSet): { key: string; clip: Clip } | null {
  for (const key of CONFIRM_CLIPS) {
    const clip = set.clips[key];
    if (clip) return { key, clip };
  }
  return null;
}

/** Warms every fighter's idle sheet one after another while the select is up, so a hover shows the render at once. */
export function prefetchIdles(chars: CharacterDef[]): void {
  let i = 0;
  const next = (): void => {
    const c = chars[i++];
    if (!c) return;
    void loadAnimSet(c.id)
      .then((s) => (s?.clips.idle ? image(`${s.base}${s.clips.idle.file}?v=${s.version}`) : null))
      .then(() => setTimeout(next, 30));
  };
  next();
}

export interface FighterRender {
  /** Shows a fighter in a look; `locked` draws the silhouette. */
  show(c: CharacterDef, look: number, locked: boolean): void;
  /** Plays the confirm pose now. */
  confirm(): void;
  /** The look changed on the fighter shown. */
  setLook(look: number): void;
  /** The fighter's painted portrait stands in until the idle sheet has loaded. */
  state(): { id: string; look: number; locked: boolean; ready: boolean; pose: boolean; frames: number };
}

export function createFighterRender(canvas: HTMLCanvasElement, stage = 0): FighterRender {
  const light = STAGES[stage]?.light;
  const key = light?.key?.color ?? '#ffa45c';
  const rim = light?.rim?.color ?? '#5aa8ff';
  const ambient = light?.ambient ?? '#f4d2b4';
  const keyStrength = light?.key?.strength ?? 0.6;
  const rimStrength = light?.rim?.strength ?? 0.6;
  const keyLeft = (light?.key?.dir?.[0] ?? -0.8) < 0;

  let c: CharacterDef | null = null;
  let look = 0;
  let locked = false;
  let set: AnimSet | null = null;
  let idle: HTMLImageElement | null = null;
  let poseImg: HTMLImageElement | null = null;
  let poseAt = -1;
  let poseClip: { key: string; clip: Clip } | null = null;
  let frames = 0;
  let token = 0;
  const born = performance.now();
  const sprite = document.createElement('canvas');

  // Loads (and recolours) one sheet for the look; the newest request wins.
  const sheetFor = async (clip: Clip, forSet: AnimSet, forLook: number): Promise<HTMLImageElement | null> => {
    const url = `${forSet.base}${clip.file}?v=${forSet.version}`;
    const l = lookOf(CHARACTERS.indexOf(c!), forLook);
    if (l.from === undefined) return image(url);
    try {
      return await image(await recolorUrl(url, l));
    } catch {
      return image(url);
    }
  };

  const load = async () => {
    const mine = ++token;
    idle = null;
    poseImg = null;
    poseAt = -1;
    canvas.dataset.ready = '0';
    if (!c) return;
    canvas.dataset.fighter = c.id;
    const id = c.id;
    const s = await loadAnimSet(id);
    if (mine !== token || !s) return;
    set = s;
    const clip = s.clips.idle;
    if (!clip) return;
    const img = await sheetFor(clip, s, look);
    if (mine !== token) return;
    idle = img;
    if (img) canvas.dataset.ready = '1';
  };

  const draw = (now: number) => {
    // The select closed: the canvas left the page.
    if (!canvas.isConnected && now - born > 500) return;
    requestAnimationFrame(draw);
    if (document.hidden || !canvas.offsetParent) return;
    paint(now);
  };

  const paint = (now: number) => {
    const rect = canvas.getBoundingClientRect();
    const k = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(rect.width * k));
    const H = Math.max(1, Math.round(rect.height * k));
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // The set: a dark wall, a spotlight cone from above in the stage's key colour, a lit floor.
    const wall = ctx.createLinearGradient(0, 0, 0, H);
    wall.addColorStop(0, '#0d0a09');
    wall.addColorStop(1, '#1e1410');
    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, W, H);
    const cone = ctx.createRadialGradient(W / 2, -H * 0.1, 10, W / 2, H * 0.55, H * 0.85);
    cone.addColorStop(0, hexA(key, 0.5 * keyStrength + 0.15));
    cone.addColorStop(0.55, hexA(key, 0.12));
    cone.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = cone;
    ctx.fillRect(0, 0, W, H);
    const short = H < 240 * k;
    const floorY = H * (short ? 0.9 : 0.84);
    const floor = ctx.createLinearGradient(0, floorY, 0, H);
    floor.addColorStop(0, hexA(key, 0.22));
    floor.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.fillStyle = floor;
    ctx.fillRect(0, floorY, W, H - floorY);
    ctx.fillStyle = hexA(rim, 0.35);
    ctx.fillRect(0, floorY, W, 2 * k);

    const t = now - born;
    const posing = poseAt >= 0 && now - poseAt < CONFIRM_MS;
    if (!posing && poseAt >= 0) poseAt = -1;
    const set0 = set;
    const sheetImg = posing && poseImg ? poseImg : idle;
    const clip = posing && poseClip && poseImg ? poseClip.clip : set0?.clips.idle;

    // The figure stands in the middle, 62% of the render's height.
    const fh = H * (short ? 0.8 : 0.62);
    const cx = W * 0.5;
    if (!c) return;
    const hop = posing ? Math.sin(Math.min(1, (now - poseAt) / CONFIRM_MS) * Math.PI) * H * 0.07 : 0;
    // Floor shadow shrinks as the fighter hops.
    ctx.fillStyle = `rgba(0,0,0,${0.45 - hop / H})`;
    ctx.beginPath();
    ctx.ellipse(cx, floorY + 4 * k, fh * 0.32 * (1 - hop / H), fh * 0.05, 0, 0, Math.PI * 2);
    ctx.fill();

    if (set0 && clip && sheetImg) {
      frames++;
      const n = clip.frames;
      const i = posing ? Math.min(n - 1, Math.floor(((now - poseAt) / CONFIRM_MS) * n)) : Math.floor((t / 1000) * clip.fps) % n;
      const scale = fh / set0.refHeight;
      const dw = clip.fw * scale;
      const dh = clip.fh * scale;
      if (sprite.width !== Math.ceil(dw) || sprite.height !== Math.ceil(dh)) {
        sprite.width = Math.ceil(dw);
        sprite.height = Math.ceil(dh);
      }
      const sctx = sprite.getContext('2d')!;
      sctx.clearRect(0, 0, sprite.width, sprite.height);
      sctx.globalCompositeOperation = 'source-over';
      sctx.drawImage(sheetImg, (i % clip.cols) * clip.fw, Math.floor(i / clip.cols) * clip.fh, clip.fw, clip.fh, 0, 0, dw, dh);
      if (locked) {
        // A locked fighter is a silhouette.
        sctx.globalCompositeOperation = 'source-atop';
        sctx.fillStyle = '#0a0706';
        sctx.fillRect(0, 0, dw, dh);
      } else {
        // The stage light on the sprite only (source-atop keeps it inside the alpha): ambient multiply, the key on
        // its side, the rim on the far side.
        sctx.globalCompositeOperation = 'multiply';
        sctx.fillStyle = mix(ambient, '#ffffff', 0.45);
        sctx.fillRect(0, 0, dw, dh);
        sctx.globalCompositeOperation = 'source-atop';
        const kg = sctx.createLinearGradient(keyLeft ? 0 : dw, 0, keyLeft ? dw * 0.7 : dw * 0.3, 0);
        kg.addColorStop(0, hexA(key, 0.38 * keyStrength + 0.08));
        kg.addColorStop(1, hexA(key, 0));
        sctx.fillStyle = kg;
        sctx.fillRect(0, 0, dw, dh);
        const rg = sctx.createLinearGradient(keyLeft ? dw : 0, 0, keyLeft ? dw * 0.82 : dw * 0.18, 0);
        rg.addColorStop(0, hexA(rim, 0.5 * rimStrength));
        rg.addColorStop(1, hexA(rim, 0));
        sctx.fillStyle = rg;
        sctx.fillRect(0, 0, dw, dh);
      }
      ctx.drawImage(sprite, cx - clip.ax * scale, floorY - hop - clip.ay * scale);
    } else {
      // The sheet is still loading: the painted portrait fills the middle so the render is never empty.
      const p = portraitEl;
      if (p && p.complete && p.naturalWidth > 0) {
        const s = fh * 0.95;
        ctx.save();
        ctx.globalAlpha = 0.9;
        if (locked) ctx.filter = 'brightness(0)';
        ctx.drawImage(p, cx - s / 2, floorY - s, s, s);
        ctx.restore();
      }
    }

    // The confirm flash: a ring that opens from the fighter's chest and fades.
    if (posing) {
      const u = (now - poseAt) / CONFIRM_MS;
      ctx.strokeStyle = hexA(key, (1 - u) * 0.9);
      ctx.lineWidth = 4 * k * (1 - u) + 1;
      ctx.beginPath();
      ctx.arc(cx, floorY - fh * 0.5, fh * (0.2 + u * 0.7), 0, Math.PI * 2);
      ctx.stroke();
    }
  };

  let portraitEl: HTMLImageElement | null = null;
  requestAnimationFrame(draw);

  return {
    show(next, nextLook, isLocked) {
      const same = c === next;
      c = next;
      look = nextLook;
      locked = isLocked;
      portraitEl = document.querySelector<HTMLImageElement>(`#select-preview img.select-portrait[data-portrait="${next.id}"]`);
      if (!same || !idle) void load();
      else void this.setLook(look);
    },
    setLook(nextLook) {
      look = nextLook;
      if (!c || !set || !set.clips.idle) return;
      const mine = ++token;
      void sheetFor(set.clips.idle, set, nextLook).then((img) => {
        if (mine === token && img) idle = img;
      });
    },
    confirm() {
      if (!c || locked || !set) return;
      poseClip = confirmClip(set);
      poseAt = performance.now();
      canvas.dataset.pose = String(Math.round(poseAt));
      poseImg = null;
      if (poseClip) {
        const pc = poseClip;
        void sheetFor(pc.clip, set, look).then((img) => {
          if (poseClip === pc) poseImg = img;
        });
      }
    },
    state() {
      return { id: c?.id ?? '', look, locked, ready: !!idle, pose: poseAt >= 0, frames };
    },
  };
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, a))})`;
}

function mix(a: string, b: string, t: number): string {
  const x = parseInt(a.slice(1), 16);
  const y = parseInt(b.slice(1), 16);
  const ch = (s: number) => Math.round(((x >> s) & 255) * (1 - t) + ((y >> s) & 255) * t);
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}
