import type { ChatMessage } from "@aca/protocol";
import { estimateTokens } from "../review/loop.ts";

/**
 * Compacts a node's message list in place of letting it grow without bound.
 *
 * The context assembler (F8) sizes the *opening* context against the model's
 * window and then hands the loop a message list that nothing ever trims. Every
 * step re-sends the whole conversation, so cost grows with the square of the
 * step count — and a 30 KB `read_file` result from step 2 is still being paid
 * for at step 40.
 *
 * Measured on one run: 41 steps on a single node spent 263,402 input tokens to
 * produce 17,812 output tokens. Input was 93% of the entire run budget, and the
 * run died at `BudgetExceeded` without ever finishing the work.
 *
 * What gets elided is tool *results*, and only old ones. They are the bulk, and
 * they are the part the model has already extracted what it needs from — unlike
 * its own reasoning, which is how it knows what it already tried.
 */

export interface CompactOptions {
  /** Compaction runs only once the list is bigger than this, in tokens. */
  budgetTokens: number;
  /** Trailing messages left untouched — the model's working memory. */
  keepRecent?: number;
  /** Results shorter than this are not worth eliding. */
  minElideChars?: number;
}

export interface CompactResult {
  messages: ChatMessage[];
  /** How many tool results were replaced with a stub. */
  elided: number;
  tokensBefore: number;
  tokensAfter: number;
}

export function messageTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

/**
 * Replaces the body of old tool results with a one-line stub.
 *
 * The message itself has to stay: providers reject a conversation where a
 * `tool` result does not answer an assistant `tool_calls` entry, so dropping
 * them outright breaks the request rather than shrinking it. Keeping the
 * envelope and emptying the body is what makes this safe.
 */
export function compactMessages(
  messages: readonly ChatMessage[],
  options: CompactOptions,
): CompactResult {
  const keepRecent = options.keepRecent ?? 8;
  const minElideChars = options.minElideChars ?? 400;
  const tokensBefore = messageTokens(messages);

  if (tokensBefore <= options.budgetTokens) {
    return { messages: [...messages], elided: 0, tokensBefore, tokensAfter: tokensBefore };
  }

  // Index 0 is the system prompt and index 1 is the node contract; both are
  // pinned by the same reasoning the assembler pins them.
  const firstEligible = 2;
  const lastEligible = messages.length - keepRecent;

  let elided = 0;
  const out = messages.map((m, i) => {
    if (i < firstEligible || i >= lastEligible) return { ...m };
    if (m.role !== "tool") return { ...m };
    if (m.content.length < minElideChars) return { ...m };
    elided++;
    return { ...m, content: elidedStub(m) };
  });

  return { messages: out, elided, tokensAfter: messageTokens(out), tokensBefore };
}

function elidedStub(m: ChatMessage): string {
  const name = m.name ?? "tool";
  const kb = (m.content.length / 1024).toFixed(1);
  return (
    `[${name} result elided to save context — ${kb} KB. ` +
    `If you still need it, call ${name} again.]`
  );
}
