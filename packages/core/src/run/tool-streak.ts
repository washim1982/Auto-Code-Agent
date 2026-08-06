/**
 * Circuit breaker for a tool that keeps returning nothing.
 *
 * The executor already refuses an *identical* repeat call, but that does not
 * catch the failure mode that actually burns a node: a model answers an empty
 * search by rewording the query rather than by concluding the thing is absent.
 * Every attempt has different arguments, so signature dedup never fires — what
 * repeats is the result. One analysis node spent 39 greps and most of its token
 * budget that way before the step cap ended it.
 *
 * Counted per tool, because "grep found nothing three times" is evidence about
 * grep. A non-empty result clears the count: the model found its footing, and a
 * later dry spell should get the same three attempts rather than inheriting a
 * primed breaker.
 */
export class EmptyResultStreak {
  private readonly limit: number;
  private readonly streaks = new Map<string, number>();

  constructor(limit = 3) {
    this.limit = limit;
  }

  /**
   * Records one tool result.
   *
   * Returns true when this tool has now come back empty `limit` times running
   * and the caller should say so instead of handing over another empty result —
   * which reads as new information every time.
   */
  record(tool: string, content: string): boolean {
    if (content.trim().length > 0) {
      this.streaks.set(tool, 0);
      return false;
    }
    const next = (this.streaks.get(tool) ?? 0) + 1;
    this.streaks.set(tool, next);
    return next >= this.limit;
  }

  /** Current consecutive-empty count, for the event payload. */
  count(tool: string): number {
    return this.streaks.get(tool) ?? 0;
  }
}

/** What the model is told once the breaker opens. */
export function exhaustedNotice(tool: string, streak: number): string {
  return (
    `${tool} has returned no results ${streak} times in a row, with different arguments each time. ` +
    `Treat what you are searching for as absent from this workspace. ` +
    `Do not call ${tool} again — act on what you already have, or state DONE and say what you could not find.`
  );
}
