declare const process: { exit(code: number): never; env: Record<string, string | undefined> };
// The art bible (docs/art-bible.md, artStyle.ts): every fighter carries a style from tools/derive-style.mjs, and none is
// outside the saturation and value ranges after its remap. Lists the fighters outside (must be 0). The outline is a dark
// coloured line, never black; its width is 2 px at 1080p and never under 1 px (a phone at 844x390 draws 1 px).

import { FIGHTERS } from '../sim/characters.ts';
import { ART, hexToRgb, outlineWidthPx, outsideRanges, remapSV, toHsv } from '../artStyle.ts';
import { lookOf, looksOf, recolorHex } from '../looks.ts';
import { characterIndex } from '../sim/characters.ts';

let failed = 0;
const ok = (c: unknown, m: string) => {
  if (!c) {
    failed++;
    console.error(`FAIL: ${m}`);
  }
};

const outside: string[] = [];
for (const f of FIGHTERS) {
  const s = f.style;
  ok(s, `${f.id} has a style (node tools/derive-style.mjs --write)`);
  if (!s) continue;
  const out = outsideRanges(s.after);
  if (out.length) outside.push(`${f.id}: ${out.join('; ')}`);
  // The stored remap really lands the stored "before" numbers on the "after" ones (value ends are monotonic through it).
  for (const k of ['vP5', 'vP95'] as const) {
    const [, v] = remapSV(0, s.before[k], s.remap);
    ok(Math.abs(v - s.after[k]) < 0.02, `${f.id} ${k}: remap gives ${v.toFixed(3)}, stored ${s.after[k]}`);
  }
  // The remap stays small enough to be the same fighter.
  ok(s.remap.sGain >= ART.limits.sGain[0] && s.remap.sGain <= ART.limits.sGain[1], `${f.id} sGain ${s.remap.sGain}`);
  ok(s.remap.vGamma >= ART.limits.vGamma[0] && s.remap.vGamma <= 1, `${f.id} vGamma ${s.remap.vGamma}`);
  ok(s.remap.vGain >= ART.limits.vGain[0] && s.remap.vGain <= ART.limits.vGain[1], `${f.id} vGain ${s.remap.vGain}`);
  // The outline: the fighter's main hue, darkened to the bible's value: coloured, not black.
  ok(/^#[0-9a-f]{6}$/.test(s.outline), `${f.id} outline ${s.outline}`);
  const [h, sat, v] = toHsv(...hexToRgb(s.outline));
  ok(Math.abs(v - ART.outline.value) < 0.02, `${f.id} outline value ${v.toFixed(2)}`);
  ok(sat >= ART.outline.sat[0] - 0.03, `${f.id} outline is not coloured (sat ${sat.toFixed(2)})`);
  ok(Math.abs(((h - s.hue + 540) % 360) - 180) < 12, `${f.id} outline hue ${Math.round(h)} vs main ${s.hue}`);
  // Colour looks keep a coloured, dark line.
  const char = characterIndex(f.id);
  for (let i = 0; i < looksOf(char).length; i++) {
    const [, ls, lv] = toHsv(...hexToRgb(recolorHex(s.outline, lookOf(char, i))));
    ok(lv < 0.25 && ls >= ART.outline.sat[0] - 0.03, `${f.id} look ${i + 1} outline value ${lv.toFixed(2)} sat ${ls.toFixed(2)}`);
  }
}
console.log(`Art bible: ${outside.length} of ${FIGHTERS.length} fighters outside the saturation and value ranges${outside.length ? ':\n  ' + outside.join('\n  ') : ''}`);
ok(outside.length === 0, `${outside.length} fighters outside the ranges`);

// Width: 2 px at 1080p, 1 px minimum (a phone at 844x390 has a render height of 390 or so).
ok(outlineWidthPx(1080) === 2, '2 px at 1080p');
ok(outlineWidthPx(2160) === 4, '4 px at 4K');
ok(outlineWidthPx(390) === 1 && outlineWidthPx(844) > 1.5 && outlineWidthPx(100) === 1, 'never under 1 px');

if (failed) {
  console.error(`${failed} art style checks failed`);
  process.exit(1);
}
console.log('art style ok');
