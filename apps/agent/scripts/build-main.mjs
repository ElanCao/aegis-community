import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: [
    path.join(root, "electron", "main.ts"),
    path.join(root, "electron", "preload.ts"),
  ],
  outdir: path.join(root, "dist"),
  bundle: true,
  platform: "node",
  target: ["node20"],
  format: "cjs",
  sourcemap: true,
  external: ["electron"],
  alias: {
    "@aegis/shared": path.join(root, "..", "..", "packages", "shared", "src", "index.ts"),
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
}
