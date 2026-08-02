import type { PlanNode } from "@aca/protocol";
import { intersection, setsIntersect } from "./resource.ts";

export interface CascadeResult {
  /** Nodes requeued because they consumed data that no longer exists. */
  dirtied: { nodeId: string; via: string[] }[];
  /** Depth reached. Capped to stop a rollback storm becoming a livelock. */
  depth: number;
  truncated: boolean;
}

export interface CascadeOptions {
  maxDepth?: number;
}

/**
 * Cascade invalidation after a rollback (flow review F6).
 *
 * The original flow said "roll back this node's write set" and stopped there.
 * But the join barrier means a sibling may already have READ those writes —
 * and downstream nodes may have built conclusions on them. Rolling back
 * silently leaves consumers holding results derived from data that no longer
 * exists. This was the single biggest state-corruption risk in the diagram.
 *
 * Fix: nodes declare read sets too, and on rollback every node whose read set
 * intersects the rolled-back write set is marked dirty and requeued —
 * transitively, because a dirtied node's own writes are now suspect.
 */
export function cascadeInvalidate(
  nodes: readonly PlanNode[],
  rolledBackNodeId: string,
  options: CascadeOptions = {},
): CascadeResult {
  const maxDepth = options.maxDepth ?? 8;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const origin = byId.get(rolledBackNodeId);
  if (!origin) return { dirtied: [], depth: 0, truncated: false };

  const dirtied = new Map<string, string[]>();
  // Only nodes that actually consumed something can be invalidated; a node
  // still pending has read nothing yet.
  const consumed = new Set(["done", "review", "running", "failed"]);

  let frontier: { id: string; writes: string[] }[] = [
    { id: origin.id, writes: origin.sets.write },
  ];
  let depth = 0;
  let truncated = false;

  while (frontier.length > 0) {
    if (depth >= maxDepth) {
      truncated = true;
      break;
    }
    depth++;

    const next: { id: string; writes: string[] }[] = [];
    for (const source of frontier) {
      for (const candidate of nodes) {
        if (candidate.id === source.id) continue;
        if (dirtied.has(candidate.id)) continue;
        if (candidate.id === rolledBackNodeId) continue;
        if (!consumed.has(candidate.status)) continue;
        if (!setsIntersect(candidate.sets.read, source.writes)) continue;

        const via = intersection(candidate.sets.read, source.writes);
        dirtied.set(candidate.id, via);
        // Whatever this node wrote is now derived from invalid input, so its
        // own consumers must be invalidated in turn.
        if (candidate.sets.write.length > 0) {
          next.push({ id: candidate.id, writes: candidate.sets.write });
        }
      }
    }
    frontier = next;
  }

  return {
    dirtied: [...dirtied.entries()].map(([nodeId, via]) => ({ nodeId, via })),
    depth,
    truncated,
  };
}
