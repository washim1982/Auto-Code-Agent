export { Db, type Row } from "./db/client.ts";
export { EventLog, type EventListener } from "./events/log.ts";
export { fold, type FoldedRun, type FoldedNode } from "./events/fold.ts";

export {
  canonicalSort,
  intersection,
  normalizeResource,
  resourcesIntersect,
  setsIntersect,
} from "./scheduler/resource.ts";
export { LockManager, type LockOutcome, type LockRequest } from "./scheduler/locks.ts";
export { cascadeInvalidate, type CascadeResult } from "./scheduler/cascade.ts";

export {
  CapabilityMismatch,
  classify,
  ContractUnmet,
  GateFailure,
  isRetryable,
  WriteSetViolation,
  type ClassifyInput,
} from "./recovery/classifier.ts";

export {
  estimateTokens,
  ReviewLoop,
  semanticHash,
  type Critique,
  type ReviewDecision,
} from "./review/loop.ts";

export { EpochCache, type CacheKeyInput } from "./cache/epoch.ts";
export { Cancelled, CancellationToken } from "./run/cancellation.ts";
export { EmptyResultStreak, exhaustedNotice } from "./run/tool-streak.ts";
export { StepBudget, lowStepsNotice, type StepBudgetOptions } from "./run/step-budget.ts";
export {
  NodeBrief,
  BRIEF_SYSTEM,
  renderBrief,
  isBlocked,
} from "./run/brief.ts";
export {
  ReadBudget,
  READ_ONLY_TOOLS,
  mustWriteNow,
  writeOnlyNotice,
  type ReadBudgetOptions,
} from "./run/read-budget.ts";
export {
  compactMessages,
  messageTokens,
  type CompactOptions,
  type CompactResult,
} from "./run/compaction.ts";
export { OutputGuard, type GuardedOutput } from "./guard/output-guard.ts";
export {
  ContextAssembler,
  type ContextLayer,
  type AssembledContext,
} from "./context/assembler.ts";
export { runGates, gateDetail, type GateRunner, type GateContext } from "./gates/vector.ts";
export { BudgetMeter, BudgetExceeded, type BudgetLimits } from "./budget/meter.ts";
export { escalatingFailures, retryableFailures } from "./gates/vector.ts";
export {
  RunSupervisor,
  type NodeExecution,
  type RunOutcome,
  type SupervisorHooks,
  type SupervisorOptions,
} from "./run/supervisor.ts";
export { WorkspaceRegistry, type WorkspaceEntry } from "./workspace/registry.ts";
export { ChatThread, toolResultMessage, type StoredMessage } from "./chat/thread.ts";
export { CompiledSpec, PlannedDag, PlannedNode } from "./plan/schema.ts";
export {
  findCycle,
  renderProblems,
  validatePlan,
  type PlanProblem,
  type ValidationResult,
} from "./plan/validate.ts";
export {
  Planner,
  PlanValidationError,
  toPlan,
  type PlannerOptions,
  type PlanResult,
  type StructuredGenerator,
} from "./plan/planner.ts";
export { normalizeDag, type NormalizeNote } from "./plan/normalize.ts";
export {
  InputGuard,
  luhn,
  type GuardFinding,
  type InputGuardOptions,
  type InputGuardResult,
} from "./guard/input-guard.ts";
export { PersonaRegistry, type Persona } from "./persona/registry.ts";
export { AcaConfig, loadConfig, SecretStore, type ConfigSource } from "./config/config.ts";
export {
  log,
  Logger,
  redactSecrets,
  type LogLevel,
  type LoggerOptions,
} from "./logging/logger.ts";
export { chunkFile, type Chunk, type ChunkOptions } from "./memory/chunker.ts";
export {
  cosineSimilarity,
  fromBlob,
  reciprocalRankFusion,
  toBlob,
  type Ranked,
} from "./memory/retrieval.ts";
export { MemoryStore, type Embedder, type Lesson, type Retrieved } from "./memory/store.ts";
export { ScorecardStore, type StoredScorecard } from "./memory/scorecards.ts";
export { MemoryWriteback, type WritebackOptions } from "./memory/writeback.ts";
