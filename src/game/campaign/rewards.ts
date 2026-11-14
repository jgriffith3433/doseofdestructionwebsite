// Season 8 to 10 rewards (docs/story.md "Rewards"): each of those ten episodes gives something made from what the
// game already has, with no new art: a profile title, a stage variant (an existing stage's colour grade on another
// stage) or a fighter tint (one more colour look for every fighter). Earned on a win, kept in localStorage
// (`dod-rewards`), shown on the episode card before play, announced on results, and usable in Versus.

import { CHAPTERS, loadProgress, type Chapter, type Reward } from './story.ts';

export type { Reward, RewardKind } from './story.ts';

const KEY = 'dod-rewards';
const PICK = 'dod-reward-title';

/** Every reward, in episode order, with the chapter that gives it. */
export const REWARDS: { reward: Reward; chapter: Chapter }[] = CHAPTERS.flatMap((c) => (c.reward ? [{ reward: c.reward, chapter: c }] : []));

export const rewardOf = (id: string): { reward: Reward; chapter: Chapter } | undefined => REWARDS.find((r) => r.reward.id === id);

const KIND_NAME = { title: 'Title', stage: 'Stage', tint: 'Colour' } as const;
/** "Title · Prime-time": the reward line on the episode card. */
export const rewardLine = (r: Reward): string => `${KIND_NAME[r.kind]} · ${r.name}`;

let live: Set<string> | null = null;

function load(done: Set<string> = loadProgress()): Set<string> {
  const out = new Set<string>();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (Array.isArray(saved)) for (const s of saved) if (typeof s === 'string' && rewardOf(s)) out.add(s);
  } catch {
    // Unreadable storage: only what the cleared episodes give.
  }
  for (const { reward, chapter } of REWARDS) if (done.has(chapter.id)) out.add(reward.id);
  return out;
}

/** The rewards owned (saved ones plus those of every episode already cleared). */
export function owned(): Set<string> {
  return (live ??= load());
}
export const hasReward = (id: string): boolean => owned().has(id);
export const ownedOf = (kind: Reward['kind']): Reward[] => REWARDS.filter((r) => r.reward.kind === kind && hasReward(r.reward.id)).map((r) => r.reward);

/** Re-read after the progress changes (a reset, a setup shortcut). */
export function reloadRewards(): void {
  live = null;
}

/** A won episode: returns its reward when it was not saved yet (the unlock banner), else null. */
export function earnReward(c: Chapter): Reward | null {
  const r = c.reward;
  if (!r) return null;
  let saved: string[] = [];
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (Array.isArray(raw)) saved = raw.filter((s) => typeof s === 'string');
  } catch {
    saved = [];
  }
  if (saved.includes(r.id)) return null;
  saved.push(r.id);
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {
    // Storage blocked: the cleared episode gives it back next visit.
  }
  owned().add(r.id);
  return r;
}

/** Forgets every saved reward (tests and setup shortcuts; a campaign reset keeps them, like fighter unlocks). */
export function clearRewards(): void {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(PICK);
  } catch {
    // Nothing to clear.
  }
  live = null;
  titlePick = undefined;
}

// ------------------------------------------------------------------ titles
let titlePick: string | null | undefined;

/** The title worn in Versus (shown on your VS card), or null. A title you do not own is never worn. */
export function pickedTitle(): Reward | null {
  if (titlePick === undefined) {
    try {
      titlePick = localStorage.getItem(PICK);
    } catch {
      titlePick = null;
    }
  }
  const r = titlePick ? rewardOf(titlePick)?.reward : undefined;
  return r && r.kind === 'title' && hasReward(r.id) ? r : null;
}
export function pickTitle(id: string | null): void {
  titlePick = id;
  try {
    if (id) localStorage.setItem(PICK, id);
    else localStorage.removeItem(PICK);
  } catch {
    // Kept for this visit only.
  }
}

// ------------------------------------------------------------------ stage variants
let variantId: string | null = null;
let onVariant: (() => void) | null = null;

/** The renderer re-grades the stage on screen when the variant changes. */
export function onVariantChange(fn: () => void): void {
  onVariant = fn;
}
export const activeVariant = (): Reward | null => (variantId ? (rewardOf(variantId)?.reward ?? null) : null);
export function setVariant(id: string | null): void {
  const next = id && hasReward(id) ? id : null;
  if (next === variantId) return;
  variantId = next;
  onVariant?.();
}

/** The stage whose colour-grade LUT (stages/<id>/lut.png) a stage is drawn with: its own, or its variant's. */
export function gradeSource(stageId: string): string {
  const v = activeVariant();
  return v && v.kind === 'stage' && v.stage === stageId && v.grade ? v.grade : stageId;
}

/** Variants owned for the stages of this list. */
export const variantsFor = (stageIds: string[]): Reward[] => ownedOf('stage').filter((r) => r.stage && stageIds.includes(r.stage));
