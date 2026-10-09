import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  build: {
    outDir: "../Cliffly/wwwroot",
    emptyOutDir: true,
    rollupOptions: {
      input: { main: "web/index.html", lab: "web/lab.html" },
      output: { manualChunks: { three: ["three"] } },
    },
  },
  worker: { format: "es" },
  optimizeDeps: { include: ["@huggingface/transformers"] },
  server: {
    proxy: {
      "/health": "http://localhost:5000",
      "/sessions": "http://localhost:5000",
      "/scans": "http://localhost:5000",
    },
  },
});
