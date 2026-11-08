import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Development only: the browser talks to ONE origin (this dev server). The web-to-backend path contract
// (docs/deployment/frontend.md, `isApiPath` in src/lib/api/client.ts): `/api/v1/...` is forwarded UNCHANGED
// (the backend serves its versioned API there); `/api/auth/...` and `/api/me/mfa...` lose `/api` (the backend's
// unversioned session and MFA routes). Nothing outside `/api` is proxied, so pages and assets stay with Vite.
// The first matching key wins, so the specific rule comes first. changeOrigin stays false on purpose: the
// backend's CSRF origin check (development fallback) compares Origin with the Host it receives, so Host must
// remain the browser's host. In production the reverse proxy applies the same contract.
const apiOrigin = process.env['DEV_API_ORIGIN'] ?? 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '^/api/(?:auth/|me/mfa(?:[/?]|$))': {
        target: apiOrigin,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/api/': { target: apiOrigin },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false, // never ship source maps of a private application
    target: 'es2023',
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
    css: false,
    restoreMocks: true,
    testTimeout: 15000,
  },
});
