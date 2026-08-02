import type { StructuredGenerator } from "@aca/core";
import { generateStructured, ModelRouter } from "@aca/providers";

/**
 * Bridges the planner to the model layer.
 *
 * `core` deliberately does not import `providers` — the planner takes this
 * function instead, which is what lets the whole flow be tested without a live
 * model server. This adapter is the only place the two meet.
 */
export function makeGenerator(router: ModelRouter): StructuredGenerator {
  return async function generate(req) {
    // withFallback walks the ranked candidates, so a provider dying mid-plan
    // moves to the next model rather than failing the run.
    return await router.withFallback(req.requirement, async (descriptor, provider) => {
      const out = await generateStructured(descriptor, provider, {
        schema: req.schema,
        messages: req.messages,
        ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
      });
      return { value: out.value, model: descriptor.id, provider: descriptor.provider };
    });
  };
}
