/**
 * Resource identity and intersection.
 *
 * The original flow compared write sets for conflicts but never said how.
 * String equality is wrong: `src/` and `src/api/x.ts` conflict, and so do
 * `src/**` and `src/mw/rateLimit.ts`. Getting this wrong means the scheduler
 * happily runs two nodes that clobber each other (flow review F3).
 */

/**
 * Normal form: forward slashes, no `./`, no trailing slash, no duplicate
 * separators. Two spellings of the same path MUST normalise identically or the
 * canonical ordering that prevents deadlock is not actually a total order.
 */
export function normalizeResource(input: string): string {
  let s = input.replace(/\\/g, "/").trim();
  s = s.replace(/\/{2,}/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  const isGlob = s.endsWith("/**") || s.endsWith("/*");
  if (!isGlob) s = s.replace(/\/+$/, "");
  return s;
}

/** Strips a trailing glob marker, returning the directory prefix it covers. */
function globPrefix(r: string): string | null {
  if (r.endsWith("/**")) return r.slice(0, -3);
  if (r.endsWith("/*")) return r.slice(0, -2);
  if (r === "**" || r === "*") return "";
  return null;
}

function isUnder(child: string, parent: string): boolean {
  if (parent === "") return true;
  return child === parent || child.startsWith(parent + "/");
}

/**
 * True when two resources can refer to overlapping state.
 *
 * Deliberately conservative — a false positive costs parallelism, a false
 * negative costs correctness.
 */
export function resourcesIntersect(a: string, b: string): boolean {
  const x = normalizeResource(a);
  const y = normalizeResource(b);
  if (x === y) return true;

  const gx = globPrefix(x);
  const gy = globPrefix(y);

  // `src/*` matches only direct children; `src/**` matches the whole subtree.
  // We treat both as covering the subtree: over-approximating here only costs
  // parallelism, and under-approximating would corrupt state.
  if (gx !== null && gy !== null) return isUnder(gx, gy) || isUnder(gy, gx);
  if (gx !== null) return isUnder(y, gx);
  if (gy !== null) return isUnder(x, gy);

  // Two plain paths: a directory contains a file beneath it.
  return isUnder(x, y) || isUnder(y, x);
}

/** True when any member of `a` intersects any member of `b`. */
export function setsIntersect(a: readonly string[], b: readonly string[]): boolean {
  for (const x of a) for (const y of b) if (resourcesIntersect(x, y)) return true;
  return false;
}

/** Members of `a` that intersect something in `b`. Used for cascade reporting. */
export function intersection(a: readonly string[], b: readonly string[]): string[] {
  const out: string[] = [];
  for (const x of a) {
    if (b.some((y) => resourcesIntersect(x, y))) out.push(x);
  }
  return out;
}

/**
 * The canonical total order over resources (flow review F3).
 *
 * Every node acquires its whole write set in this order or acquires nothing.
 * Because all nodes agree on the order, a hold-and-wait cycle cannot form —
 * deadlock is impossible by construction rather than detected after the fact.
 */
export function canonicalSort(resources: readonly string[]): string[] {
  return [...new Set(resources.map(normalizeResource))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}
