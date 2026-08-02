import { z } from "zod";

/**
 * A resource is anything a node can read or write. Paths are normalised to
 * forward slashes, workspace-relative, and may end in a glob segment.
 *
 * Canonical ordering over resource ids is what makes lock acquisition
 * deadlock-free (flow review F3), so the normal form matters: two spellings of
 * the same path must produce the same id or the total order is a lie.
 */
export const ResourceId = z.string().min(1);
export type ResourceId = z.infer<typeof ResourceId>;

export const RunId = z.string().min(1);
export const NodeId = z.string().min(1);
export const ThreadId = z.string().min(1);
export const WorkspaceId = z.string().min(1);

/** Trust level of a piece of content entering a context window. */
export const Trust = z.enum(["trusted", "untrusted"]);
export type Trust = z.infer<typeof Trust>;

/**
 * How a tool call affects the world.
 * - `pure`         no side effects; cacheable (with epoch keys, F7)
 * - `mutating`     reversible via checkpoint/rollback
 * - `irreversible` cannot be rolled back; needs approval at execution time (F13)
 */
export const Purity = z.enum(["pure", "mutating", "irreversible"]);
export type Purity = z.infer<typeof Purity>;

/** Sandbox isolation tier (F10). */
export const SandboxTier = z.enum(["t0", "t1", "t2"]);
export type SandboxTier = z.infer<typeof SandboxTier>;

export const Permission = z.enum(["allow", "ask", "deny"]);
export type Permission = z.infer<typeof Permission>;

export const NodeStatus = z.enum([
  "pending",
  "ready",
  "running",
  "blocked",
  "parked",
  "review",
  "done",
  "failed",
  "rolled_back",
  "cancelled",
  "dirty", // requeued by cascade invalidation (F6)
]);
export type NodeStatus = z.infer<typeof NodeStatus>;

export const RunStatus = z.enum([
  "planning",
  "awaiting_approval",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatus>;
