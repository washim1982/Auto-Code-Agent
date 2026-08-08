/** Minimal shape persisted by both current and older daemon builds. */
export interface AdoptedDaemonInfo {
  engineBuild?: string;
}

export interface ActiveDaemonRun {
  status: string;
}

/** A missing build id means the daemon predates version handshaking. */
export function needsEngineReplacement(
  info: AdoptedDaemonInfo,
  expectedBuild: string,
): boolean {
  return info.engineBuild !== expectedBuild;
}

/**
 * Awaiting approval is live state too: replacing that daemon would discard the
 * in-memory plan even though no model call happens at that instant.
 */
export function hasUnfinishedRuns(runs: readonly ActiveDaemonRun[]): boolean {
  return runs.some((run) => run.status !== "done");
}
