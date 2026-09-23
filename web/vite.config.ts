import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const API = process.env.LP_API_URL ?? 'http://localhost:3501';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3502,
    strictPort: true,
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '/docs': { target: API },
    },
  },
  preview: {
    port: 3503,
    strictPort: true,
    proxy: {
      '/api': { target: API, changeOrigin: false },
    },
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    testTimeout: 15_000,
  },
});
