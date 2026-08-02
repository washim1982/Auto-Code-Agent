import { isAbsolute, relative, resolve, sep } from "node:path";

export class PathEscape extends Error {
  readonly requested: string;

  constructor(requested: string) {
    super(`path escapes the workspace: ${requested}`);
    this.name = "PathEscape";
    this.requested = requested;
  }
}

/**
 * Resolves a caller-supplied path inside the workspace, or throws.
 *
 * On Windows there is no seccomp or bind-mount equivalent, so this function IS
 * the jail for in-process tools. It has to handle `..` traversal, absolute
 * paths, and symlink-ish trickery in the string domain, because we cannot rely
 * on the OS to stop us.
 */
export function resolveInWorkspace(root: string, requested: string): string {
  const absRoot = resolve(root);
  const abs = isAbsolute(requested) ? resolve(requested) : resolve(absRoot, requested);
  const rel = relative(absRoot, abs);
  if (rel === "") return abs;
  if (rel.startsWith("..") || isAbsolute(rel)) throw new PathEscape(requested);
  return abs;
}

/** Workspace-relative, forward-slashed — the form resource ids use. */
export function toResourceId(root: string, absPath: string): string {
  return relative(resolve(root), resolve(absPath)).split(sep).join("/");
}
