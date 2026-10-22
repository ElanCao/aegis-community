import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));
const sharedSrc = path.join(here, "..", "..", "packages", "shared", "src");

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: path.join(here, "index.html"),
        headless: path.join(here, "index-headless.html"),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  resolve: {
    alias: [
      { find: /^@aegis\/shared$/, replacement: path.join(sharedSrc, "index.ts") },
      { find: /^@aegis\/shared\//, replacement: sharedSrc + path.sep },
    ],
  },
});
