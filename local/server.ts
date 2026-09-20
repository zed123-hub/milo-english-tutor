import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
import { SqliteRepository } from './repository';
import { SettingsStore } from './settings';
import { CoachService } from './service';
import { BACKUP_LIMIT } from '../lib/coach/backup';
import { RealtimeRelay } from './realtime-relay';
import { RealtimeDiagnosticStore } from './realtime-diagnostics';
import { RealtimeDiagnostics } from '../lib/coach/realtime-diagnostics';
import {
  RealtimeRequestError,
  realtimeErrorMessage,
} from '../lib/coach/realtime-errors';
export function checkLocalRequest(req: IncomingMessage, port: number) {
  const host = req.headers.host;
  if (
    ![`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(
      host ?? '',
    )
  )
    throw Error('LOCAL_ONLY');
  if (req.headers.origin && req.headers.origin !== `http://${host}`)
    throw Error('LOCAL_ONLY');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw Error('LOCAL_ONLY');
}
async function body(req: IncomingMessage, limit = 96000) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.byteLength;
    if (size > limit) throw Error('TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function json(req: IncomingMessage, limit?: number) {
  let value: unknown;
  try {
    value = JSON.parse((await body(req, limit)).toString('utf8'));
  } catch (e) {
    if (e instanceof SyntaxError) throw Error('INVALID_BODY');
    throw e;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('INVALID_BODY');
  return value as Record<string, unknown>;
}
const errorMessages: Record<string, [number, string]> = {
  LOCAL_ONLY: [403, '仅允许从本机应用访问。'],
  INVALID_BODY: [400, '提交内容不正确。'],
  INVALID_ACTION: [409, '当前对话已改变，请重新开始。'],
  CONFLICT: [409, '学习记录已更新，请重新读取后继续。'],
  TOO_LARGE: [413, '文件或音频太大。'],
  BACKUP_TOO_LARGE: [
    413,
    '学习数据超过当前 20 MB 迁移包上限，请关闭软件后完整复制 .milo-data 文件夹备份；没有删减你的记录。',
  ],
  KEY_REQUIRED: [400, '请先配置自己的模型 Key。'],
  MODEL_AUTH: [502, '模型 Key 无效或没有使用权限，请检查设置。'],
  MODEL_LIMIT: [502, '模型服务额度不足或请求受限。'],
  MODEL_FAILED: [502, '模型服务暂时无法连接，请稍后重试。'],
  ENGLISH_ONLY: [502, '导师返回了非英文语音内容，已阻止朗读。请重新连接再试。'],
  MODEL_OUTPUT: [502, '模型没有返回有效结果，已保留实际对话，不记录虚假成果。'],
  MODEL_ENDPOINT: [400, '请使用支持的 HTTPS 模型服务地址。'],
  REALTIME_MODEL: [
    400,
    '请选择该服务支持的原生实时模型；千问需使用 Qwen3.5 Omni Realtime。',
  ],
  REALTIME_ACTIVE: [409, '已经有一通实时对话，请先暂停再连接。'],
  NO_SPEECH: [422, '没有识别到清楚的语音，我们再试一次。'],
};
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}
export async function runServer({
  port = Number(process.env.PORT ?? 3000),
  directory = resolve('.milo-data'),
  dev = false,
  databasePath,
}: {
  port?: number;
  directory?: string;
  dev?: boolean;
  databasePath?: string;
} = {}) {
  const repo = new SqliteRepository(
      databasePath ?? join(directory, 'learning.sqlite'),
    ),
    settings = new SettingsStore(directory),
    service = new CoachService(repo, settings);
  const diagnosticStore = new RealtimeDiagnosticStore(directory);
  const relay = new RealtimeRelay(service, undefined, (report) =>
    diagnosticStore.save(report),
  );
  const vite = dev
    ? await (
        await import('vite')
      ).createServer({
        configFile: resolve('vite.local.config.ts'),
        server: { middlewareMode: true },
        appType: 'spa',
      })
    : null;
  const server = createServer(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' ws://localhost:* ws://127.0.0.1:* https://api.openai.com; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
    );
    let authorizedLocalApi = false;
    try {
      const address = server.address();
      checkLocalRequest(
        req,
        typeof address === 'object' && address ? address.port : port,
      );
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const requestedPath = decodeURIComponent(url.pathname);
      if (
        /(?:^|[/])(?:\.private|\.milo-data|\.milo-build|\.git|\.openai|releases)(?:[/]|$)|(?:^|[/])(?:AGENTS\.md|PROJECT_PLAN\.md|\.env[^/]*)(?:[/]|$)/i.test(
          requestedPath,
        )
      ) {
        send(res, 404, { error: '文件不存在。' });
        return;
      }
      if (url.pathname.startsWith('/api/local/')) {
        if (req.headers['x-milo-local'] !== '1') throw Error('LOCAL_ONLY');
        authorizedLocalApi = true;
        const path = url.pathname.slice('/api/local/'.length);
        if (req.method === 'GET' && path === 'bootstrap') {
          send(res, 200, service.bootstrap());
          return;
        }
        if (req.method === 'GET' && path === 'realtime/status') {
          send(res, 200, {
            realtime: relay.status(),
            providers: diagnosticStore.status(),
          });
          return;
        }
        if (req.method === 'GET' && path === 'export') {
          const pack = await service.export();
          res.setHeader(
            'Content-Disposition',
            'attachment; filename="milo-learning-backup.json"',
          );
          send(res, 200, pack);
          return;
        }
        if (req.method !== 'POST') {
          send(res, 405, { error: '此接口只支持本机应用请求。' });
          return;
        }
        if (path === 'transcribe') {
          const bytes = await body(req, 6 * 1024 * 1024);
          send(
            res,
            200,
            await service.transcribe(
              bytes,
              String(req.headers['content-type'] ?? '').split(';')[0],
            ),
          );
          return;
        }
        const b = await json(
          req,
          path.startsWith('import') ? BACKUP_LIMIT + 1024 : 128000,
        );
        if (path === 'realtime/diagnostics') {
          if (b.provider !== 'openai') throw Error('INVALID_BODY');
          diagnosticStore.save(b);
          send(res, 200, { ok: true });
          return;
        }
        if (path === 'settings') {
          const saved = settings.save(b);
          relay.invalidate();
          service.resumeAnalysis();
          send(res, 200, { settings: saved });
          return;
        }
        if (path === 'realtime') {
          send(res, 200, await service.realtime(b.sdp, b.sessionId, b.epoch));
          return;
        }
        if (path === 'realtime/connect') {
          send(
            res,
            200,
            relay.issue(b.sessionId, b.epoch, `http://${req.headers.host}`),
          );
          return;
        }
        if (path === 'subtitles') {
          send(res, 200, await service.subtitles(b.turnId, b.epoch));
          return;
        }
        if (path === 'speech') {
          const audio = await service.speech(b.turnId, b.epoch);
          res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Cache-Control': 'no-store',
          });
          const reader = audio.body?.getReader();
          if (reader) {
            try {
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                if (res.destroyed) {
                  await reader.cancel();
                  break;
                }
                res.write(chunk.value);
              }
            } finally {
              reader.releaseLock();
            }
          }
          res.end();
          return;
        }
        if (path === 'import/inspect') {
          send(res, 200, await service.inspect(JSON.stringify(b.backup)));
          return;
        }
        if (path === 'import') {
          relay.invalidate();
          send(res, 200, {
            snapshot: await service.import(
              JSON.stringify(b.backup),
              b.revision,
              b.epoch,
            ),
            hasRecovery: true,
          });
          return;
        }
        if (path === 'restore') {
          relay.invalidate();
          send(res, 200, {
            snapshot: await service.restore(b.revision, b.epoch),
            hasRecovery: true,
          });
          return;
        }
        if (
          [
            'analysis/retry',
            'start',
            'turn',
            'hint',
            'played',
            'checkpoint',
            'nudge',
            'end',
          ].includes(path)
        ) {
          const result = await service.command(path, b);
          if (path === 'end') relay.invalidate();
          send(res, 200, result);
          return;
        }
        send(res, 404, { error: '接口不存在。' });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        send(res, 404, { error: '旧版账号接口已停用，请使用本机语音导师。' });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, { error: '不支持此请求。' });
        return;
      }
      if (vite) {
        vite.middlewares(req, res, () => {
          send(res, 404, { error: '页面不存在。' });
        });
        return;
      }
      const publicDir = resolve('dist-local/client');
      let path = resolve(publicDir, '.' + decodeURIComponent(url.pathname));
      if (path !== publicDir && !path.startsWith(publicDir + '/'))
        throw Error('LOCAL_ONLY');
      try {
        if (!(await stat(path)).isFile()) path = join(publicDir, 'index.html');
      } catch {
        path = join(publicDir, 'index.html');
      }
      const types: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.json': 'application/json',
        '.woff2': 'font/woff2',
        '.webmanifest': 'application/manifest+json',
      };
      res.writeHead(200, {
        'Content-Type': types[extname(path)] ?? 'application/octet-stream',
        'Cache-Control': path.endsWith('index.html')
          ? 'no-cache'
          : 'public, max-age=3600',
      });
      res.end(req.method === 'HEAD' ? undefined : await readFile(path));
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof RealtimeRequestError) {
        const diagnostic = new RealtimeDiagnostics('openai');
        // HTTP call creation is not a session.update event or its rejection.
        diagnostic.fault(error.fault);
        diagnostic.close('protocol_error');
        diagnosticStore.save(diagnostic.snapshot());
        send(res, 502, {
          code: error.fault.code,
          realtime: error.fault,
          error: realtimeErrorMessage(error.fault),
        });
        return;
      }
      const message = error instanceof Error ? error.message : '';
      const known = errorMessages[message];
      const importError =
        authorizedLocalApi &&
        req.url?.startsWith('/api/local/import') &&
        error instanceof Error;
      send(res, known?.[0] ?? (importError ? 400 : 500), {
        code: known ? message : undefined,
        error:
          known?.[1] ??
          (importError ? message : '暂时无法完成操作。学习记录保留在本机。'),
        ...(authorizedLocalApi ? { snapshot: service.repo.read() } : {}),
      });
    }
  });
  relay.attach(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  service.resumeAnalysis();
  console.log(
    `Milo 本机语音导师：http://localhost:${(server.address() as { port: number }).port}/\n学习数据保存在本机，无需登录。`,
  );
  async function close() {
    relay.close();
    service.close();
    await vite?.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    repo.close();
  }
  return { server, service, close };
}
if (process.env.MILO_RUN_SERVER === '1') {
  const running = await runServer({ dev: process.env.MILO_DEV === '1' });
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void running.close().then(() => process.exit(0));
    });
}
