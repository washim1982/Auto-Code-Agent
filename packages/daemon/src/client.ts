import { existsSync, readFileSync } from "node:fs";
import { WebSocket } from "ws";
import { DAEMON_INFO_PATH, type DaemonInfo } from "./info.ts";
import type { RpcNotification, RpcResponse } from "./rpc.ts";

export type NotificationHandler = (method: string, params: Record<string, unknown>) => void;

/**
 * Thin JSON-RPC client. Both front-ends use this and nothing else.
 *
 * The rule it exists to enforce: neither the CLI nor the desktop app may hold
 * run state. If a front-end can only reach the engine through these calls, the
 * two clients cannot drift out of agreement about what a run is doing.
 */
export class DaemonClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private waiting = new Map<
    string | number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private handlers = new Set<NotificationHandler>();
  private url: string;

  constructor(info: DaemonInfo) {
    this.url = `ws://127.0.0.1:${info.port}?token=${info.token}`;
  }

  static readInfo(path = DAEMON_INFO_PATH): DaemonInfo | null {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as DaemonInfo;
    } catch {
      return null;
    }
  }

  /** Connects to a running daemon, or returns null if none is up. */
  static async connect(path = DAEMON_INFO_PATH): Promise<DaemonClient | null> {
    const info = DaemonClient.readInfo(path);
    if (!info) return null;
    const client = new DaemonClient(info);
    try {
      await client.open();
      return client;
    } catch {
      // A stale info file from a crashed daemon looks identical to a live one
      // until you try to connect.
      return null;
    }
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      const onError = (err: Error): void => reject(err);

      socket.once("error", onError);
      // A rejected upgrade arrives here rather than as a socket error.
      socket.once("unexpected-response", (_req, res) => {
        reject(new Error(`daemon refused the connection: ${res.statusCode}`));
      });
      socket.once("open", () => {
        socket.off("error", onError);
        this.socket = socket;
        resolve();
      });

      socket.on("message", (data) => {
        let frame: RpcResponse | RpcNotification;
        try {
          frame = JSON.parse(String(data)) as RpcResponse | RpcNotification;
        } catch {
          return;
        }

        if ("id" in frame && frame.id != null) {
          const pending = this.waiting.get(frame.id);
          if (!pending) return;
          this.waiting.delete(frame.id);
          if (frame.error) pending.reject(new Error(frame.error.message));
          else pending.resolve(frame.result);
          return;
        }

        if ("method" in frame) {
          for (const h of this.handlers) h(frame.method, frame.params ?? {});
        }
      });

      socket.on("close", () => {
        this.socket = null;
        for (const p of this.waiting.values()) p.reject(new Error("daemon connection closed"));
        this.waiting.clear();
      });
    });
  }

  onNotification(handler: NotificationHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("not connected to the daemon");
    }
    const id = this.nextId++;
    return await new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.socket!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}
