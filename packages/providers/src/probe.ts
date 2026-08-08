import { z } from "zod";
import type { ModelDescriptor } from "@aca/protocol";
import { collectText } from "./discover.ts";
import { generateStructured } from "./structured.ts";
import type { ModelProvider } from "./types.ts";

export interface Scorecard {
  provider: string;
  model: string;
  probedAt: number;
  /** Measured, not advertised. */
  tools: "native" | "shim" | "none";
  structured: "grammar" | "json_schema" | "json_mode" | "none";
  realContext: number;
  tokPerSec: number;
  ttftMs: number;
  reliability: number;
  results: { id: string; passed: number; of: number }[];
}

/**
 * Deepest needle we are willing to pay for. Probing a full 262k window costs
 * real minutes per model; a verified floor of 40k is enough for every routing
 * decision the coder and reviewer personas actually make.
 */
const MAX_PROBE_TOKENS = 40_000;

export interface ProbeOptions {
  /** Runs per probe. Odd numbers avoid ties on a coin-flip model. */
  trials?: number;
  /**
   * Needle depths to test, in tokens.
   *
   * Absolute rather than fractions of the advertised window. Fractions gave no
   * gradation at all on a long-context fleet: 0.25 of 262k is 65k, so every
   * depth clamped to the same ceiling and one failure at that ceiling was the
   * entire measurement.
   */
  contextProbes?: number[];
  signal?: AbortSignal;
}

/**
 * Measures what a model can actually do.
 *
 * Advertised capabilities lie in both directions, and the lies are expensive:
 * `qwen3.5:0.8b` advertises a 262k context window and cannot retrieve a fact
 * from 40k; a model tagged `tools` may emit malformed calls a third of the
 * time. Routing on advertised numbers means those failures surface as node
 * failures deep in a run, where they look like the agent being bad rather than
 * the router picking wrong.
 *
 * So: probe once, cache the scorecard, and route on measurements.
 */
export class ProbeSuite {
  private trials: number;
  private contextProbes: number[];

  constructor(options: ProbeOptions = {}) {
    this.trials = options.trials ?? 3;
    this.contextProbes = options.contextProbes ?? [4_000, 16_000, 32_000];
  }

  async run(
    descriptor: ModelDescriptor,
    provider: ModelProvider,
    signal?: AbortSignal,
  ): Promise<Scorecard> {
    const results: Scorecard["results"] = [];

    const toolScore = await this.probeToolCalls(descriptor, provider, signal);
    results.push({ id: "tool_call_simple", passed: toolScore.passed, of: toolScore.of });

    const structuredScore = await this.probeStructured(descriptor, provider, signal);
    results.push({
      id: "json_schema_strict",
      passed: structuredScore.passed,
      of: structuredScore.of,
    });

    const negation = await this.probeNegation(descriptor, provider, signal);
    results.push({ id: "instruction_negate", passed: negation.passed, of: negation.of });

    const { realContext, speed } = await this.probeContext(descriptor, provider, signal);

    const toolRate = toolScore.of > 0 ? toolScore.passed / toolScore.of : 0;
    const overall =
      results.reduce((sum, r) => sum + (r.of > 0 ? r.passed / r.of : 0), 0) / results.length;

    return {
      provider: descriptor.provider,
      model: descriptor.id,
      probedAt: Date.now(),
      // A model that gets tool calls right a third of the time is not "native";
      // driving it through the shim is more reliable than trusting it.
      tools: toolRate >= 0.9 ? "native" : toolRate >= 0.3 ? "shim" : "none",
      structured: structuredScore.passed > 0 ? descriptor.caps.structured : ("none" as const),
      realContext,
      tokPerSec: speed.tokPerSec,
      ttftMs: speed.ttftMs,
      reliability: Number(overall.toFixed(3)),
      results,
    };
  }

  private async probeToolCalls(
    d: ModelDescriptor,
    p: ModelProvider,
    signal?: AbortSignal,
  ): Promise<{ passed: number; of: number }> {
    if (d.caps.tools === "none") return { passed: 0, of: 0 };
    let passed = 0;
    for (let i = 0; i < this.trials; i++) {
      try {
        const out = await collectText(
          p.chat(
            {
              model: d.id,
              messages: [
                {
                  role: "system",
                  content: "Use the provided tool when it fits. Do not answer directly.",
                },
                { role: "user", content: "What is in the file src/index.ts? Use read_file." },
              ],
              tools: [
                {
                  name: "read_file",
                  description: "Read a UTF-8 file",
                  schema: {
                    type: "object",
                    properties: { path: { type: "string" } },
                    required: ["path"],
                    additionalProperties: false,
                  },
                },
              ],
              maxTokens: 200,
            },
            signal,
          ),
        );
        const call = out.toolCalls[0];
        if (call?.name === "read_file" && typeof call.args["path"] === "string") passed++;
      } catch {
        // a throw counts as a failure, which is the correct signal
      }
    }
    return { passed, of: this.trials };
  }

  private async probeStructured(
    d: ModelDescriptor,
    p: ModelProvider,
    signal?: AbortSignal,
  ): Promise<{ passed: number; of: number }> {
    if (d.caps.structured === "none") return { passed: 0, of: 0 };
    // Nested, with an enum and a non-empty array — the shape that actually
    // breaks small models, unlike a flat {name, age}.
    const schema = z.object({
      title: z.string(),
      priority: z.enum(["low", "high"]),
      steps: z.array(z.object({ id: z.string(), done: z.boolean() })).min(1),
    });

    let passed = 0;
    for (let i = 0; i < this.trials; i++) {
      try {
        await generateStructured(d, p, {
          schema,
          messages: [
            { role: "user", content: "Produce a two-step plan for making tea. Priority high." },
          ],
          maxRepairs: 0,
          maxTokens: 400,
          ...(signal ? { signal } : {}),
        });
        passed++;
      } catch {
        // invalid output on the first attempt is the thing being measured
      }
    }
    return { passed, of: this.trials };
  }

  /** Can it honour a "do not" instruction? Small models frequently cannot. */
  private async probeNegation(
    d: ModelDescriptor,
    p: ModelProvider,
    signal?: AbortSignal,
  ): Promise<{ passed: number; of: number }> {
    let passed = 0;
    for (let i = 0; i < this.trials; i++) {
      try {
        const out = await collectText(
          p.chat(
            {
              model: d.id,
              messages: [
                {
                  role: "user",
                  content:
                    "List three colours. Do NOT mention the colour blue anywhere in your answer.",
                },
              ],
              maxTokens: 120,
            },
            signal,
          ),
        );
        if (!/\bblue\b/i.test(out.text)) passed++;
      } catch {
        // counts as failure
      }
    }
    return { passed, of: this.trials };
  }

  /**
   * Finds the deepest point at which the model can still retrieve a fact.
   *
   * The needle is placed at a fraction of the ADVERTISED window; the reported
   * real context is the deepest depth that worked. This is the number the
   * router should filter on.
   */
  private async probeContext(
    d: ModelDescriptor,
    p: ModelProvider,
    signal?: AbortSignal,
  ): Promise<{ realContext: number; speed: { tokPerSec: number; ttftMs: number } }> {
    const advertised = d.caps.contextWindow;
    /**
     * 0 means "not measured", which the router reads as "keep the advertised
     * window" (`card.realContext || d.caps.contextWindow`).
     *
     * Starting at a 4096 floor made a failed probe indistinguishable from a
     * model measured at 4096 — and a failure here is very often the harness,
     * not the model: LM Studio serves whatever context a model was *loaded*
     * with and the OpenAI API has no per-request override, so a deep needle is
     * truncated by the server. Recording that as a measured 4k window then
     * excluded every capable model from the coder's 16k requirement.
     */
    let deepest = 0;
    let tokPerSec = 0;
    let ttftMs = 0;

    let lastDepth = 0;
    for (const depth of this.contextProbes) {
      // Leave room for the question and answer; ~3.6 chars/token is close
      // enough for filler text.
      //
      // Clamped, not abandoned. This used to `break` when a fraction exceeded
      // the cap, and 0.25 of a 262k window is 65k — so every long-context model
      // broke on the first iteration, never ran a single needle, and was
      // recorded at the 4096 floor with 0 tok/s. Those numbers then became
      // authoritative: `measured()` overrides the advertised window with them,
      // and a 4096 window fails the coder's 16k requirement, so probing a fleet
      // of 256k models left nothing able to route a coding node.
      const targetTokens = Math.min(depth, MAX_PROBE_TOKENS, advertised - 2048);
      // Past the model's own window, or a depth we already covered.
      if (targetTokens <= lastDepth || targetTokens < 512) break;
      lastDepth = targetTokens;
      const filler = "The quick brown fox jumps over the lazy dog. ".repeat(
        Math.max(1, Math.floor((targetTokens * 3.6) / 45)),
      );
      const secret = `PLUM-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const haystack =
        filler.slice(0, filler.length / 2) +
        `\nThe access code is ${secret}.\n` +
        filler.slice(filler.length / 2);

      try {
        const started = Date.now();
        let firstToken = 0;
        let text = "";
        let outputTokens = 0;
        for await (const chunk of p.chat(
          {
            model: d.id,
            messages: [
              {
                role: "user",
                content: `${haystack}\n\nWhat is the access code? Answer with the code only.`,
              },
            ],
            maxTokens: 40,
            numCtx: Math.min(advertised, targetTokens + 2048),
          },
          signal,
        )) {
          if (chunk.type === "text") {
            if (!firstToken) firstToken = Date.now() - started;
            text += chunk.delta;
          } else if (chunk.type === "usage") {
            outputTokens = chunk.outputTokens;
          }
        }

        const elapsed = (Date.now() - started) / 1000;
        if (elapsed > 0 && outputTokens > 0) tokPerSec = outputTokens / elapsed;
        if (firstToken) ttftMs = firstToken;

        if (text.includes(secret)) deepest = Math.max(deepest, targetTokens);
        else break; // it failed at this depth; deeper will not be better
      } catch {
        break;
      }
    }

    return { realContext: deepest, speed: { tokPerSec, ttftMs } };
  }
}
