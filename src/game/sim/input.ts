// One player's controls for one frame, packed into a single integer.
// This is the only thing that ever crosses the network.
//
//   bits 0-7   stick x + 128   (-100..100)
//   bits 8-15  stick y + 128   (-100..100, up is positive)
//   bits 16+   buttons

export const BTN = {
  ATTACK: 1 << 16,
  SPECIAL: 1 << 17,
  JUMP: 1 << 18,
  SHIELD: 1 << 19,
  // The C-stick / smash button: a strong attack in a direction.
  C_UP: 1 << 20,
  C_DOWN: 1 << 21,
  C_LEFT: 1 << 22,
  C_RIGHT: 1 << 23,
  C_NEUTRAL: 1 << 24,
} as const;

export const C_ANY = BTN.C_UP | BTN.C_DOWN | BTN.C_LEFT | BTN.C_RIGHT | BTN.C_NEUTRAL;
export const NO_INPUT = packInput(0, 0, 0);

export function packInput(sx: number, sy: number, buttons: number): number {
  const x = Math.max(-100, Math.min(100, Math.round(sx))) + 128;
  const y = Math.max(-100, Math.min(100, Math.round(sy))) + 128;
  return (buttons & ~0xffff) | (y << 8) | x;
}

export function stickX(input: number): number {
  return (input & 0xff) - 128;
}

export function stickY(input: number): number {
  return ((input >> 8) & 0xff) - 128;
}
