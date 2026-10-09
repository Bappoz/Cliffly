import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  build: { outDir: '../Cliffly/wwwroot', emptyOutDir: true },
  worker: { format: 'es' },
  server: { proxy: { '/health': 'http://localhost:5000', '/sessions': 'http://localhost:5000' } },
});
