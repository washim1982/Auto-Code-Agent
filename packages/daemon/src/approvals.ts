import type { Approval, ApprovalResponse } from "@aca/protocol";
import type { RpcNotification } from "./rpc.ts";
import { notify } from "./rpc.ts";

interface Pending {
  approval: Approval;
  resolve: (r: ApprovalResponse) => void;
  timer: NodeJS.Timeout | null;
}

/**
 * Fans an approval request to every attached client; the first answer wins.
 *
 * "First wins" is the behaviour that makes two front-ends genuinely equivalent
 * rather than one being primary: a run started in the desktop app can be
 * approved from the terminal, and neither client needs to know the other
 * exists. Late answers are discarded rather than queued, because a second
 * verdict on a decision already acted on is meaningless.
 */
export class ApprovalBroker {
  private pending = new Map<string, Pending>();
  private clients = new Map<string, (n: RpcNotification) => void>();
  private timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    // Deliberately long. A human deliberating over an irreversible action is
    // the system working, not a stall — and the node holds its locks meanwhile.
    this.timeoutMs = options.timeoutMs ?? 30 * 60_000;
  }

  attach(clientId: string, send: (n: RpcNotification) => void): void {
    this.clients.set(clientId, send);
    // A client joining mid-flight must see outstanding approvals, or a run
    // looks hung to whoever just connected.
    for (const p of this.pending.values()) {
      send(notify("approval.requested", { approval: p.approval }));
    }
  }

  detach(clientId: string): void {
    this.clients.delete(clientId);
  }

  get outstanding(): Approval[] {
    return [...this.pending.values()].map((p) => p.approval);
  }

  request(approval: Approval): Promise<ApprovalResponse> {
    if (this.clients.size === 0) {
      // Nobody can answer. Denying is the safe default — silently proceeding
      // would defeat the entire point of an approval gate.
      return Promise.resolve({
        approvalId: approval.id,
        granted: false,
        scope: "once",
        reason: "no client attached to answer",
      });
    }

    return new Promise<ApprovalResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(approval.id);
        resolve({
          approvalId: approval.id,
          granted: false,
          scope: "once",
          reason: `no response within ${Math.round(this.timeoutMs / 60000)} minutes`,
        });
      }, this.timeoutMs);
      timer.unref?.();

      this.pending.set(approval.id, { approval, resolve, timer });
      this.broadcast(notify("approval.requested", { approval }));
    });
  }

  respond(response: ApprovalResponse): boolean {
    const p = this.pending.get(response.approvalId);
    if (!p) return false; // already answered by another client, or timed out
    this.pending.delete(response.approvalId);
    if (p.timer) clearTimeout(p.timer);
    p.resolve(response);
    this.broadcast(notify("approval.resolved", { approvalId: response.approvalId }));
    return true;
  }

  broadcast(n: RpcNotification): void {
    for (const send of this.clients.values()) {
      try {
        send(n);
      } catch {
        // A dead socket must not break the fan-out to healthy clients.
      }
    }
  }
}
