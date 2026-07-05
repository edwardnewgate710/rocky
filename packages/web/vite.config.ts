import { defineConfig } from 'vite';

// Static SPA build. The backend clients (REST + realtime WS) are added in the
// next increment; dev proxy config will live here alongside them.
export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
