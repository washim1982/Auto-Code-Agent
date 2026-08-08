/**
 * The point at which a node stops being allowed to read.
 *
 * Every other guard in the loop is a *bound* — step cap, token cap, duplicate
 * calls, empty results. None of them is a *forcing function*, so a model can
 * spend an entire budget on tool calls that are individually legal, non-empty,
 * non-repeating, and collectively pointless. One measured node made 144
 * `read_artifact` calls, 27 greps and 18 reads against 6 writes, and consumed a
 * whole run's token budget without finishing; its four sibling nodes never ran.
 *
 * The low-steps notice was already telling it to stop reading. It kept reading.
 * Advice a model can decline is not a mechanism — so when a node is out of
 * reading budget the read tools are withdrawn from the list it is offered, and
 * writing becomes the only available action.
 */

export const READ_ONLY_TOOLS = new Set([
  "read_file",
  "read_artifact",
  "list_dir",
  "glob",
  "grep",
]);

export interface ReadBudgetOptions {
  /** Read-only tool calls a node may make before writing becomes mandatory. */
  maxReads?: number;
}

export class ReadBudget {
  readonly max: number;
  private used = 0;

  constructor(options: ReadBudgetOptions = {}) {
    this.max = Math.max(1, options.maxReads ?? 30);
  }

  /** Records one tool call; only read-only tools count against the budget. */
  record(tool: string): void {
    if (READ_ONLY_TOOLS.has(tool)) this.used++;
  }

  get reads(): number {
    return this.used;
  }

  get exhausted(): boolean {
    return this.used >= this.max;
  }
}

export interface WriteGateInput {
  /** True when the node must produce a diff (`writePolicy: "required"`). */
  writeRequired: boolean;
  /** Paths the node declared it may write. */
  declared: readonly string[];
  /** Paths it has actually written so far. */
  written: number;
  /** Reading budget is spent. */
  readsExhausted: boolean;
  /** Step budget has reached its write reserve. */
  stepsLow: boolean;
}

/**
 * Whether reading should be withdrawn for this step.
 *
 * Only ever for a node that owes a write and has not made one. A read-only node
 * has nothing to be forced towards, and a node that has already written is
 * entitled to keep checking its work.
 */
export function mustWriteNow(input: WriteGateInput): boolean {
  if (!input.writeRequired) return false;
  if (input.declared.length === 0) return false;
  if (input.written > 0) return false;
  return input.readsExhausted || input.stepsLow;
}

/** Told to the model on the step where reading is withdrawn. */
export function writeOnlyNotice(declared: readonly string[]): string {
  return (
    `You have used your reading budget for this task and have written nothing. ` +
    `The read tools are no longer available to you. ` +
    `Call write_file or edit_file now for: ${declared.join(", ")}. ` +
    `Use what you already know — if a detail is missing, make the smallest reasonable ` +
    `choice and write the file anyway. Producing nothing is the only outcome that fails.`
  );
}
