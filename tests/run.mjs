import { build } from 'esbuild';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
await mkdir('.wrangler', { recursive: true });
const dir = await mkdtemp(resolve('.wrangler/milo-tests-'));
try {
  await build({
    stdin: {
      contents:
        "import './tests/learning.test.ts'; import './tests/tutor.test.ts'; import './tests/tutor-api.test.ts'; import './tests/local-coach.test.ts'; import './tests/coach-captions.test.ts'; import './tests/coach-analysis.test.ts'; import './tests/coach-realtime.test.ts'; import './tests/coach-startup.test.ts'; import './tests/pcm-transport.test.ts'; import './tests/pcm-playback.test.ts'; import './tests/realtime-providers.test.ts'; import './tests/realtime-lifecycle.test.ts'; import './tests/realtime-tool-arguments.test.ts'; import './tests/realtime-usage.test.ts'; import './tests/realtime-context.test.ts'; import './tests/realtime-refresh.test.ts'; import './tests/realtime-rotation.test.ts'; import './tests/glm-cancel-recovery.test.ts'; import './tests/live-correction.test.ts';",
      resolveDir: process.cwd(),
    },
    outfile: join(dir, 'tests.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['miniflare', 'vite', 'react', 'react-dom', 'ws'],
    alias: { 'cloudflare:workers': resolve('tests/cloudflare-env.ts') },
    logLevel: 'silent',
  });
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', join(dir, 'tests.mjs')], {
      stdio: 'inherit',
    });
    child.on('exit', resolve);
  });
  process.exitCode = code ?? 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
