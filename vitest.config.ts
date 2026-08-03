import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // .tsx too: the TUI is a component, and asserting on a rendered frame is
    // the only way a change to it gets checked by anything but an eye.
    include: ["packages/*/test/**/*.test.ts", "packages/*/test/**/*.test.tsx"],
    environment: "node",
    testTimeout: 20_000,
    // Vite's builtin list predates node:sqlite, so it tries to resolve it as a
    // bare package. Hand it back to Node.
    server: { deps: { external: [/^node:sqlite$/] } },
  },
  optimizeDeps: { exclude: ["node:sqlite"] },
});
