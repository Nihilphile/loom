import { defineConfig } from "vite";
export default defineConfig({
  root: "web",
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: { host: "127.0.0.1", proxy: { "/api": "http://127.0.0.1:4317" } },
});
