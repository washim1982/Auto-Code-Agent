import { z } from "zod";

/**
 * What the gather phase hands to the apply phase.
 *
 * The point of the split is that apply does *not* inherit gather's transcript.
 * A node that read forty files carries forty fenced tool results into every
 * subsequent step, which is where 88–96% of a run's tokens went — see
 * docs/09-loop-redesign.md §1. The brief is the narrow waist: everything apply
 * needs, nothing it does not.
 *
 * So the bounds below are the design, not defensive validation. A brief that
 * can grow without limit is the transcript again with extra steps.
 */
export const NodeBrief = z.object({
  findings: z
    .array(z.string().max(400))
    .max(10)
    .describe("What you learned that the writer needs to know. Facts, not narration."),
  relevant: z
    .array(
      z.object({
        path: z.string().max(300),
        why: z.string().max(200).describe("Why the writer needs this file."),
      }),
    )
    .max(12)
    .describe("Files whose content matters to the change."),
  plan: z
    .array(
      z.object({
        path: z.string().max(300).describe("One of the node's declared write paths."),
        change: z.string().max(600).describe("Concretely what to write there."),
      }),
    )
    .max(8)
    .describe("One entry per file this node will write."),
  blockers: z
    .array(z.string().max(400))
    .max(5)
    .describe("Anything that makes the contract impossible. Empty when the work can proceed."),
});
export type NodeBrief = z.infer<typeof NodeBrief>;

/** Asked of the model at the end of gathering. */
export const BRIEF_SYSTEM = `You have finished investigating. Summarise for the engineer who
will make the change — they will NOT see anything you read, only what you write here.

- findings: facts they need. Not "I looked at X", but what X establishes.
- relevant: files whose contents matter, and why each one matters.
- plan: one entry per declared write path, saying concretely what goes there.
- blockers: only genuine impossibilities. An unknown you can reasonably decide is
  not a blocker — decide it and put the decision in the plan.`;

/**
 * The brief, as the apply phase's opening context.
 *
 * Deliberately not JSON: the writer is a code model being asked to act, and
 * prose with headings reads better than a schema dump. The schema's job was
 * constraining what gather produced, and it has already done it.
 */
export function renderBrief(brief: NodeBrief): string {
  const out: string[] = [];

  if (brief.findings.length > 0) {
    out.push("What the investigation established:");
    for (const f of brief.findings) out.push(`- ${f}`);
    out.push("");
  }

  if (brief.relevant.length > 0) {
    out.push("Files that matter here:");
    for (const r of brief.relevant) out.push(`- ${r.path} — ${r.why}`);
    out.push("");
  }

  if (brief.plan.length > 0) {
    out.push("What to write:");
    for (const p of brief.plan) out.push(`- ${p.path}: ${p.change}`);
    out.push("");
  }

  if (brief.blockers.length > 0) {
    out.push("Unresolved:");
    for (const b of brief.blockers) out.push(`- ${b}`);
    out.push("");
  }

  return out.join("\n").trimEnd();
}

/**
 * Whether gathering concluded the work cannot be done.
 *
 * Blockers alone are not enough to stop: a model will report an unknown as a
 * blocker and then plan around it anyway. What makes a node impossible is
 * having blockers *and* nothing to write — at that point apply has no
 * instruction to follow, and running it would burn a phase to reach the same
 * conclusion less clearly.
 */
export function isBlocked(brief: NodeBrief): boolean {
  return brief.blockers.length > 0 && brief.plan.length === 0;
}
