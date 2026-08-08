import { homedir } from "node:os";
import { join } from "node:path";

export interface DaemonInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: number;
  /** Identifies the engine bundle, so a desktop never adopts stale code. */
  engineBuild: string;
}

export const DAEMON_INFO_PATH = join(homedir(), ".aca", "daemon.json");
