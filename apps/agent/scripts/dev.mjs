import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const isWin = process.platform === "win32";
const require = createRequire(import.meta.url);
const electronBin = require("electron"); // resolves to the electron executable path
// vite 6 no longer exports ./bin/vite.js; resolve it via the package root.
const viteBin = path.join(path.dirname(require.resolve("vite/package.json")), "bin", "vite.js");
const devUrl = process.env.VITE_DEV_SERVER_URL || "http://localhost:5173";

let shuttingDown = false;
const children = [];
let electronProc = null;
let lastElectronStart = 0;
let restartQueued = false;
let restarting = false;

function track(child, label) {
  children.push(child);
  child.on("exit", (code, signal) => {
    if (!shuttingDown) console.log(`[dev] ${label} exited (code=${code}${signal ? ` signal=${signal}` : ""})`);
  });
  return child;
}

function killTree(child) {
  if (!child || !child.pid) return;
  if (isWin) {
    try {
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => {});
    } catch {
      /* ignore */
    }
  } else {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) killTree(c);
  setTimeout(() => process.exit(code), 400);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// 1. Bundle main/preload in watch mode.
track(spawn(process.execPath, [path.join(here, "build-main.mjs"), "--watch"], { stdio: "inherit", cwd: root }), "esbuild");

// 2. Vite dev server for the renderer.
track(spawn(process.execPath, [viteBin], { stdio: "inherit", cwd: root }), "vite");

async function waitFor(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function launchElectron() {
  electronProc = spawn(electronBin, [".", "--dev"], {
    stdio: "inherit",
    cwd: root,
    env: { ...process.env, VITE_DEV_SERVER_URL: devUrl },
  });
  lastElectronStart = Date.now();
  track(electronProc, "electron");
}

function scheduleRestart() {
  if (restartQueued || shuttingDown) return;
  restartQueued = true;
  setTimeout(() => {
    restartQueued = false;
    restartElectron();
  }, 500);
}

function restartElectron() {
  if (restarting || shuttingDown) return;
  if (!electronProc) return;
  restarting = true;
  console.log("[dev] main/preload rebuilt — restarting electron");
  killTree(electronProc);
  electronProc = null;
  setTimeout(() => {
    launching();
  }, 600);
  function launching() {
    if (!shuttingDown) launchElectron();
    restarting = false;
  }
}

// Restart electron when the bundled main/preload changes.
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.watch(path.join(root, "dist"), (_event, filename) => {
  if (!filename || !String(filename).endsWith(".js")) return;
  if (Date.now() - lastElectronStart < 2000) return;
  if (!electronProc) return;
  scheduleRestart();
});

const mainJs = path.join(root, "dist", "main.js");
const built = fs.existsSync(mainJs)
  ? Promise.resolve(true)
  : (async () => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if (fs.existsSync(mainJs)) return true;
        await new Promise((r) => setTimeout(r, 300));
      }
      return false;
    })();

const ready = await Promise.all([built, waitFor(devUrl)]);
if (ready[0] && ready[1] && !shuttingDown) {
  console.log(`[dev] renderer ready at ${devUrl} — launching electron`);
  launchElectron();
} else {
  console.error("[dev] failed to start (renderer or main bundle never became ready)");
  shutdown(1);
}
