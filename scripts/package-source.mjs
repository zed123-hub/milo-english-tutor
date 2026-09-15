import { execFileSync } from 'node:child_process';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Invalid version');
const excluded =
  /(?:^|\/)(?:\.private|\.milo-data|\.milo-build|\.openai|\.git|\.wrangler|node_modules|dist|dist-local|work|outputs|releases)(?:\/|$)|(?:^|\/)(?:AGENTS\.md|PROJECT_PLAN\.md|\.env[^/]*|[^/]*\.(?:pem|crt))(?:\/|$)/i;
const files = [
  ...new Set(
    execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { encoding: 'utf8' },
    )
      .split('\0')
      .filter(Boolean),
  ),
].filter((p) => !excluded.test(p) && lstatSync(p).isFile());
if (!files.includes('README.md') || !files.includes('local/server.ts'))
  throw Error('Incomplete source');
mkdirSync('releases', { recursive: true });
const archive = resolve('releases', `milo-local-${version}-source.zip`);
const staging = mkdtempSync(join(tmpdir(), 'milo-source-'));
try {
  const root = join(staging, `milo-local-${version}`);
  mkdirSync(root);
  for (const p of files) {
    const target = join(root, p);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(p, target);
  }
  rmSync(archive, { force: true });
  execFileSync('zip', ['-q', '-r', archive, `milo-local-${version}`], {
    cwd: staging,
  });
  const entries = execFileSync('unzip', ['-Z1', archive], {
    encoding: 'utf8',
  }).split('\n');
  if (entries.some((p) => excluded.test(p))) {
    rmSync(archive);
    throw Error('Archive exclusion check failed');
  }
  console.log(`源码包已生成：${archive}（${files.length} 个源文件）`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
