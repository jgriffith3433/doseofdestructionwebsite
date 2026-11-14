import { levelStep, clampLevel, levelNote, applyResult } from '../ai/autoLevel.ts';

let fails = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (got !== want) {
    fails++;
    console.error(`FAIL ${name}: got ${got}, want ${want}`);
  }
};
const r = (won: boolean, stocksLeft: number, foeStocksLost: number, dealt: number, stocks = 3) => ({ won, stocks, stocksLeft, foeStocksLost, dealt });

eq('win 3 stocks left', levelStep(r(true, 3, 3, 300)), 1);
eq('win 2 stocks left', levelStep(r(true, 2, 3, 300)), 1);
eq('win 1 stock left', levelStep(r(true, 1, 3, 300)), 0);
eq('win 2-stock flawless', levelStep(r(true, 2, 2, 200, 2)), 1);
eq('win 2-stock scraped', levelStep(r(true, 1, 2, 200, 2)), 0);
eq('win 1-stock', levelStep(r(true, 1, 1, 90, 1)), 1);
eq('loss, no stock taken', levelStep(r(false, 0, 0, 80)), -1);
eq('loss, little damage', levelStep(r(false, 0, 1, 40)), -1);
eq('close loss', levelStep(r(false, 0, 2, 220)), 0);
eq('clamp low', clampLevel(0), 1);
eq('clamp high', clampLevel(12), 9);
eq('note', levelNote(3, 4), 'Auto: CPU level 3 → 4');

// Storage: a fake localStorage.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};
let m = applyResult(r(true, 3, 3, 300));
eq('first win from start', `${m?.from}>${m?.to}`, '3>4');
m = applyResult(r(false, 0, 0, 10));
eq('then a loss', `${m?.from}>${m?.to}`, '4>3');
for (let i = 0; i < 4; i++) applyResult(r(false, 0, 0, 10));
eq('floor holds', applyResult(r(false, 0, 0, 10)), null);
for (let i = 0; i < 12; i++) applyResult(r(true, 3, 3, 300));
eq('ceiling holds', applyResult(r(true, 3, 3, 300)), null);

if (fails) throw new Error(`${fails} autoLevel checks failed`);
console.log('autoLevel ok');
