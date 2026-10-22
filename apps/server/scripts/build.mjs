import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.join(here, "..");
const agentRoot = path.join(serverRoot, "..", "agent");
const watch = process.argv.includes("--watch");

// 1) Renderer build (includes the headless entry).
console.log("[build] vite renderer (with headless entry)...");
execFileSync("npx vite build", {
  cwd: agentRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
});

// 2) Copy renderer output to the server's public dir.
const publicDir = path.join(serverRoot, "public");
fs.rmSync(publicDir, { recursive: true, force: true });
fs.cpSync(path.join(agentRoot, "dist", "renderer"), publicDir, { recursive: true });
console.log(`[build] public UI -> ${publicDir}`);

// 3) Bundle the headless server (ESM; shared code inlined).
/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: [path.join(serverRoot, "src", "server.ts")],
  outfile: path.join(serverRoot, "dist", "server.js"),
  bundle: true,
  platform: "node",
  target: ["node20"],
  format: "esm",
  sourcemap: true,
  alias: {
    "@aegis/shared": path.join(serverRoot, "..", "..", "packages", "shared", "src", "index.ts"),
  },
  define: {
    AEGIS_AGENT_VERSION: JSON.stringify("0.1.0"),
  },
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
  console.log("[build] server bundle -> dist/server.js");
}
