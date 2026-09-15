import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { resolve } from 'node:path';
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': resolve('.') } },
  css: { postcss: { plugins: [tailwindcss()] } },
  build: { outDir: 'dist-local/client', emptyOutDir: true },
  server: {
    fs: {
      deny: [
        '**/.private/**',
        '**/AGENTS.md',
        '**/PROJECT_PLAN.md',
        '**/.milo-data/**',
        '**/.milo-build/**',
        '**/.git/**',
        '**/.openai/**',
        '**/releases/**',
        '**/.env*',
        '**/*.{crt,pem}',
      ],
    },
    watch: { usePolling: process.env.CODEX_SANDBOX === 'seatbelt' },
  },
});
