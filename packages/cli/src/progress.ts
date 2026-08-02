import { c } from "./theme.ts";

/**
 * A live status line for work with no token stream to show.
 *
 * Planning against a cold local model can stall 30-60s while 17 GB pages into
 * VRAM, and during that time a silent terminal is indistinguishable from a
 * hang — which is exactly the complaint the design doc anticipated. Showing
 * the model, its residency, and an elapsed counter turns "is this broken?"
 * into "it is loading a large model".
 */
export class Progress {
  private timer: NodeJS.Timeout | null = null;
  private started = 0;
  private label = "";
  private frame = 0;
  private readonly frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private enabled: boolean;

  constructor(enabled = process.stdout.isTTY === true) {
    this.enabled = enabled;
  }

  start(label: string, hint = ""): void {
    this.label = label;
    this.started = Date.now();
    if (!this.enabled) {
      process.stdout.write(`${label}${hint ? ` ${hint}` : ""}\n`);
      return;
    }
    this.stop();
    this.timer = setInterval(() => this.tick(hint), 120);
    this.timer.unref?.();
  }

  private tick(hint: string): void {
    const elapsed = ((Date.now() - this.started) / 1000).toFixed(0);
    const spinner = this.frames[this.frame++ % this.frames.length]!;
    const line = `${c.ember(spinner)} ${this.label} ${c.dim(`${elapsed}s${hint ? ` · ${hint}` : ""}`)}`;
    process.stdout.write(`\r\x1b[2K${line}`);
  }

  /** Clears the line and optionally prints a final message in its place. */
  stop(final?: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.enabled) {
      if (final) process.stdout.write(`${final}\n`);
      return;
    }
    process.stdout.write("\r\x1b[2K");
    if (final) process.stdout.write(`${final}\n`);
  }
}
