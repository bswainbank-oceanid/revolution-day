// Deterministic PRNG (mulberry32), rewritten as pure state-in/state-out
// functions rather than a closure — RngState lives in GameState and is
// advanced by the reducer, so shuffles and random-target effects (Suicide
// Bomber) stay replayable for trajectory logging and self-play training.

export interface RngState {
  readonly seed: number;
}

export function createRng(seed: number): RngState {
  return { seed: seed | 0 };
}

function step(seed: number): { value: number; seed: number } {
  const a = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, seed: a };
}

export function nextFloat(rng: RngState): { value: number; rng: RngState } {
  const { value, seed } = step(rng.seed);
  return { value, rng: { seed } };
}

export function nextInt(rng: RngState, maxExclusive: number): { value: number; rng: RngState } {
  const { value, rng: nextRng } = nextFloat(rng);
  return { value: Math.floor(value * maxExclusive), rng: nextRng };
}

export function shuffle<T>(rng: RngState, items: readonly T[]): { items: T[]; rng: RngState } {
  const result = items.slice();
  let currentRng = rng;
  for (let i = result.length - 1; i > 0; i--) {
    const { value: j, rng: nextRng } = nextInt(currentRng, i + 1);
    currentRng = nextRng;
    const temp = result[i]!;
    result[i] = result[j]!;
    result[j] = temp;
  }
  return { items: result, rng: currentRng };
}
