import { build as bundle } from 'esbuild';
import { build } from 'vite';
await build({ configFile: 'vite.local.config.ts' });
await bundle({
  entryPoints: ['local/server.ts'],
  outfile: 'dist-local/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  target: 'node22',
  logLevel: 'warning',
});
