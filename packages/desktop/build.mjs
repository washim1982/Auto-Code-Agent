import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const shared = { bundle: true, platform: "node", target: "node20", external: ["electron"], logLevel: "info" };

// Main and preload are CommonJS: Electron's preload loader does not take ESM.
await build({ ...shared, entryPoints: ["src/main/index.ts"], outfile: "dist/main/index.cjs", format: "cjs" });
await build({ ...shared, entryPoints: ["src/preload/index.ts"], outfile: "dist/preload/index.cjs", format: "cjs" });

// The engine, bundled into the app.
//
// An installed copy has no repo to run `tsx` against, so the daemon ships as
// one compiled file and is launched with Electron's own Node — which is the
// only reason no separate Node install is needed. `node:sqlite` stays external
// because it is a builtin of that runtime.
// ESM, unlike main and preload: the daemon entry awaits at the top level, and
// it is spawned as its own process rather than loaded by Electron's CJS loader.
await build({
  ...shared,
  entryPoints: ["../daemon/src/bin.ts"],
  outfile: "dist/daemon/index.mjs",
  format: "esm",
  external: ["electron", "node:sqlite"],
  // `ws` is CommonJS and calls require() for Node builtins. esbuild's ESM
  // output stubs that out with a throwing shim unless a real require exists,
  // so hand it one.
  banner: {
    js: [
      `import { createRequire as __nodeCreateRequire } from "node:module";`,
      `const require = __nodeCreateRequire(import.meta.url);`,
    ].join("\n"),
  },
});

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
