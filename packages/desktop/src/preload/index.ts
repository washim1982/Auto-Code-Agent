import { contextBridge, ipcRenderer } from "electron";

/**
 * The entire surface the renderer gets.
 *
 * Two functions. No filesystem, no child processes, no direct network — the
 * renderer talks to the daemon over a WebSocket it opens itself, using
 * credentials handed to it here, and everything else is main-process work.
 * Keeping this list short is the whole point of the bridge; every addition is
 * a hole in the sandbox.
 */
contextBridge.exposeInMainWorld("aca", {
  daemonInfo: (): Promise<{ port: number; token: string } | null> =>
    ipcRenderer.invoke("daemon:info"),
  pickWorkspace: (): Promise<string | null> => ipcRenderer.invoke("dialog:openWorkspace"),
});
