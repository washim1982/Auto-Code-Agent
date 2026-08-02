import { z } from "zod";

export const RpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).nullable().optional(),
  method: z.string(),
  params: z.record(z.unknown()).optional(),
});
export type RpcRequest = z.infer<typeof RpcRequest>;

export interface RpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

export const ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unauthorized: -32000,
} as const;

export function ok(id: string | number | null, result: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function fail(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

export function notify(method: string, params: Record<string, unknown>): RpcNotification {
  return { jsonrpc: "2.0", method, params };
}

export type Handler = (
  params: Record<string, unknown>,
  ctx: { clientId: string; send: (n: RpcNotification) => void },
) => Promise<unknown>;
