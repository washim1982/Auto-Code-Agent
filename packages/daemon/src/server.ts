import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { log, type Logger } from "@aca/core";
import { ApprovalBroker } from "./approvals.ts";
import {
  ERROR,
  fail,
  notify,
  ok,
  RpcRequest,
  type Handler,
  type RpcNotification,
} from "./rpc.ts";

export interface DaemonInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: number;
}

export const DAEMON_INFO_PATH = join(homedir(), ".aca", "daemon.json");

export interface DaemonOptions {
  port?: number;
  host?: string;
  infoPath?: string;
  logger?: Logger;
}

/**
 * JSON-RPC 2.0 over WebSocket, on loopback only.
 *
 * Security posture, deliberately narrow: bind to 127.0.0.1 so nothing routable
 * can reach it, and require a per-launch random token that is only obtainable
 * by reading a file in the user's home directory. That reduces "can talk to
 * the daemon" to "can read the user's files", at which point the daemon is not
 * the weakest link. There is no auth story beyond that because there is no
 * remote access story.
 */
export class Daemon {
  private wss: WebSocketServer | null = null;
  private http: Server | null = null;
  private handlers = new Map<string, Handler>();
  private clients = new Map<string, WebSocket>();
  readonly approvals = new ApprovalBroker();
  readonly token: string;
  private infoPath: string;
  private host: string;
  private requestedPort: number;
  private logger: Logger;
  private info: DaemonInfo | null = null;

  constructor(options: DaemonOptions = {}) {
    this.token = randomBytes(32).toString("hex");
    this.infoPath = options.infoPath ?? DAEMON_INFO_PATH;
    this.host = options.host ?? "127.0.0.1";
    this.requestedPort = options.port ?? 0; // 0 = let the OS choose
    this.logger = options.logger ?? log.child("daemon");
  }

  method(name: string, handler: Handler): this {
    this.handlers.set(name, handler);
    return this;
  }

  async start(): Promise<DaemonInfo> {
    this.http = createServer();
    this.wss = new WebSocketServer({
      server: this.http,
      // Authenticate during the HTTP upgrade, not after the socket opens.
      // Closing an already-open socket looks to the client like a successful
      // connection that mysteriously drops a moment later — the caller's
      // `connect()` resolves and only fails on the next call.
      verifyClient: ({ req }, done) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const presented = url.searchParams.get("token") ?? "";
        const valid = presented.length === this.token.length && presented === this.token;
        done(valid, 401, "unauthorized");
      },
    });

    this.wss.on("connection", (socket) => this.onClient(socket));

    await new Promise<void>((resolve, reject) => {
      this.http!.once("error", reject);
      this.http!.listen(this.requestedPort, this.host, resolve);
    });

    const address = this.http.address();
    const port = typeof address === "object" && address ? address.port : this.requestedPort;
    this.info = { port, token: this.token, pid: process.pid, startedAt: Date.now() };

    mkdirSync(join(this.infoPath, ".."), { recursive: true });
    writeFileSync(this.infoPath, JSON.stringify(this.info, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.infoPath, 0o600);
    } catch {
      // Windows ignores POSIX modes; the file is under the user profile anyway.
    }

    this.logger.info("listening", { port, pid: process.pid });
    return this.info;
  }

  private onClient(socket: WebSocket): void {
    const clientId = randomBytes(8).toString("hex");
    this.clients.set(clientId, socket);

    const send = (n: RpcNotification): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(n));
    };
    this.approvals.attach(clientId, send);
    this.logger.debug("client attached", { clientId, clients: this.clients.size });

    socket.on("message", (data) => {
      void this.dispatch(clientId, socket, String(data), send);
    });

    socket.on("close", () => {
      this.clients.delete(clientId);
      this.approvals.detach(clientId);
      this.logger.debug("client detached", { clientId, clients: this.clients.size });
    });

    socket.on("error", () => {
      this.clients.delete(clientId);
      this.approvals.detach(clientId);
    });
  }

  private async dispatch(
    clientId: string,
    socket: WebSocket,
    raw: string,
    send: (n: RpcNotification) => void,
  ): Promise<void> {
    let parsed: RpcRequest;
    try {
      parsed = RpcRequest.parse(JSON.parse(raw));
    } catch (err) {
      socket.send(JSON.stringify(fail(null, ERROR.parse, (err as Error).message)));
      return;
    }

    const id = parsed.id ?? null;
    const handler = this.handlers.get(parsed.method);
    if (!handler) {
      socket.send(
        JSON.stringify(fail(id, ERROR.methodNotFound, `unknown method ${parsed.method}`)),
      );
      return;
    }

    try {
      const result = await handler(parsed.params ?? {}, { clientId, send });
      // A notification (no id) expects no reply, per JSON-RPC.
      if (id !== null) socket.send(JSON.stringify(ok(id, result ?? null)));
    } catch (err) {
      this.logger.warn("handler failed", {
        method: parsed.method,
        error: (err as Error).message,
      });
      if (id !== null) {
        socket.send(JSON.stringify(fail(id, ERROR.internal, (err as Error).message)));
      }
    }
  }

  /** Sends a notification to every attached client. */
  broadcast(method: string, params: Record<string, unknown>): void {
    this.approvals.broadcast(notify(method, params));
  }

  get clientCount(): number {
    return this.clients.size;
  }

  async stop(): Promise<void> {
    for (const socket of this.clients.values()) socket.close(1001, "shutting down");
    this.clients.clear();
    await new Promise<void>((resolve) => this.wss?.close(() => resolve()));
    await new Promise<void>((resolve) => this.http?.close(() => resolve()));
    try {
      rmSync(this.infoPath, { force: true });
    } catch {
      // best effort — a stale info file is handled by the connect path
    }
    this.logger.info("stopped");
  }
}
