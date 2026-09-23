import test from 'node:test';
import { setTimeout as realSetTimeout } from 'node:timers';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import type { RealtimeDiagnostic } from '../lib/coach/realtime-diagnostics';
type WireEvent = {
  type: string;
  session?: {
    instructions: string;
    truncation?: unknown;
    beta_fields?: { greeting_config: { enable: boolean } };
  };
};
const parseWire = (bytes: RawData): WireEvent =>
  JSON.parse(
    (Array.isArray(bytes)
      ? Buffer.concat(bytes)
      : Buffer.isBuffer(bytes)
        ? bytes
        : Buffer.from(bytes)
    ).toString('utf8'),
  );
import { RealtimeContextWindow } from '../local/realtime-context';
import { RealtimeRelay } from '../local/realtime-relay';
import { SqliteRepository } from '../local/repository';
import { SettingsStore, defaultSettings } from '../local/settings';
import { CoachService } from '../local/service';
import { freshData } from '../lib/coach/model';
import type { RealtimeEvent } from '../lib/coach/realtime-providers';

function turn(i: number, tokens = 100): RealtimeEvent[] {
  return [
    { type: 'input_audio_buffer.committed', item_id: `u${i}` },
    {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: `u${i}`,
      transcript: `My current topic is cooking meal ${i}.`,
    },
    {
      type: 'response.created',
      response: { id: `r${i}`, status: 'in_progress' },
    },
    {
      type: 'response.output_audio_transcript.done',
      response_id: `r${i}`,
      item_id: `a${i}`,
      transcript: `What did you put in meal ${i}?`,
    },
    { type: 'response.output_audio.done', response_id: `r${i}` },
    {
      type: 'response.done',
      response: {
        id: `r${i}`,
        status: 'completed',
        usage: { input_tokens: tokens },
        output: [],
      },
    },
  ];
}

void test('context: audio/token budgets wait for completed speech, transcript and audio generation', () => {
  for (const provider of ['qwen', 'glm'] as const) {
    const c = new RealtimeContextWindow(provider);
    c.audio(200);
    turn(1).forEach((e) => c.event(e));
    assert.equal(
      c.canRotate,
      false,
      'Never rotate after only one learner turn',
    );
    const next = turn(2);
    next.slice(0, 4).forEach((e) => c.event(e));
    c.event(next[5]);
    assert.equal(c.canRotate, false, 'Late output audio must finish');
    c.event(next[4]);
    assert.equal(c.canRotate, true);
    c.event({
      type: 'input_audio_buffer.speech_started',
      item_id: 'new-speech',
    });
    assert.equal(c.canRotate, false, 'Must not drop a new learner utterance');
    c.reset();
    assert.equal(c.canRotate, false);
    assert.equal(c.handoff.length, 4, 'Short text survives; counters reset');
  }
});

void test('context: independent provider turn limits and token trigger; duplicates and tool-only turns excluded', () => {
  const qwen = new RealtimeContextWindow('qwen');
  const glm = new RealtimeContextWindow('glm');
  for (let i = 1; i <= 4; i++)
    for (const c of [qwen, glm]) turn(i).forEach((e) => c.event(e));
  assert.equal(qwen.canRotate, true);
  assert.equal(glm.canRotate, false);
  turn(4, 5000).forEach((e) => glm.event(e));
  assert.equal(glm.canRotate, true);
  glm.event({
    type: 'response.done',
    response: {
      id: 'r4',
      status: 'completed',
      output: [
        {
          type: 'function_call',
          name: 'checkpoint',
          call_id: 'tool',
          arguments: '{}',
        },
      ],
    },
  });
  assert.equal(glm.canRotate, false);
  const c = new RealtimeContextWindow('qwen');
  for (let i = 0; i < 6; i++) turn(1, 9000).forEach((e) => c.event(e));
  assert.equal(
    c.canRotate,
    false,
    'Duplicate ASR does not count as multiple turns',
  );
});

for (const provider of ['qwen', 'glm'] as const)
  for (const action of ['continue', 'stop'] as const) {
    void test(`context relay ${provider} ${action}: replaces upstream only, preserves text and buffers new input until ACK`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
      t.mock.method(performance, 'now', () => Date.now());
      const advance = async (ms: number) => {
        t.mock.timers.tick(ms);
        await new Promise<void>((r) => realSetTimeout(r, 2));
      };
      const dir = mkdtempSync(join(tmpdir(), 'milo-context-test-'));
      const repo = new SqliteRepository(':memory:');
      const settings = new SettingsStore(dir);
      settings.save({
        ...defaultSettings,
        voiceMode: 'realtime',
        realtimeProvider: provider,
        realtimeModel:
          provider === 'qwen'
            ? 'qwen3.5-omni-flash-realtime'
            : 'glm-realtime-air',
        realtimeKey: 'fixture-key',
      });
      const service = new CoachService(repo, settings);
      const data = freshData();
      data.activeSessionId = 'lesson';
      data.sessions.push({
        id: 'lesson',
        startedAt: data.createdAt,
        endedAt: null,
        summary: '',
      });
      repo.commit(repo.read(), data, 'fixture');
      const remote = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await once(remote, 'listening');
      const sockets: WebSocket[] = [];
      const received: WireEvent[][] = [];
      remote.on('connection', (ws) => {
        const n = sockets.length;
        sockets.push(ws);
        received[n] = [];
        ws.on('message', (bytes) => {
          const event = parseWire(bytes);
          received[n].push(event);
          if (event.type === 'session.update' && n === 0)
            ws.send(JSON.stringify({ type: 'session.updated' }));
        });
        ws.send(JSON.stringify({ type: 'session.created' }));
      });
      const server = createServer();
      const reports: RealtimeDiagnostic[] = [];
      const relay = new RealtimeRelay(
        service,
        () =>
          new WebSocket(
            `ws://127.0.0.1:${(remote.address() as { port: number }).port}`,
          ),
        (r) => reports.push(r),
      );
      relay.attach(server);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = (server.address() as { port: number }).port;
      const origin = `http://localhost:${port}`;
      const ticket = relay.issue('lesson', repo.read().epoch, origin);
      const browser = new WebSocket(
        `ws://localhost:${port}/api/local/realtime/socket`,
        ['milo-realtime', ticket.ticket],
        { origin },
      );
      const messages: WireEvent[] = [];
      browser.on('message', (bytes) => messages.push(parseWire(bytes)));
      t.after(async () => {
        browser.terminate();
        relay.close();
        service.close();
        for (const ws of remote.clients) ws.terminate();
        await new Promise<void>((r) => remote.close(() => r()));
        await new Promise<void>((r) => server.close(() => r()));
        repo.close();
        rmSync(dir, { recursive: true, force: true });
      });
      const until = async (condition: () => boolean) => {
        const started = Date.now();
        while (!condition()) {
          if (Date.now() - started > 4000)
            throw Error('context fixture timeout');
          await advance(25);
        }
      };
      await until(() => messages.some((e) => e.type === 'milo.ready'));
      for (const i of [1, 2])
        for (const e of turn(i, 5000)) sockets[0].send(JSON.stringify(e));
      await until(
        () =>
          sockets.length === 2 &&
          received[1].some((e) => e.type === 'session.update'),
      );
      assert.equal(browser.readyState, WebSocket.OPEN);
      const config = received[1].find(
        (e) => e.type === 'session.update',
      )!.session!;
      assert.match(config.instructions, /meal 2/);
      assert.match(config.instructions, /Wait for new learner input/);
      assert.equal(
        config.truncation,
        undefined,
        'Do not send OpenAI fields to WebSocket providers',
      );
      if (provider === 'glm')
        assert.equal(config.beta_fields!.greeting_config.enable, false);
      await advance(12000);
      assert.equal(
        browser.readyState,
        WebSocket.OPEN,
        'A continuing session gets the same handshake allowance as initial startup',
      );
      // A full recovered microphone queue arriving during the handshake stays in bounded RAM.
      const frame = Buffer.alloc(3200);
      for (let i = 0; i < frame.length; i += 2) frame.writeInt16LE(1200, i);
      for (let i = 0; i < 120; i++)
        browser.send(
          JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: frame.toString('base64'),
          }),
        );
      await advance(40);
      assert.equal(
        received[1].filter((e) => e.type === 'input_audio_buffer.append')
          .length,
        0,
      );
      if (action === 'stop') {
        browser.send(JSON.stringify({ type: 'milo.input.finish' }));
        await advance(30);
      }
      sockets[1].send(JSON.stringify({ type: 'session.updated' }));
      if (action === 'continue')
        await until(
          () =>
            received[1].filter((e) => e.type === 'input_audio_buffer.append')
              .length === 120,
        );
      else {
        await advance(150);
        assert.equal(
          received[1].filter((e) => e.type === 'input_audio_buffer.append')
            .length,
          0,
          'Stop discards held audio before a late ACK',
        );
      }
      assert.equal(
        received[1].filter((e) => e.type === 'response.create').length,
        0,
        'No repeated greeting',
      );
      assert.equal(
        messages.filter((e) => e.type === 'milo.ready').length,
        1,
        'Do not recreate microphone/player',
      );
      assert.equal(messages.filter((e) => e.type === 'error').length, 0);
      assert.equal(reports.at(-1)!.counts.contextRotations, 1);
      assert.equal(repo.read().data.activeSessionId, 'lesson');
      assert.equal(
        repo.read().data.sessions.length,
        1,
        'No new learning session or analysis call',
      );
      assert.doesNotMatch(JSON.stringify(reports), /meal|fixture-key|What did/);
    });
  }

void test('context: late teacher transcript blocks rotation and is retained in handoff', () => {
  const c = new RealtimeContextWindow('glm');
  turn(1).forEach((e) => c.event(e));
  const second = turn(2, 9000);
  second
    .filter((e) => e.type !== 'response.output_audio_transcript.done')
    .forEach((e) => c.event(e));
  assert.equal(c.canRotate, false);
  c.event(second[3]);
  assert.equal(c.canRotate, true);
  assert.match(c.handoff.at(-1)!.text, /meal 2/);
});
