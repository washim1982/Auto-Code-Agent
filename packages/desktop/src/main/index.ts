import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

const DAEMON_INFO = join(homedir(), ".aca", "daemon.json");

// Resolved from the bundle's own location, not `app.getAppPath()`: that
// returns the directory of the entry script when launched as
// `electron dist/main/index.cjs`, which silently produces
// `dist/main/dist/renderer/index.html`.
const DIST = join(__dirname, "..");

/**
 * The bundled engine.
 *
 * Kept outside the asar archive so it is a real file on disk: the daemon is
 * spawned as a subprocess, and a path inside an archive is not something an
 * arbitrary child process can be pointed at.
 */
const DAEMON_ENTRY = join(DIST, "daemon", "index.mjs").replace(
  `app.asar${sep}`,
  `app.asar.unpacked${sep}`,
);

let window: BrowserWindow | null = null;
let daemon: ChildProcess | null = null;

/**
 * Adopts a running daemon, or spawns one.
 *
 * Adoption matters more than it looks: a run started from the terminal must
 * still be visible here, and spawning a second daemon would give the desktop
 * its own database handle and its own idea of what is happening. If the info
 * file is stale from a crash, connecting fails and we spawn — which is why the
 * check is a real connection attempt rather than "does the file exist".
 */
async function ensureDaemon(): Promise<{ port: number; token: string } | null> {
  if (existsSync(DAEMON_INFO)) {
    try {
      const info = JSON.parse(readFileSync(DAEMON_INFO, "utf8")) as {
        port: number;
        token: string;
        pid: number;
      };
      // A live pid is a good enough liveness check to avoid a spawn race; the
      // renderer's first RPC call is the real one.
      process.kill(info.pid, 0);
      return { port: info.port, token: info.token };
    } catch {
      // stale info file — fall through and spawn
    }
  }

  // Electron's own binary, told to behave as Node. That runtime carries the
  // Node 22+ builtins the engine needs — `node:sqlite` above all — so an
  // installed copy needs nothing else on the machine. Dev takes the same path
  // as a shipped build rather than a `tsx` shortcut that only works in a repo.
  daemon = spawn(process.execPath, [DAEMON_ENTRY], {
    cwd: app.getPath("home"),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let stderr = "";
  daemon.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  daemon.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      dialog.showErrorBox(
        "The engine could not start",
        `The background engine exited with code ${code}.\n\n${stderr.trim()}`,
      );
    }
  });

  // Wait for the info file to appear rather than parsing stdout: the file is
  // the contract every client uses, so waiting on it tests the real path.
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (!existsSync(DAEMON_INFO)) continue;
    try {
      const info = JSON.parse(readFileSync(DAEMON_INFO, "utf8")) as {
        port: number;
        token: string;
      };
      if (info.port) return { port: info.port, token: info.token };
    } catch {
      // partially written; try again
    }
  }
  return null;
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: "#131519",
    titleBarStyle: "hiddenInset",
    // Packaged builds take the icon from the executable; this is what gives
    // the dev window the same one instead of the default Electron mark.
    icon: join(DIST, "..", "assets", "icon.png"),
    webPreferences: {
      // The renderer is a view. It cannot touch fs, child_process or the
      // network directly — everything goes through the preload bridge, which
      // exposes exactly one capability: talk to the daemon.
      preload: join(DIST, "preload", "index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  window.once("ready-to-show", () => window?.show());
  void window.loadFile(join(DIST, "renderer", "index.html"));

  // External links open in the real browser, never inside the app frame.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
}

ipcMain.handle("daemon:info", async () => await ensureDaemon());

ipcMain.handle("dialog:openWorkspace", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "Open a workspace",
  });
  return result.canceled ? null : result.filePaths[0];
});

void app.whenReady().then(async () => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // The daemon deliberately outlives the window: closing the UI must not kill
  // a running DAG, and the CLI can still attach to it.
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  // Only stop a daemon we started ourselves; an adopted one belongs to
  // whoever launched it.
  daemon?.kill("SIGTERM");
});
