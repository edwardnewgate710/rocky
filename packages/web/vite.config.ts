import { defineConfig } from 'vite';

// Static SPA build. When running e2e tests with GAMBIT_E2E_BACKEND=1, the
// vite preview server proxies /v1 (REST) and /ws (WebSocket) to the e2e
// harness backend. This lets the frontend talk to real backends without
// CORS configuration.
export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  preview: {
    proxy: {
      // Proxy REST API requests to the e2e harness
      '/v1': {
        target: process.env['E2E_API_URL'] ?? 'http://127.0.0.1:4174',
        changeOrigin: true,
      },
      // Proxy WebSocket connections to the e2e harness gateway
      '/ws': {
        target: process.env['E2E_WS_URL'] ?? 'ws://127.0.0.1:4175',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
