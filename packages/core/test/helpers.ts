/** Deterministic PRNG so a failing fuzz trial can be replayed by seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(items: readonly T[], n: number, rand: () => number): T[] {
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    const v = items[Math.floor(rand() * items.length)];
    if (v !== undefined && !out.includes(v)) out.push(v);
  }
  return out;
}
