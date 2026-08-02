import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatChunk, ChatRequest } from "@aca/protocol";
import { CassetteProvider, scriptedChunks, scriptedProvider } from "../src/cassette.ts";
import { collectText } from "../src/discover.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aca-cassette-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const req: ChatRequest = {
  model: "m",
  messages: [{ role: "user", content: "what does foo do?" }],
};

describe("cassette provider", () => {
  it("records from a live provider then replays without it", async () => {
    const live = scriptedProvider(scriptedChunks({ text: "foo returns a bar" }));
    const recorder = new CassetteProvider({ dir, mode: "auto", inner: live });

    const first = await collectText(recorder.chat(req));
    expect(first.text).toBe("foo returns a bar");

    // No inner provider at all: replay must be self-sufficient, which is what
    // makes the suite runnable on a machine with no models installed.
    const replayer = new CassetteProvider({ dir, mode: "replay" });
    const second = await collectText(replayer.chat(req));
    expect(second.text).toBe("foo returns a bar");
  });

  it("preserves tool calls and usage through a round trip", async () => {
    const live = scriptedProvider(
      scriptedChunks({
        thinking: "considering",
        toolCalls: [{ name: "read_file", args: { path: "a.ts" } }],
        inputTokens: 321,
        outputTokens: 12,
      }),
    );
    await collectText(new CassetteProvider({ dir, mode: "auto", inner: live }).chat(req));

    const replayed = await collectText(new CassetteProvider({ dir, mode: "replay" }).chat(req));
    expect(replayed.toolCalls[0]).toMatchObject({ name: "read_file", args: { path: "a.ts" } });
    expect(replayed.thinking).toBe("considering");
    expect(replayed.usage.inputTokens).toBe(321);
  });

  it("fails loudly on a miss rather than silently hitting the network", async () => {
    const replayer = new CassetteProvider({ dir, mode: "replay" });
    await expect(collectText(replayer.chat(req))).rejects.toThrow(/cassette miss/);
  });

  it("keys on semantic content, so an unrelated refactor does not invalidate it", async () => {
    const live = scriptedProvider(scriptedChunks({ text: "answer" }));
    const recorder = new CassetteProvider({ dir, mode: "auto", inner: live });
    await collectText(recorder.chat(req));

    // Same conversation, differently described tools — still a hit, otherwise
    // every cassette misses after any refactor and CI quietly goes online.
    const replayer = new CassetteProvider({ dir, mode: "replay" });
    expect(
      replayer.has({
        ...req,
        tools: undefined,
      }),
    ).toBe(true);
  });

  it("treats a changed message as a different exchange", async () => {
    const live = scriptedProvider(scriptedChunks({ text: "answer" }));
    await collectText(new CassetteProvider({ dir, mode: "auto", inner: live }).chat(req));

    const replayer = new CassetteProvider({ dir, mode: "replay" });
    expect(
      replayer.has({ model: "m", messages: [{ role: "user", content: "different question" }] }),
    ).toBe(false);
  });

  it("re-records in record mode even when a recording exists", async () => {
    const first = scriptedProvider(scriptedChunks({ text: "old" }));
    await collectText(new CassetteProvider({ dir, mode: "auto", inner: first }).chat(req));

    const second = scriptedProvider(scriptedChunks({ text: "new" }));
    const rerecorder = new CassetteProvider({ dir, mode: "record", inner: second });
    expect((await collectText(rerecorder.chat(req))).text).toBe("new");
    expect(
      (await collectText(new CassetteProvider({ dir, mode: "replay" }).chat(req))).text,
    ).toBe("new");
  });

  it("streams chunks in order", async () => {
    const live = scriptedProvider(scriptedChunks({ thinking: "t", text: "hello" }));
    await collectText(new CassetteProvider({ dir, mode: "auto", inner: live }).chat(req));

    const kinds: ChatChunk["type"][] = [];
    for await (const c of new CassetteProvider({ dir, mode: "replay" }).chat(req)) {
      kinds.push(c.type);
    }
    expect(kinds).toEqual(["thinking", "text", "usage", "done"]);
  });
});
