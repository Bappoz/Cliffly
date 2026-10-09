import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  build: {
    outDir: "../Cliffly/wwwroot",
    emptyOutDir: true,
    rollupOptions: { output: { manualChunks: { three: ["three"] } } },
  },
  worker: { format: "es" },
  optimizeDeps: { include: ["@huggingface/transformers"] },
  server: {
    proxy: {
      "/health": "http://localhost:5000",
      "/sessions": "http://localhost:5000",
    },
  },
});
