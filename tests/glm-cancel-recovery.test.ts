import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { freshData } from '../lib/coach/model';
import { SettingsStore, defaultSettings } from '../local/settings';
import { SqliteRepository } from '../local/repository';
import { CoachService } from '../local/service';
import { RealtimeRelay } from '../local/realtime-relay';
import type { RealtimeDiagnostic } from '../lib/coach/realtime-diagnostics';

type Event = Record<string, unknown>;

function parse(raw: WebSocket.RawData): Event {
  return JSON.parse(
    (Array.isArray(raw)
      ? Buffer.concat(raw)
      : Buffer.isBuffer(raw)
        ? raw
        : Buffer.from(raw)
    ).toString('utf8'),
  ) as Event;
}

async function until(label: string, predicate: () => boolean) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 2000)
      throw Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'milo-glm-cancel-'));
  const repo = new SqliteRepository(join(dir, 'test.sqlite'));
  const settings = new SettingsStore(dir);
  settings.save({
    ...defaultSettings,
    voiceMode: 'realtime',
    realtimeProvider: 'glm',
    realtimeModel: 'glm-realtime-air',
    realtimeKey: 'fixture-only-key',
  });
  const service = new CoachService(repo, settings);
  const state = repo.read();
  const data = freshData();
  data.activeSessionId = 'session';
  data.sessions = [
    {
      id: 'session',
      startedAt: new Date().toISOString(),
      endedAt: null,
      summary: '',
    },
  ];
  repo.commit(state, data, 'fixture-start');

  const remote = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(remote, 'listening');
  const remotePort = (remote.address() as { port: number }).port;
  const received: Event[] = [];
  let upstream: WebSocket | undefined;
  let commits = 0;
  remote.on('connection', (socket) => {
    upstream = socket;
    socket.send(JSON.stringify({ type: 'session.created' }));
    socket.on('message', (raw) => {
      const event = parse(raw);
      received.push(event);
      if (event.type === 'session.update')
        socket.send(JSON.stringify({ type: 'session.updated' }));
      if (event.type === 'input_audio_buffer.commit') {
        commits++;
        socket.send(
          JSON.stringify({
            type: 'input_audio_buffer.committed',
            item_id: `u${commits}`,
          }),
        );
      }
    });
  });

  const server = createServer();
  const reports: RealtimeDiagnostic[] = [];
  const relay = new RealtimeRelay(
    service,
    (_url, key) =>
      new WebSocket(`ws://127.0.0.1:${remotePort}`, {
        headers: { Authorization: `Bearer ${key}` },
      }),
    (report) => reports.push(report),
  );
  relay.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const origin = `http://localhost:${port}`;
  const ticket = relay.issue('session', repo.read().epoch, origin);
  const browser = new WebSocket(
    `ws://localhost:${port}/api/local/realtime/socket`,
    ['milo-realtime', ticket.ticket],
    { origin },
  );
  const messages: Event[] = [];
  browser.on('message', (raw) => messages.push(parse(raw)));
  t.after(async () => {
    relay.close();
    browser.terminate();
    for (const socket of remote.clients) socket.terminate();
    await new Promise<void>((resolve) => remote.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    service.close();
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await until('GLM session ready', () =>
    messages.some((event) => event.type === 'milo.ready'),
  );
  assert.ok(upstream);
  return {
    browser,
    messages,
    received,
    reports,
    upstream: upstream!,
    inputRate: ticket.inputRate,
  };
}

function frame(rate: number, speaking: boolean) {
  const pcm = Buffer.alloc((rate / 10) * 2);
  if (speaking)
    for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
  return JSON.stringify({
    type: 'input_audio_buffer.append',
    audio: pcm.toString('base64'),
  });
}

void test('GLM: speaking before the first assistant audio does not cancel a newly created response', async (t) => {
  const f = await fixture(t);
  f.upstream.send(
    JSON.stringify({
      type: 'response.created',
      response: { id: 'r1', status: 'in_progress' },
    }),
  );
  await until('first response created', () =>
    f.messages.some((event) => event.type === 'response.created'),
  );
  f.browser.send(frame(f.inputRate, true));
  f.browser.send(frame(f.inputRate, true));
  await until('local speech start', () =>
    f.messages.some(
      (event) => event.type === 'input_audio_buffer.speech_started',
    ),
  );
  await until(
    'preroll delivered upstream',
    () =>
      f.received.filter((event) => event.type === 'input_audio_buffer.append')
        .length >= 2,
  );
  assert.equal(
    f.received.filter((event) => event.type === 'response.cancel').length,
    0,
    'GLM should not receive a pre-audio cancellation during a fresh response',
  );
  f.upstream.send(
    JSON.stringify({
      type: 'response.audio.delta',
      response_id: 'r1',
      delta: 'AQI=',
    }),
  );
  await until('late assistant audio cancelled', () =>
    f.received.some((event) => event.type === 'response.cancel'),
  );
  assert.equal(
    f.received.filter((event) => event.type === 'response.cancel').length,
    1,
  );
  assert.equal(f.browser.readyState, WebSocket.OPEN);
});

void test('GLM: audio arriving before response.created can still be cancelled once', async (t) => {
  const f = await fixture(t);
  f.browser.send(JSON.stringify({ type: 'response.create' }));
  await until('response requested', () =>
    f.received.some((event) => event.type === 'response.create'),
  );
  f.upstream.send(
    JSON.stringify({
      type: 'response.audio.delta',
      response_id: 'r1',
      delta: 'AQI=',
    }),
  );
  await until('early assistant audio', () =>
    f.messages.some((event) => event.type === 'response.output_audio.delta'),
  );
  f.browser.send(frame(f.inputRate, true));
  f.browser.send(frame(f.inputRate, true));
  await until('local speech start after early audio', () =>
    f.messages.some(
      (event) => event.type === 'input_audio_buffer.speech_started',
    ),
  );
  await until('early audio interrupted', () =>
    f.received.some((event) => event.type === 'response.cancel'),
  );
  f.upstream.send(
    JSON.stringify({
      type: 'response.created',
      response: { id: 'r1', status: 'in_progress' },
    }),
  );
  await until('late response created', () =>
    f.messages.some((event) => event.type === 'response.created'),
  );
  assert.equal(
    f.received.filter((event) => event.type === 'response.cancel').length,
    1,
  );
  assert.equal(f.browser.readyState, WebSocket.OPEN);
});

void test('GLM: cancellation error during audible response does not end the call before a later turn', async (t) => {
  const f = await fixture(t);
  f.upstream.send(
    JSON.stringify({
      type: 'response.created',
      response: { id: 'r1', status: 'in_progress' },
    }),
  );
  f.upstream.send(
    JSON.stringify({
      type: 'response.audio.delta',
      response_id: 'r1',
      delta: 'AQI=',
    }),
  );
  await until('assistant first audio', () =>
    f.messages.some((event) => event.type === 'response.output_audio.delta'),
  );
  f.browser.send(frame(f.inputRate, true));
  f.browser.send(frame(f.inputRate, true));
  await until('audible response cancelled', () =>
    f.received.some((event) => event.type === 'response.cancel'),
  );
  f.upstream.send(
    JSON.stringify({ type: 'error', error: { code: 'model_query_error' } }),
  );
  f.upstream.send(
    JSON.stringify({
      type: 'response.done',
      response: { id: 'r1', status: 'cancelled' },
    }),
  );
  await until('cancelled response done', () =>
    f.messages.some((event) => event.type === 'response.done'),
  );
  assert.equal(f.browser.readyState, WebSocket.OPEN);
  assert.equal(
    f.messages.some((event) => event.type === 'error'),
    false,
    'A recoverable cancellation error must not be surfaced as a fatal call error',
  );
  assert.equal(f.reports.at(-1)?.counts.cancelErrorsRecovered, 1);
  assert.equal(
    f.reports
      .at(-1)
      ?.milestones.some((item) => item.event === 'cancel_error_recovered'),
    true,
  );
  for (let i = 0; i < 13; i++) f.browser.send(frame(f.inputRate, false));
  await until('next input committed', () =>
    f.received.some((event) => event.type === 'input_audio_buffer.commit'),
  );
  await until('next response requested', () =>
    f.received.some((event) => event.type === 'response.create'),
  );
  assert.equal(f.browser.readyState, WebSocket.OPEN);
});

void test('GLM: a cancellation error arriving after response.done does not close the call', async (t) => {
  const f = await fixture(t);
  f.upstream.send(
    JSON.stringify({
      type: 'response.created',
      response: { id: 'r1', status: 'in_progress' },
    }),
  );
  f.upstream.send(
    JSON.stringify({
      type: 'response.audio.delta',
      response_id: 'r1',
      delta: 'AQI=',
    }),
  );
  await until('assistant first audio', () =>
    f.messages.some((event) => event.type === 'response.output_audio.delta'),
  );
  f.browser.send(frame(f.inputRate, true));
  f.browser.send(frame(f.inputRate, true));
  await until('audible response cancelled', () =>
    f.received.some((event) => event.type === 'response.cancel'),
  );
  f.upstream.send(
    JSON.stringify({
      type: 'response.done',
      response: { id: 'r1', status: 'cancelled' },
    }),
  );
  await until('cancelled response done', () =>
    f.messages.some((event) => event.type === 'response.done'),
  );
  f.upstream.send(
    JSON.stringify({ type: 'error', error: { code: 'model_query_error' } }),
  );
  await until(
    'late cancel error classified',
    () =>
      f.reports.at(-1)?.counts.cancelErrorsRecovered === 1 ||
      f.messages.some((event) => event.type === 'error'),
  );
  assert.equal(f.browser.readyState, WebSocket.OPEN);
  assert.equal(
    f.messages.some((event) => event.type === 'error'),
    false,
  );
  assert.equal(f.reports.at(-1)?.counts.cancelErrorsRecovered, 1);
});

void test('GLM: unrelated model query errors still stop the failed call', async (t) => {
  const f = await fixture(t);
  const closed = once(f.browser, 'close');
  f.upstream.send(
    JSON.stringify({ type: 'error', error: { code: 'model_query_error' } }),
  );
  await closed;
  const failure = f.messages.find((event) => event.type === 'error') as {
    error?: { code?: string; providerCode?: string };
  };
  assert.equal(failure.error?.code, 'MODEL_FAILED');
  assert.equal(failure.error?.providerCode, 'model_query_error');
  assert.equal(f.reports.at(-1)?.counts.cancelErrorsRecovered, 0);
});

void test('GLM: a tools configuration error during cancellation remains fatal', async (t) => {
  const f = await fixture(t);
  f.upstream.send(
    JSON.stringify({
      type: 'response.created',
      response: { id: 'r1', status: 'in_progress' },
    }),
  );
  f.upstream.send(
    JSON.stringify({
      type: 'response.audio.delta',
      response_id: 'r1',
      delta: 'AQI=',
    }),
  );
  await until('assistant first audio', () =>
    f.messages.some((event) => event.type === 'response.output_audio.delta'),
  );
  f.browser.send(frame(f.inputRate, true));
  f.browser.send(frame(f.inputRate, true));
  await until('response cancelled', () =>
    f.received.some((event) => event.type === 'response.cancel'),
  );
  const closed = once(f.browser, 'close');
  f.upstream.send(
    JSON.stringify({
      type: 'error',
      error: {
        code: 'model_query_error',
        param: 'tools',
        message: 'invalid tools',
      },
    }),
  );
  await closed;
  const failure = f.messages.find((event) => event.type === 'error') as {
    error?: { code?: string; parameter?: string };
  };
  assert.equal(failure.error?.code, 'REALTIME_CONFIG');
  assert.equal(failure.error?.parameter, 'tools');
  assert.equal(f.reports.at(-1)?.counts.cancelErrorsRecovered, 0);
});
