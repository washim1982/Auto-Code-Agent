import type { PlannedDag } from "./schema.ts";
import { normalizeResource, resourcesIntersect } from "../scheduler/resource.ts";

export interface PlanProblem {
  severity: "error" | "warning";
  nodeId?: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  problems: PlanProblem[];
}

/**
 * Structural validation of a generated plan.
 *
 * Schema constraints guarantee the *shape* is right; they say nothing about
 * whether the plan is coherent. A model will happily emit a node depending on
 * one that does not exist, a dependency cycle, or a node that writes files it
 * never declared reading. Each of those breaks the scheduler in a different
 * way, so each gets caught here and fed back as a repair instruction rather
 * than reaching the run.
 */
export function validatePlan(dag: PlannedDag, acceptance: readonly string[]): ValidationResult {
  const problems: PlanProblem[] = [];
  const ids = new Set<string>();

  for (const node of dag.nodes) {
    if (ids.has(node.id)) {
      problems.push({
        severity: "error",
        nodeId: node.id,
        message: `duplicate node id "${node.id}"`,
      });
    }
    ids.add(node.id);
  }

  for (const node of dag.nodes) {
    for (const dep of node.deps) {
      if (!ids.has(dep)) {
        problems.push({
          severity: "error",
          nodeId: node.id,
          message: `depends on "${dep}", which is not a node in this plan`,
        });
      }
      if (dep === node.id) {
        problems.push({ severity: "error", nodeId: node.id, message: "depends on itself" });
      }
    }
  }

  const cycle = findCycle(dag);
  if (cycle) {
    problems.push({
      severity: "error",
      message: `dependency cycle: ${cycle.join(" → ")}. The plan must be a DAG.`,
    });
  }

  for (const node of dag.nodes) {
    for (const w of node.writes) {
      const norm = normalizeResource(w);
      if (norm.startsWith("..") || norm.startsWith("/") || /^[a-zA-Z]:/.test(norm)) {
        problems.push({
          severity: "error",
          nodeId: node.id,
          message: `write "${w}" is not workspace-relative`,
        });
      }
      // A write set that covers the whole tree makes conflict detection
      // meaningless — every node would serialise against every other.
      if (norm === "**" || norm === "." || norm === "") {
        problems.push({
          severity: "error",
          nodeId: node.id,
          message: `write "${w}" covers the entire workspace; declare specific paths`,
        });
      }
    }

    if (node.persona !== "reviewer" && node.writes.length === 0 && node.deps.length === 0) {
      problems.push({
        severity: "warning",
        nodeId: node.id,
        message: "writes nothing and depends on nothing — is it doing any work?",
      });
    }
  }

  // Two nodes that write the same resource must be ordered, otherwise the
  // scheduler will serialise them at runtime in whatever order it happens to
  // pull them — a plan that produces different results run to run.
  for (let i = 0; i < dag.nodes.length; i++) {
    for (let j = i + 1; j < dag.nodes.length; j++) {
      const a = dag.nodes[i]!;
      const b = dag.nodes[j]!;
      const overlap = a.writes.some((w) => b.writes.some((x) => resourcesIntersect(w, x)));
      if (overlap && !reachable(dag, a.id, b.id) && !reachable(dag, b.id, a.id)) {
        problems.push({
          severity: "warning",
          nodeId: b.id,
          message: `writes overlap with "${a.id}" but neither depends on the other; add a dependency to fix the order`,
        });
      }
    }
  }

  if (acceptance.length > 0) {
    const text = dag.nodes
      .map((n) => `${n.title} ${n.contract}`)
      .join(" ")
      .toLowerCase();
    const uncovered = acceptance.filter((a) => !mentions(text, a));
    if (uncovered.length > 0) {
      problems.push({
        severity: "warning",
        message: `no node appears to address: ${uncovered.map((u) => `"${u}"`).join(", ")}`,
      });
    }
  }

  return { ok: !problems.some((p) => p.severity === "error"), problems };
}

/** Returns the cycle as a node-id path, or null. */
export function findCycle(dag: PlannedDag): string[] | null {
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const walk = (id: string): string[] | null => {
    const s = state.get(id);
    if (s === "done") return null;
    if (s === "visiting") return [...stack.slice(stack.indexOf(id)), id];

    state.set(id, "visiting");
    stack.push(id);
    for (const dep of byId.get(id)?.deps ?? []) {
      if (!byId.has(dep)) continue;
      const found = walk(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const node of dag.nodes) {
    const found = walk(node.id);
    if (found) return found;
  }
  return null;
}

/** True when `to` is an ancestor of `from` through the dep graph. */
function reachable(dag: PlannedDag, from: string, to: string): boolean {
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const id = queue.shift()!;
    if (id === to && id !== from) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(byId.get(id)?.deps ?? []));
  }
  return false;
}

/** Crude keyword overlap — enough to notice a criterion nothing addresses. */
function mentions(haystack: string, criterion: string): boolean {
  const words = criterion
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  if (words.length === 0) return true;
  const hits = words.filter((w) => haystack.includes(w)).length;
  return hits / words.length >= 0.34;
}

/** Renders problems as a repair instruction for the model. */
export function renderProblems(problems: readonly PlanProblem[]): string {
  return problems
    .map(
      (p) => `- ${p.severity.toUpperCase()}${p.nodeId ? ` [${p.nodeId}]` : ""}: ${p.message}`,
    )
    .join("\n");
}
