// Uniform [0,1), same contract as Math.random — injectable so tests can
// pass a deterministic sequence instead of true randomness. Deliberately
// not the engine's seeded RngState: bot choices aren't part of the
// replayable game-state trajectory the way shuffles are, and threading a
// GameState-style seed through every decision call would be a lot of
// plumbing for no real benefit to a "crude but plays correctly" bot.
export type Rng = () => number;

export function pickRandom<T>(rng: Rng, items: readonly T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(rng() * items.length)];
}

// Without replacement, order not meaningful — just "some N distinct items".
export function pickN<T>(rng: Rng, items: readonly T[], n: number): T[] {
  const pool = [...items];
  const result: T[] = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(rng() * pool.length);
    result.push(pool[idx]!);
    pool.splice(idx, 1);
  }
  return result;
}

export function coinFlip(rng: Rng, probability = 0.5): boolean {
  return rng() < probability;
}
