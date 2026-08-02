import type { Plan } from "@aca/protocol";
import type { CompiledSpec, PlanProblem } from "@aca/core";
import { c, cell } from "./theme.ts";

/**
 * The inline plan card from docs/06-ui-design.md.
 *
 * Ember-bordered, node list with declared write sets on the right, and the
 * approve/edit/reject row at the foot. The write set is the load-bearing
 * column: it is what the user is really approving, because it bounds
 * everything the run can touch.
 */
export function renderPlanCard(
  plan: Plan,
  spec: CompiledSpec,
  meta: { model: string; provider: string; problems: PlanProblem[]; repairs: number },
): string {
  const width = Math.min((process.stdout.columns ?? 96) - 2, 94);
  const inner = width - 2;

  const line = (content: string): string => c.ember("│") + pad(content, inner) + c.ember("│");
  const branches = plan.nodes.filter((n) => n.deps.length === 0).length;

  const out: string[] = [];
  out.push(c.ember("┌" + "─".repeat(inner) + "┐"));
  out.push(
    line(
      ` ${c.ember("▸")} ${c.ember("PROPOSED PLAN")} ${c.dim(
        `· ${plan.nodes.length} nodes · ${branches} entry point${branches === 1 ? "" : "s"}`,
      )}`,
    ),
  );
  out.push(c.ember("├" + "─".repeat(inner) + "┤"));

  // Node ids come from the model, which often prefers `update_math` over `n1`.
  // A fixed narrow column truncates those into uselessness, so size it to the
  // longest id actually present, capped so one verbose id cannot eat the row.
  const idW = Math.min(16, Math.max(4, ...plan.nodes.map((n) => n.id.length)) + 1);
  const writeW = Math.min(34, Math.floor(inner * 0.4));
  const titleW = inner - idW - writeW - 4;

  for (const node of plan.nodes) {
    const deps = node.deps.length ? c.dim(` ←${node.deps.join(",")}`) : "";
    const writes = node.sets.write.length
      ? node.sets.write.join(", ")
      : node.persona === "reviewer"
        ? "read-only"
        : "—";
    out.push(
      line(
        ` ${cell(c.dim(node.id), idW)}${cell(node.title + deps, titleW)} ${cell(
          c.dim(`write ${writes}`),
          writeW,
        )}`,
      ),
    );
  }

  out.push(c.ember("├" + "─".repeat(inner) + "┤"));
  out.push(line(` ${c.dim("ACCEPTANCE")}`));
  for (const a of spec.acceptance) {
    out.push(line(` ${c.slate("○")} ${cell(a, inner - 4)}`));
  }

  const warnings = meta.problems.filter((p) => p.severity === "warning");
  if (warnings.length > 0) {
    out.push(c.ember("├" + "─".repeat(inner) + "┤"));
    for (const w of warnings) {
      out.push(
        line(
          ` ${c.wheat("⚠")} ${cell(`${w.nodeId ? `[${w.nodeId}] ` : ""}${w.message}`, inner - 4)}`,
        ),
      );
    }
  }

  out.push(c.ember("├" + "─".repeat(inner) + "┤"));
  out.push(
    line(
      ` ${c.ember("[a]")} ${c.bold("approve & run")}   ${c.dim("[e]")} edit   ${c.crimson(
        "[r]",
      )} reject   ${c.dim(`${meta.provider}/${meta.model}${meta.repairs ? ` · ${meta.repairs} repair` : ""}`)}`,
    ),
  );
  out.push(c.ember("└" + "─".repeat(inner) + "┘"));

  return out.join("\n");
}

function pad(s: string, width: number): string {
  const visible = s.replace(/\[[0-9;]*m/g, "").length;
  return visible >= width ? s : s + " ".repeat(width - visible);
}
