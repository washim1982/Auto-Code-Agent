#!/usr/bin/env node
import { log } from "@aca/core";
import { Daemon } from "./server.ts";
import { registerMethods } from "./methods.ts";

const logger = log.child("daemon");
const daemon = new Daemon({ logger });
const { pool } = registerMethods(daemon);

const info = await daemon.start();
process.stdout.write(
  JSON.stringify({ port: info.port, pid: info.pid, startedAt: info.startedAt }) + "\n",
);

const shutdown = async (signal: string): Promise<void> => {
  logger.info("shutting down", { signal });
  await daemon.stop();
  pool.closeAll();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
