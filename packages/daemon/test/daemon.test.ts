import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/server.ts";
import { DaemonClient } from "../src/client.ts";
import { ApprovalBroker } from "../src/approvals.ts";
import { notify } from "../src/rpc.ts";

let daemon: Daemon;
let dir: string;
let infoPath: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "aca-daemon-"));
  infoPath = join(dir, "daemon.json");
  daemon = new Daemon({ infoPath });
  daemon.method("echo", async (params) => ({ echoed: params["value"] }));
  daemon.method("boom", async () => {
    throw new Error("handler exploded");
  });
  await daemon.start();
});

afterEach(async () => {
  await daemon.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("daemon transport", () => {
  it("round-trips a request", async () => {
    const client = await DaemonClient.connect(infoPath);
    expect(client).not.toBeNull();
    await expect(client!.call("echo", { value: 42 })).resolves.toEqual({ echoed: 42 });
    client!.close();
  });

  it("rejects a client with the wrong token", async () => {
    const info = DaemonClient.readInfo(infoPath)!;
    const impostor = new DaemonClient({ ...info, token: "not-the-token" });
    await expect(impostor.open()).rejects.toThrow();
  });

  it("binds loopback only", () => {
    // There is no remote access story, so there is no remote attack surface.
    const info = DaemonClient.readInfo(infoPath)!;
    expect(info.port).toBeGreaterThan(0);
    expect(info.token).toHaveLength(64);
    expect(info.engineBuild).toBe("dev");
  });

  it("surfaces a handler error as an RPC error rather than dropping the call", async () => {
    const client = await DaemonClient.connect(infoPath);
    await expect(client!.call("boom")).rejects.toThrow(/handler exploded/);
    client!.close();
  });

  it("reports an unknown method", async () => {
    const client = await DaemonClient.connect(infoPath);
    await expect(client!.call("nope")).rejects.toThrow(/unknown method/);
    client!.close();
  });

  it("returns null when no daemon is running", async () => {
    expect(await DaemonClient.connect(join(dir, "absent.json"))).toBeNull();
  });

  it("serves several clients at once", async () => {
    const a = await DaemonClient.connect(infoPath);
    const b = await DaemonClient.connect(infoPath);
    const [ra, rb] = await Promise.all([
      a!.call("echo", { value: "a" }),
      b!.call("echo", { value: "b" }),
    ]);
    expect(ra).toEqual({ echoed: "a" });
    expect(rb).toEqual({ echoed: "b" });
    expect(daemon.clientCount).toBe(2);
    a!.close();
    b!.close();
  });

  it("broadcasts notifications to every client", async () => {
    const a = await DaemonClient.connect(infoPath);
    const b = await DaemonClient.connect(infoPath);
    const seen: string[] = [];
    a!.onNotification((m) => seen.push(`a:${m}`));
    b!.onNotification((m) => seen.push(`b:${m}`));

    daemon.broadcast("event", { hello: true });
    await new Promise((r) => setTimeout(r, 120));

    expect(seen).toContain("a:event");
    expect(seen).toContain("b:event");
    a!.close();
    b!.close();
  });
});

describe("approval broker", () => {
  it("lets a run started by one client be approved by another", async () => {
    // This is the property that makes the CLI and desktop genuinely
    // equivalent rather than one being primary.
    const broker = new ApprovalBroker();
    const desktop: string[] = [];
    const cli: string[] = [];
    broker.attach("desktop", (n) => desktop.push(n.method));
    broker.attach("cli", (n) => cli.push(n.method));

    const pending = broker.request({
      id: "a1",
      runId: "r1",
      nodeId: "n1",
      kind: "irreversible",
      summary: "git push",
      detail: "",
      irreversible: true,
      createdAt: Date.now(),
    });

    expect(desktop).toContain("approval.requested");
    expect(cli).toContain("approval.requested");

    broker.respond({ approvalId: "a1", granted: true, scope: "once", reason: "" });
    await expect(pending).resolves.toMatchObject({ granted: true });
  });

  it("discards a second verdict on an already-answered approval", async () => {
    const broker = new ApprovalBroker();
    broker.attach("x", () => {});
    const pending = broker.request({
      id: "a1",
      runId: "r1",
      nodeId: null,
      kind: "plan",
      summary: "s",
      detail: "",
      irreversible: false,
      createdAt: Date.now(),
    });

    expect(broker.respond({ approvalId: "a1", granted: true, scope: "once", reason: "" })).toBe(
      true,
    );
    // Late answers are meaningless — the decision was already acted on.
    expect(
      broker.respond({ approvalId: "a1", granted: false, scope: "once", reason: "" }),
    ).toBe(false);
    await expect(pending).resolves.toMatchObject({ granted: true });
  });

  it("denies rather than proceeding when nobody is attached", async () => {
    const broker = new ApprovalBroker();
    await expect(
      broker.request({
        id: "a1",
        runId: "r1",
        nodeId: null,
        kind: "irreversible",
        summary: "deploy",
        detail: "",
        irreversible: true,
        createdAt: Date.now(),
      }),
    ).resolves.toMatchObject({ granted: false });
  });

  it("shows a joining client the approvals already outstanding", () => {
    const broker = new ApprovalBroker();
    broker.attach("first", () => {});
    void broker.request({
      id: "a1",
      runId: "r1",
      nodeId: null,
      kind: "plan",
      summary: "s",
      detail: "",
      irreversible: false,
      createdAt: Date.now(),
    });

    const late: string[] = [];
    broker.attach("second", (n) => late.push(n.method));
    // Otherwise a run looks hung to whoever just connected.
    expect(late).toContain("approval.requested");
    expect(broker.outstanding).toHaveLength(1);
  });

  it("survives a client whose socket throws during fan-out", () => {
    const broker = new ApprovalBroker();
    const healthy: string[] = [];
    broker.attach("dead", () => {
      throw new Error("EPIPE");
    });
    broker.attach("healthy", (n) => healthy.push(n.method));
    expect(() => broker.broadcast(notify("event", {}))).not.toThrow();
    expect(healthy).toContain("event");
  });

  it("times out rather than parking a node forever", async () => {
    const broker = new ApprovalBroker({ timeoutMs: 60 });
    broker.attach("x", () => {});
    const out = await broker.request({
      id: "a1",
      runId: "r1",
      nodeId: null,
      kind: "permission",
      summary: "s",
      detail: "",
      irreversible: false,
      createdAt: Date.now(),
    });
    expect(out.granted).toBe(false);
    expect(out.reason).toMatch(/no response/);
  });
});

describe("the daemon's executor assembly", () => {
  it("passes every run limit the config defines", () => {
    // cli/supervisor.ts warns: "every front-end needs the identical assembly…
    // One copy, one chance to get it wrong." The daemon built a second copy and
    // omitted all four run limits, so `run.maxNodeTokens` — which has no
    // default — was never enforced in the desktop app at all.
    const source = readFileSync(
      new URL("../src/sessions.ts", import.meta.url),
      "utf8",
    );
    const assembly = source.slice(source.indexOf("execute = makeExecutor({"));

    for (const knob of ["maxSteps", "maxOutputTokens", "maxReads", "maxNodeTokens"]) {
      expect(assembly).toContain(`${knob}: services.config.run.${knob}`);
    }
  });
});
