/**
 * Rasterises assets/icon.svg into the PNG set and the Windows .ico.
 *
 * Uses Electron itself as the renderer rather than adding an image library:
 * the toolchain already ships a browser engine, and one that draws the icon
 * exactly as the app will draw it.
 *
 *   pnpm --filter auto-code-agent icons
 *
 * Progress goes to build/make-icons.log because Electron is a GUI subsystem
 * binary on Windows and its stdout does not reach the calling shell.
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow } from "electron";

// Every size Windows asks for, packed into the one .ico.
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const HERE = import.meta.dirname;
// Beside the SVG they come from: committed, so a build needs no GUI step.
const OUT = join(HERE, "assets");
const LOG = join(tmpdir(), "aca-make-icons.log");

mkdirSync(OUT, { recursive: true });
rmSync(LOG, { force: true });
const log = (msg) => appendFileSync(LOG, `${msg}\n`);

const die = (err) => {
  log(`FAILED: ${err?.stack ?? err}`);
  app.exit(1);
};
process.on("unhandledRejection", die);
process.on("uncaughtException", die);
// A window that never loads would otherwise hang with no output at all.
setTimeout(() => die(new Error("timed out after 60s")), 60_000).unref();

// Not top-level await: awaiting before the ready event in an ESM main process
// blocks the loop that would have fired it, and the app never starts.
app.whenReady().then(main).catch(die);

async function main() {
  log("electron ready");

  // An <img> in a transparent page, captured — rather than a canvas, whose
  // data-URL round trip silently never resolved for an SVG source.
  const page = join(tmpdir(), "aca-icon-render.html");
  writeFileSync(
    page,
    `<style>html,body{margin:0;background:transparent}img{display:block}</style>
<img src="${pathToFileURL(join(HERE, "assets", "icon.svg")).href}" width="512" height="512">`,
    "utf8",
  );

  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    useContentSize: true,
  });

  await win.loadFile(page);
  log("page loaded");
  // One frame, so the SVG is actually painted before the capture.
  await new Promise((r) => setTimeout(r, 400));

  const full = await win.webContents.capturePage();
  if (full.isEmpty()) return die(new Error("capturePage returned an empty image"));
  log(`captured ${JSON.stringify(full.getSize())}`);

  // 512 for the window and for platforms that take a PNG directly.
  writeFileSync(join(OUT, "icon.png"), full.toPNG());

  const pngs = SIZES.map((size) => {
    // Downscaled from the single 512 capture: one render, and Chromium's
    // filtering rather than seven separate rasterisations.
    const buf = full.resize({ width: size, height: size, quality: "best" }).toPNG();
    log(`  ${size}px  ${buf.length} bytes`);
    return buf;
  });

  writeFileSync(join(OUT, "icon.ico"), buildIco(pngs));
  rmSync(page, { force: true });
  log(`wrote assets/icon.png and assets/icon.ico (${SIZES.length} sizes)`);
  app.exit(0);
}

/**
 * Packs PNGs into an .ico.
 *
 * Every Windows version this app can run on reads PNG-compressed entries, so
 * there is no need to emit BMP bitmaps: a fixed-size directory followed by the
 * PNG bytes untouched.
 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach((png, i) => {
    const size = SIZES[i];
    const at = i * 16;
    // 256 is stored as 0: the field is one byte wide.
    directory.writeUInt8(size >= 256 ? 0 : size, at);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt8(0, at + 2); // palette size
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });

  return Buffer.concat([header, directory, ...images]);
}
