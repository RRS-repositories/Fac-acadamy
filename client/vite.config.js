import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In production nginx serves client/dist at / and proxies /api to the API on
// the same origin (academy.fastactionclaims.com). The dev proxy mirrors that,
// so there is no CORS setup anywhere.
// `vite preview` serves the BUILT bundle out of dist/ and is what CI drives:
// the browser suite must exercise the real build, not a dev server compiling
// on demand. It needs the same /api proxy, because the app talks to a
// same-origin /api everywhere — dev, CI and production.
const apiTarget = process.env.VITE_API_TARGET ?? 'http://localhost:4100';
const previewPort = Number(process.env.VITE_PREVIEW_PORT ?? 4173);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget,
    },
  },
  preview: {
    port: previewPort,
    // Fail loudly rather than drift to another port: the suite's base URL is
    // configured, not discovered.
    strictPort: true,
    proxy: {
      '/api': apiTarget,
    },
  },
  build: {
    outDir: 'dist',
    // The bundle is public: never ship source maps.
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    setupFiles: './test/setup.js',
    globals: false,
    // One file at a time: several jsdom suites in parallel on a slow disk
    // time out spuriously. The server config does the same.
    fileParallelism: false,
  },
});
