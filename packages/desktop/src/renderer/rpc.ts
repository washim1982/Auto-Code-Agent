export type NotificationHandler = (method: string, params: Record<string, unknown>) => void;

declare global {
  interface Window {
    aca: {
      daemonInfo(): Promise<{ port: number; token: string } | null>;
      pickWorkspace(): Promise<string | null>;
    };
  }
}

/**
 * Browser-side JSON-RPC client.
 *
 * Deliberately a near-copy of the Node client rather than a shared module:
 * that one imports `ws`, which does not exist in a renderer, and the shared
 * abstraction to bridge them would be larger than the duplication. The wire
 * format is the contract; both ends implement it.
 */
export class RendererClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private waiting = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private handlers = new Set<NotificationHandler>();
  private reconnectAttempts = 0;

  async connect(): Promise<void> {
    const info = await window.aca.daemonInfo();
    if (!info) throw new Error("daemon unavailable");

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${info.port}?token=${info.token}`);
      socket.onopen = (): void => {
        this.socket = socket;
        this.reconnectAttempts = 0;
        resolve();
      };
      socket.onerror = (): void => reject(new Error("could not reach the daemon"));
      socket.onmessage = (event): void => this.onMessage(String(event.data));
      socket.onclose = (): void => {
        this.socket = null;
        for (const p of this.waiting.values()) p.reject(new Error("connection closed"));
        this.waiting.clear();
        // The daemon outlives the window by design, but it can still be
        // restarted underneath us; backing off and retrying beats showing a
        // dead UI.
        this.scheduleReconnect();
      };
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts > 8) return;
    const delay = Math.min(500 * 2 ** this.reconnectAttempts++, 10_000);
    setTimeout(() => void this.connect().catch(() => undefined), delay);
  }

  private onMessage(raw: string): void {
    let frame: {
      id?: number;
      result?: unknown;
      error?: { message: string };
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }

    if (frame.id != null) {
      const pending = this.waiting.get(frame.id);
      if (!pending) return;
      this.waiting.delete(frame.id);
      if (frame.error) pending.reject(new Error(frame.error.message));
      else pending.resolve(frame.result);
      return;
    }
    if (frame.method) {
      for (const h of this.handlers) h(frame.method, frame.params ?? {});
    }
  }

  onNotification(handler: NotificationHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("not connected");
    }
    const id = this.nextId++;
    return await new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.socket!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }
}
