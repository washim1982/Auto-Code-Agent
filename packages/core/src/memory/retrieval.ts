export interface Ranked {
  id: string;
  score: number;
}

/**
 * Reciprocal-rank fusion.
 *
 * Vector search and BM25 fail in opposite directions, which is exactly why
 * fusing them works. Ask for `getUserById` and embeddings return everything
 * vaguely about users while BM25 nails the exact identifier; ask "how does
 * login work" and BM25 returns nothing useful while embeddings find the
 * relevant module. RRF combines them without needing the two scores to be on
 * comparable scales — it only uses rank, which is the whole trick.
 *
 * k=60 is the value from the original TREC work; it damps the top of each list
 * so one confident-but-wrong ranker cannot dominate.
 */
export function reciprocalRankFusion(lists: Ranked[][], k = 60): Ranked[] {
  const fused = new Map<string, number>();
  for (const list of lists) {
    list.forEach((item, index) => {
      fused.set(item.id, (fused.get(item.id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...fused.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function toBlob(vector: number[] | Float32Array): Uint8Array {
  const f32 = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function fromBlob(blob: Uint8Array): Float32Array {
  // Copy rather than view: SQLite's buffer is not guaranteed 4-byte aligned,
  // and an unaligned Float32Array view throws.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}
