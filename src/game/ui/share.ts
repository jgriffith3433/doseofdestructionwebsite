// Share a result: a PNG card drawn on a canvas (winner portrait, both fighters, stage, KOs, best hit, episode stars or the
// daily score, the address) sent through navigator.share with the file; without it the card downloads and a short text
// line is copied. The results screen (ui/views.ts `showResults`) registers what to draw; the Share button sits among its
// actions (`shareAction`). Every share fires `dod:share` on window (path, file, text) for the playtest.

import { portraitUrl } from './dom.ts';

export const SHARE_ADDRESS = 'doseofdestruction.com';

export interface ShareInfo {
  headline: string;
  winnerId: string;
  winnerName: string;
  winnerColor: string;
  loserId?: string;
  loserName?: string;
  stage: string;
  /** A short context line: the mode or episode ("Episode · Open Mic"). */
  context: string;
  kos: number;
  /** Best hit as a percent string ("34%"), '' when none. */
  bestHit: string;
  time: string;
  /** Episode stars (a row of stars) or the daily score line; '' for none. */
  extra: string;
  /** The stage's sky colours, dark to light, for the card's backdrop. */
  sky: [string, string];
}

export type SharePath = 'share-sheet' | 'download' | 'cancelled' | 'failed';

let current: ShareInfo | null = null;

export function setShareInfo(info: ShareInfo | null): void {
  current = info;
}

/** Adds to the card's line (the daily score arrives after the results open). */
export function setShareExtra(extra: string): void {
  if (current) current = { ...current, extra };
}

export function hasShareInfo(): boolean {
  return current !== null;
}

/** The short text that goes with the card (and is copied when the card can't be shared). */
export function shareLine(i: ShareInfo): string {
  const bits = [`${i.winnerName} won${i.loserName ? ` against ${i.loserName}` : ''} on ${i.stage}`, `${i.kos} KO${i.kos === 1 ? '' : 's'}`];
  if (i.bestHit) bits.push(`best hit ${i.bestHit}`);
  if (i.extra) bits.push(i.extra);
  return `${bits.join(' · ')}. Dose of Destruction: ${SHARE_ADDRESS}`;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function fit(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, hgt: number): void {
  const k = Math.min(w / img.naturalWidth, hgt / img.naturalHeight);
  const dw = img.naturalWidth * k;
  const dh = img.naturalHeight * k;
  ctx.drawImage(img, x + (w - dw) / 2, y + hgt - dh, dw, dh);
}

/** Shrinks the font until `text` fits `maxW`. */
function fitText(ctx: CanvasRenderingContext2D, text: string, weight: string, size: number, maxW: number): void {
  let s = size;
  do {
    ctx.font = `${weight} ${s}px system-ui, "Segoe UI", sans-serif`;
    s -= 2;
  } while (ctx.measureText(text).width > maxW && s > 18);
}

/** Draws the 1080x1350 card. */
export async function drawCard(i: ShareInfo): Promise<HTMLCanvasElement> {
  const W = 1080;
  const H = 1350;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const [winImg, loseImg] = await Promise.all([loadImage(portraitUrl(i.winnerId, 512)), i.loserId ? loadImage(portraitUrl(i.loserId, 512)) : Promise.resolve(null)]);

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, i.sky[0]);
  bg.addColorStop(1, '#0b0b12');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, 640, 40, W / 2, 640, 640);
  glow.addColorStop(0, `${i.winnerColor}66`);
  glow.addColorStop(1, 'transparent');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = i.winnerColor;
  ctx.fillRect(0, 0, W, 14);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffffcc';
  fitText(ctx, 'DOSE OF DESTRUCTION', '800', 40, W - 120);
  ctx.fillText('DOSE OF DESTRUCTION', W / 2, 92);
  ctx.fillStyle = '#fff';
  fitText(ctx, i.headline.toUpperCase(), '900', 96, W - 100);
  ctx.fillText(i.headline.toUpperCase(), W / 2, 210);

  // The winner, large; the beaten fighter smaller at the corner.
  if (winImg) fit(ctx, winImg, 190, 250, 700, 700);
  if (loseImg) {
    ctx.save();
    ctx.globalAlpha = 0.85;
    fit(ctx, loseImg, 40, 640, 300, 300);
    ctx.restore();
  }
  ctx.fillStyle = '#ffffffb0';
  fitText(ctx, i.winnerName, '800', 56, W - 120);
  ctx.fillText(i.winnerName, W / 2, 1010);
  if (i.loserName) {
    ctx.fillStyle = '#ffffff88';
    fitText(ctx, `vs ${i.loserName}`, '600', 36, W - 120);
    ctx.fillText(`vs ${i.loserName}`, W / 2, 1056);
  }

  // The stats row.
  const cells: [string, string][] = [['KOs', String(i.kos)], ['Best hit', i.bestHit || '–'], ['Time', i.time]];
  const cw = (W - 120) / cells.length;
  cells.forEach(([label, value], k) => {
    const x = 60 + cw * k + cw / 2;
    ctx.fillStyle = '#ffffff14';
    ctx.fillRect(60 + cw * k + 8, 1090, cw - 16, 120);
    ctx.fillStyle = '#fff';
    fitText(ctx, value, '900', 54, cw - 40);
    ctx.fillText(value, x, 1152);
    ctx.fillStyle = '#ffffff99';
    ctx.font = '600 26px system-ui, sans-serif';
    ctx.fillText(label.toUpperCase(), x, 1192);
  });

  ctx.fillStyle = i.winnerColor;
  fitText(ctx, [i.stage, i.extra].filter(Boolean).join('  ·  '), '800', 38, W - 100);
  ctx.fillText([i.stage, i.extra].filter(Boolean).join('  ·  '), W / 2, 1262);
  ctx.fillStyle = '#ffffffcc';
  ctx.font = '700 36px system-ui, sans-serif';
  ctx.fillText(SHARE_ADDRESS, W / 2, 1316);
  return c;
}

function toBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('the card could not be drawn'))), 'image/png'));
}

function announce(detail: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent('dod:share', { detail }));
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;left:-999px';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Draws the card and sends it: the share sheet with the file, else download + copy the text line. Returns what happened. */
export async function shareResult(info: ShareInfo | null = current): Promise<SharePath> {
  if (!info) return 'failed';
  const text = shareLine(info);
  try {
    const blob = await toBlob(await drawCard(info));
    const file = new File([blob], 'dose-of-destruction-result.png', { type: 'image/png' });
    const data: ShareData = { files: [file], text, title: 'Dose of Destruction', url: `https://${SHARE_ADDRESS}` };
    if (typeof navigator.share === 'function' && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      try {
        await navigator.share(data);
        announce({ path: 'share-sheet', file: file.name, type: file.type, bytes: file.size, text });
        return 'share-sheet';
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') {
          announce({ path: 'cancelled', file: file.name, bytes: file.size, text });
          return 'cancelled';
        }
        // Any other refusal falls back to the download.
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    const copied = await copyText(text);
    announce({ path: 'download', file: file.name, type: file.type, bytes: file.size, text, copied });
    toast(copied ? 'Card saved. Text copied.' : 'Card saved.');
    return 'download';
  } catch (e) {
    console.error('[dod-share]', e);
    announce({ path: 'failed', error: String(e) });
    return 'failed';
  }
}

function toast(msg: string): void {
  const el = document.createElement('div');
  el.className = 'share-toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}
