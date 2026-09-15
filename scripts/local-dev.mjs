import { build } from 'esbuild';
import { spawn } from 'node:child_process';
await build({
  entryPoints: ['local/server.ts'],
  outfile: '.milo-build/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  target: 'node22',
  logLevel: 'warning',
});
const child = spawn(process.execPath, ['.milo-build/server.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, MILO_RUN_SERVER: '1', MILO_DEV: '1' },
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => child.kill(signal));
child.on('exit', (code) => {
  process.exitCode = code ?? 0;
});
