import { z } from "zod";
import type { PlanNode } from "@aca/protocol";
import { PersonaRegistry, type EventLog, type NodeExecution } from "@aca/core";
import { generateStructured, ModelRouter } from "@aca/providers";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const Verdict = z.object({
  contractMet: z
    .boolean()
    .describe("True only if the work satisfies the stated contract. Be strict."),
  critique: z
    .string()
    .describe(
      "If contractMet is false, the single most important defect, stated concretely. Empty otherwise.",
    ),
  severity: z
    .enum(["defect", "contract-violation", "style"])
    .describe("Style issues are never grounds for rejection."),
});

export interface ReviewerOptions {
  root: string;
  runId: string;
  router: ModelRouter;
  events: EventLog;
  personas: PersonaRegistry;
  localOnly: boolean;
  /** Model the coder used, so the reviewer can be forced to differ. */
  coderModelFor: (nodeId: string) => string | undefined;
}

/**
 * An independent critic (flow review F2, F17).
 *
 * Two properties make this worth having, and both are easy to lose:
 *
 *   1. It checks against the node's *contract*, not against taste. A reviewer
 *      that rejects for style produces an unbounded loop of cosmetic churn,
 *      which is exactly the failure the round cap exists to stop — better not
 *      to start it.
 *   2. It runs on a different model from the coder. A model reviewing its own
 *      output shares its blind spots and approves them, and the run has no way
 *      to tell that apart from a genuine pass.
 *
 * Returns null to accept, or a critique string to reject. The supervisor owns
 * the round cap and the dedup; this only forms an opinion.
 */
export function makeReviewer(options: ReviewerOptions) {
  return async function review(node: PlanNode, exec: NodeExecution): Promise<string | null> {
    // A node that wrote nothing has nothing to review; the executor already
    // failed it if its contract demanded writes.
    if (exec.writes.length === 0) return null;

    const coderModel = options.coderModelFor(node.id);
    const requirement = options.personas.requirementFor("reviewer", {
      localOnly: options.localOnly,
      usedModels: coderModel ? [coderModel] : [],
    });

    let decision;
    try {
      decision = await options.router.route(requirement);
    } catch {
      // No independent reviewer available. Say so rather than silently
      // falling back to the coder's own model and calling it review.
      options.events.append(
        options.runId,
        "review.requested",
        { skipped: "no independent model satisfies the reviewer requirement" },
        node.id,
      );
      return null;
    }

    const diff = exec.writes
      .map((path) => {
        try {
          const content = readFileSync(join(options.root, path), "utf8");
          return `--- ${path} ---\n${content.slice(0, 4000)}`;
        } catch {
          return `--- ${path} --- (unreadable)`;
        }
      })
      .join("\n\n");

    const gateSummary = exec.gates.results
      .map((g) => `${g.passed ? "pass" : "FAIL"} ${g.gate}${g.detail ? `: ${g.detail}` : ""}`)
      .join("\n");

    options.events.append(
      options.runId,
      "review.requested",
      {
        model: decision.chosen.id,
        provider: decision.chosen.provider,
        independentOf: coderModel,
      },
      node.id,
    );

    try {
      const out = await generateStructured(decision.chosen, decision.provider, {
        schema: Verdict,
        messages: [
          { role: "system", content: options.personas.get("reviewer").system },
          {
            role: "user",
            content: [
              `Contract: ${node.contract || node.title}`,
              ``,
              `Static gates:`,
              gateSummary || "(none ran)",
              ``,
              `Files produced:`,
              diff,
              ``,
              `Does this satisfy the contract? Reject only for defects or contract violations.`,
            ].join("\n"),
          },
        ],
        maxTokens: 800,
      });

      if (out.value.contractMet || out.value.severity === "style") {
        options.events.append(
          options.runId,
          "review.approved",
          { model: decision.chosen.id },
          node.id,
        );
        return null;
      }
      return out.value.critique || "reviewer rejected without giving a reason";
    } catch (err) {
      // A reviewer that cannot answer must not block the run — but it must not
      // silently approve either. Record and pass; the gates already voted.
      options.events.append(
        options.runId,
        "review.requested",
        { failed: (err as Error).message.slice(0, 200) },
        node.id,
      );
      return null;
    }
  };
}
