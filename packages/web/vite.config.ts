import { defineConfig } from 'vite';

// Static SPA build. The typed REST client (increment 3A) lives in `src/api` and
// is transport-injectable, so it needs no build config here. When the client is
// wired into the UI, a dev `server.proxy` for `/v1` (REST) and the realtime WS
// endpoint will live alongside this block.
export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
