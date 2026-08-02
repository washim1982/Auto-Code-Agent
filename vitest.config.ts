import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    // Vite's builtin list predates node:sqlite, so it tries to resolve it as a
    // bare package. Hand it back to Node.
    server: { deps: { external: [/^node:sqlite$/] } },
  },
  optimizeDeps: { exclude: ["node:sqlite"] },
});
