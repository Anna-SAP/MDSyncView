import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, '../dist/client'),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 2500,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4820', changeOrigin: true },
      '/raw': { target: 'http://127.0.0.1:4820', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:4820', ws: true, changeOrigin: true },
    },
  },
});
