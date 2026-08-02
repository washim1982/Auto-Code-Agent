import type { PlannedDag } from "./schema.ts";

export interface NormalizeNote {
  nodeId: string;
  message: string;
}

/**
 * Deterministic repair of unambiguous planner mistakes.
 *
 * Small local models reliably make one particular error: they put a file path
 * into `deps` instead of `reads`, because both express "this node depends on
 * that". The validator catches it, but bouncing it back to a 3B model costs a
 * full round-trip and frequently does not converge — the model repeats the
 * mistake because its mental model of the field is wrong, not because it was
 * careless.
 *
 * Where the correct reading is unambiguous — a dep that looks like a path and
 * matches no node id — we fix it here and record a note. Anything genuinely
 * ambiguous still goes back to the model as a validation error; the goal is to
 * stop wasting repair rounds on a mechanical confusion, not to paper over bad
 * plans.
 */
export function normalizeDag(dag: PlannedDag): { dag: PlannedDag; notes: NormalizeNote[] } {
  const ids = new Set(dag.nodes.map((n) => n.id));
  const notes: NormalizeNote[] = [];

  const nodes = dag.nodes.map((node) => {
    const deps: string[] = [];
    const reads = [...node.reads];

    for (const dep of node.deps) {
      if (ids.has(dep)) {
        deps.push(dep);
        continue;
      }
      if (looksLikePath(dep)) {
        if (!reads.includes(dep)) reads.push(dep);
        notes.push({
          nodeId: node.id,
          message: `moved "${dep}" from deps to reads — it is a path, not a node id`,
        });
        continue;
      }
      // Not a known id and not path-shaped: a real error for the model to fix.
      deps.push(dep);
    }

    return { ...node, deps, reads };
  });

  return { dag: { ...dag, nodes }, notes };
}

/** Path-shaped: has a separator, an extension, or a glob marker. */
function looksLikePath(s: string): boolean {
  return /[/\\]/.test(s) || /\.[a-zA-Z0-9]{1,6}$/.test(s) || s.includes("*");
}
