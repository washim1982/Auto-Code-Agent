export { PathEscape, resolveInWorkspace, toResourceId } from "./paths.ts";
export { Checkpoint, DEFAULT_IGNORES, type VerifyResult } from "./checkpoint.ts";
export {
  execSandboxed,
  resolveExecutable,
  scrubEnv,
  UnsafeArgument,
  windowsSpawnArgs,
  type ExecOptions,
  type ExecResult,
} from "./sandbox/exec.ts";
export {
  DEFAULT_MATRIX,
  resolvePermission,
  ToolRegistry,
  zodToJsonSchema,
  type PermissionMatrix,
  type ToolContext,
  type ToolDef,
  type ToolResult,
} from "./registry.ts";
export { BUILTIN_TOOLS, globToRegExp, registerBuiltins } from "./builtins.ts";
export { workspaceMap, type MapOptions } from "./workspace-map.ts";
export {
  currentBranch,
  fileTree,
  gitStatus,
  type TreeEntry,
  type TreeOptions,
} from "./file-tree.ts";
