import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Db,
  EpochCache,
  EventLog,
  MemoryStore,
  OutputGuard,
  PersonaRegistry,
  WorkspaceRegistry,
  loadConfig,
  SecretStore,
  type AcaConfig,
  type Embedder,
} from "@aca/core";
import {
  currentBranch,
  fileTree,
  registerBuiltins,
  ToolRegistry,
  workspaceMap,
  type TreeEntry,
} from "@aca/tools";
import { discoverProviders, ModelRouter, ResidencyManager } from "@aca/providers";

export interface WorkspaceServices {
  root: string;
  name: string;
  config: AcaConfig;
  db: Db;
  events: EventLog;
  cache: EpochCache;
  guard: OutputGuard;
  memory: MemoryStore;
  tools: ToolRegistry;
  personas: PersonaRegistry;
  router: ModelRouter;
  residency: ResidencyManager;
  registry: WorkspaceRegistry;
  workspaceId: string;
  branch: string | null;
  skippedProviders: { id: string; reason: string }[];
  close(): void;
}

/**
 * Opens a workspace and wires every service it needs.
 *
 * This exists because three front-ends — CLI, daemon and desktop — all need
 * the identical bundle, and letting each assemble its own is how they drift
 * into holding different databases for the same repo.
 */
export async function openWorkspace(
  root: string,
  options: { localOnly?: boolean; pinnedModel?: string } = {},
): Promise<WorkspaceServices> {
  const registry = new WorkspaceRegistry();
  const entry = registry.add(root);
  const { config } = loadConfig({ workspaceRoot: root });
  const secrets = new SecretStore();

  const db = new Db(WorkspaceRegistry.dbPath(root));
  const events = new EventLog(db);
  const cache = new EpochCache(db, events);
  const guard = new OutputGuard({ artifactDir: WorkspaceRegistry.artifactDir(root) });
  const tools = new ToolRegistry();
  registerBuiltins(tools);

  const localOnly = options.localOnly ?? config.router.privacy === "local-only";
  const anthropicKey = secrets.get("ANTHROPIC_API_KEY");
  const openaiKey = secrets.get("OPENAI_API_KEY");

  const { providers, skipped } = await discoverProviders({
    ollamaHost: config.providers.ollamaHost,
    lmStudioHost: config.providers.lmStudioHost,
    llamaCppHost: config.providers.llamaCppHost,
    localOnly,
    ...(anthropicKey ? { anthropicKey } : {}),
    ...(openaiKey ? { openaiKey } : {}),
  });

  const router = new ModelRouter(providers);
  const pinned = options.pinnedModel ?? config.router.pinnedModel;
  if (pinned) {
    const catalogue = await router.catalogue(true);
    const match =
      catalogue.find((m) => m.id === pinned) ??
      catalogue.find((m) => m.id.toLowerCase().includes(pinned.toLowerCase()));
    if (match) router.pin(match.id);
  }

  const memory = new MemoryStore(db, makeEmbedder(router, config.memory.embeddingModel));

  return {
    root,
    name: entry.name,
    config,
    db,
    events,
    cache,
    guard,
    memory,
    tools,
    personas: new PersonaRegistry(),
    router,
    residency: new ResidencyManager(providers),
    registry,
    workspaceId: entry.id,
    branch: currentBranch(root),
    skippedProviders: skipped,
    close: () => db.close(),
  };
}

/**
 * Embeddings via whichever provider actually has an embedding model.
 *
 * Returns null when none does, and `MemoryStore` degrades to BM25 rather than
 * failing — a text-only index is far more useful than no index.
 */
export function makeEmbedder(router: ModelRouter, preferredModel: string): Embedder | null {
  return async (texts: string[]): Promise<number[][]> => {
    const catalogue = await router.catalogue();
    const model =
      catalogue.find((m) => m.id === preferredModel) ??
      catalogue.find((m) => /embed/i.test(m.id));
    if (!model) throw new Error("no embedding model available");

    const provider = router.provider(model.provider);
    if (!provider?.embed) throw new Error(`${model.provider} cannot embed`);
    return await provider.embed(texts, model.id);
  };
}

export interface IndexProgress {
  done: number;
  total: number;
  file: string;
}

/**
 * Indexes the workspace into T3.
 *
 * Skips anything the workspace map excludes, so `node_modules` never lands in
 * the index — it would swamp every query and cost most of the embedding time.
 */
export async function indexWorkspace(
  services: WorkspaceServices,
  onProgress?: (p: IndexProgress) => void,
): Promise<{ files: number; chunks: number; skipped: number }> {
  const listing = workspaceMap(services.root, { maxFiles: 5000, maxDepth: 12 });
  const files = listing
    .split("\n")
    .map((line) => line.replace(/\s+\([^)]*\)$/, "").trim())
    .filter((f) => f && !f.startsWith("...") && isIndexable(f));

  let chunks = 0;
  let skipped = 0;

  for (const [i, file] of files.entries()) {
    onProgress?.({ done: i + 1, total: files.length, file });
    try {
      const content = readFileSync(join(services.root, file), "utf8");
      // A minified bundle is one 3MB line: it produces useless chunks and
      // dominates embedding cost.
      if (content.length > 400_000 || isMinified(content)) {
        skipped++;
        continue;
      }
      const result = await services.memory.indexFile(file, content);
      if (result.skipped) skipped++;
      else chunks += result.chunks;
    } catch {
      skipped++;
    }
  }

  // Tell the registry, so the launcher and `ws list` stop claiming stale.
  const stats = services.memory.indexStats();
  services.registry.setIndexState(services.workspaceId, stats.chunks, false);

  return { files: files.length, chunks, skipped };
}

function isIndexable(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|java|c|h|cpp|cs|rb|php|sh|yml|yaml|toml|sql)$/i.test(
    path,
  );
}

function isMinified(content: string): boolean {
  const lines = content.split("\n");
  return lines.length > 0 && content.length / lines.length > 400;
}

export function treeFor(services: WorkspaceServices, runId?: string): TreeEntry[] {
  const locks = new Map<string, string>();
  if (runId) {
    for (const row of services.db.all(
      "SELECT resource, node_id FROM locks WHERE run_id = ?",
      runId,
    )) {
      locks.set(String(row["resource"]), String(row["node_id"]));
    }
  }
  const indexed = new Set(
    services.db.all("SELECT source FROM index_files").map((r) => String(r["source"])),
  );
  return fileTree(services.root, { locks, indexedSources: indexed });
}
