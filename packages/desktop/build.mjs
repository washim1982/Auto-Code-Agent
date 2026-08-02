import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const shared = { bundle: true, platform: "node", target: "node20", external: ["electron"], logLevel: "info" };

// Main and preload are CommonJS: Electron's preload loader does not take ESM.
await build({ ...shared, entryPoints: ["src/main/index.ts"], outfile: "dist/main/index.cjs", format: "cjs" });
await build({ ...shared, entryPoints: ["src/preload/index.ts"], outfile: "dist/preload/index.cjs", format: "cjs" });

// The renderer is a browser bundle with no Node access at all.
await build({
  bundle: true,
  platform: "browser",
  target: "chrome120",
  format: "esm",
  entryPoints: ["src/renderer/index.tsx"],
  outfile: "dist/renderer/index.js",
  jsx: "automatic",
  loader: { ".css": "css" },
  logLevel: "info",
});

mkdirSync("dist/renderer", { recursive: true });
cpSync("src/renderer/index.html", "dist/renderer/index.html");
console.log("desktop build complete");
