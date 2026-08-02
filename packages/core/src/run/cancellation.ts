/**
 * Cooperative cancellation (flow review F14).
 *
 * The original flow had no way for a human to stop a run mid-flight. For an
 * interactive CLI and a desktop app that is not optional.
 *
 * Cancelling must CHECKPOINT rather than discard — the run stays resumable.
 */
export class Cancelled extends Error {
  constructor(reason = "cancelled") {
    super(reason);
    this.name = "Cancelled";
  }
}

export class CancellationToken {
  private cancelled = false;
  private reason = "";
  private callbacks = new Set<(reason: string) => void>();
  readonly controller = new AbortController();

  get isCancelled(): boolean {
    return this.cancelled;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  cancel(reason = "cancelled by user"): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.reason = reason;
    this.controller.abort(reason);
    for (const cb of this.callbacks) {
      try {
        cb(reason);
      } catch {
        // a listener must not be able to block cancellation
      }
    }
  }

  onCancel(fn: (reason: string) => void): () => void {
    if (this.cancelled) fn(this.reason);
    this.callbacks.add(fn);
    return () => this.callbacks.delete(fn);
  }

  /** Call at every await point. Throwing is what makes cancellation prompt. */
  throwIfCancelled(): void {
    if (this.cancelled) throw new Cancelled(this.reason);
  }
}
