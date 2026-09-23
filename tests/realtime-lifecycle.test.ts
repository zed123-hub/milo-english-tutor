import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAILifecycle } from '../lib/coach/openai-lifecycle';
import { QwenLifecycle } from '../lib/coach/qwen-lifecycle';
import { GLMLifecycle } from '../lib/coach/glm-lifecycle';
import {
  realtimeConfig,
  websocketSession,
  RealtimeEvents,
  type RealtimeEvent,
} from '../lib/coach/realtime-providers';
import { realtimeSession } from '../lib/coach/teacher';
import { freshData } from '../lib/coach/model';
import { RealtimeOutput } from '../local/realtime-output';
import {
  realtimeFault,
  realtimeFieldPath,
  RealtimeRequestError,
  safeRealtimeFault,
} from '../lib/coach/realtime-errors';
import { SettingsStore, defaultSettings } from '../local/settings';
import { SqliteRepository } from '../local/repository';
import { CoachService } from '../local/service';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RealtimeDiagnostics,
  safeRealtimeDiagnostic,
} from '../lib/coach/realtime-diagnostics';
import { RealtimeDiagnosticStore } from '../local/realtime-diagnostics';
import { readFileSync, statSync } from 'node:fs';

const created = (id: string): RealtimeEvent => ({
  type: 'response.created',
  response: { id, status: 'in_progress' },
});
const done = (id: string): RealtimeEvent => ({
  type: 'response.done',
  response: { id, status: 'completed' },
});
function fixture(provider: 'openai' | 'qwen' | 'glm') {
  const sent: Record<string, unknown>[] = [];
  const send = (event: unknown) => sent.push(event as Record<string, unknown>);
  const config = realtimeConfig({
    realtimeProvider: provider,
    realtimeModel:
      provider === 'glm'
        ? 'glm-realtime-air'
        : provider === 'qwen'
          ? 'qwen3.5-omni-flash-realtime'
          : 'gpt-realtime-2.1-mini',
  });
  const life =
    provider === 'openai'
      ? new OpenAILifecycle(send)
      : provider === 'qwen'
        ? new QwenLifecycle(config, 'initial', [], send)
        : new GLMLifecycle(config, 'initial', [], send);
  const request = () =>
    life instanceof OpenAILifecycle
      ? life.command({ type: 'response.create' })
      : life.requestResponse('tool');
  const interrupt = () =>
    life instanceof OpenAILifecycle
      ? life.command({ type: 'response.cancel' })
      : life.interrupt();
  if (life instanceof QwenLifecycle) life.start();
  life.accept({ type: 'session.created' });
  life.accept({ type: 'session.updated' });
  if (provider === 'glm') request();
  return {
    life,
    sent,
    request,
    interrupt,
    count: (type: string) => sent.filter((e) => e.type === type).length,
  };
}

for (const provider of ['openai', 'qwen', 'glm'] as const) {
  void test(`${provider} lifecycle: cancelled request waits for created and cancels exactly once`, () => {
    const { life, interrupt, count } = fixture(provider);
    interrupt();
    interrupt();
    assert.equal(
      count('response.cancel'),
      0,
      'There is no active response to cancel yet',
    );
    life.accept(created('a'));
    life.accept(created('a'));
    interrupt();
    if (provider === 'glm') {
      assert.equal(
        count('response.cancel'),
        0,
        'GLM waits for actual assistant audio before cancelling',
      );
      life.accept({
        type: 'response.output_audio.delta',
        response_id: 'a',
        delta: 'AQI=',
      });
    }
    assert.equal(count('response.cancel'), 1);
    assert.equal(life.state, 'cancel_pending');
    life.accept({
      type: 'error',
      error: { code: 'response_cancel_not_active' },
    });
    assert.equal(life.state, 'idle');
  });
  void test(`${provider} lifecycle: duplicate terminal cannot release the next requested response`, () => {
    const { life, request, count } = fixture(provider);
    life.accept(created('a'));
    life.accept(done('a'));
    request();
    life.accept(done('a'));
    life.accept(created('a'));
    request();
    assert.equal(count('response.create'), 2);
    assert.equal(life.state, 'requested');
    life.accept(created('b'));
    life.accept(done('a'));
    request();
    assert.equal(count('response.create'), 2);
    life.close();
    life.accept(done('b'));
    request();
    assert.equal(count('response.create'), 2);
    assert.equal(
      count('response.cancel'),
      0,
      'Transport cleanup must never send',
    );
  });
}

void test('OpenAI lifecycle: session readiness and mutable-only serialized policy patches', () => {
  const sent: Record<string, unknown>[] = [];
  const life = new OpenAILifecycle((e) => sent.push(e));
  life.command({ type: 'response.create' });
  life.policy('A');
  assert.equal(sent.length, 0);
  life.accept({ type: 'session.created' });
  life.accept({ type: 'session.created' });
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 1);
  life.accept({ type: 'session.updated' });
  const untrusted = {
    type: 'session.update',
    session: { instructions: 'B', model: 'forbidden', audio: {} },
  };
  life.command(untrusted);
  life.policy('A');
  assert.equal(sent.filter((e) => e.type === 'session.update').length, 2);
  life.accept({ type: 'session.updated' });
  const updates = sent.filter((e) => e.type === 'session.update');
  assert.deepEqual(
    updates.map((e) => e.session),
    ['A', 'B', 'A'].map((instructions) => ({ type: 'realtime', instructions })),
  );
  life.command({ type: 'input_audio_buffer.commit' });
  life.accept({ type: 'input_audio_buffer.speech_started' });
  life.accept({ type: 'input_audio_buffer.speech_stopped' });
  assert.equal(
    sent.filter((e) => e.type === 'input_audio_buffer.commit').length,
    0,
  );
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 1);
});

void test('OpenAI lifecycle: rejected policy retains exact safe path without terminating the session', () => {
  const { life, sent } = fixture('openai');
  assert.ok(life instanceof OpenAILifecycle);
  life.policy('change');
  const id = sent.at(-1)!.event_id as string;
  const fault = realtimeFault({
    code: 'invalid_value',
    param: 'session.audio.output.voice',
    message: 'private content',
  });
  assert.equal(life.accept({ type: 'error', error: fault }, id), null);
  assert.equal(life.lastRejected?.fieldPath, 'session.audio.output.voice');
  assert.deepEqual(life.errorContext(id), {
    type: 'session.update',
    fields: ['session.type', 'session.instructions'],
  });
  life.policy('change');
  assert.equal(life.updates.sent, 1);
  life.policy('new');
  assert.equal(life.updates.sent, 2);
});

void test('OpenAI lifecycle: interrupted request cancels before clearing audio when response creation is delayed', () => {
  const { life, sent, interrupt, count } = fixture('openai');
  assert.ok(life instanceof OpenAILifecycle);
  interrupt();
  life.command({ type: 'output_audio_buffer.clear' });
  interrupt();
  life.command({ type: 'output_audio_buffer.clear' });
  assert.equal(count('output_audio_buffer.clear'), 0);
  life.accept(created('delayed'));
  assert.deepEqual(
    sent.slice(-2).map((e) => e.type),
    ['response.cancel', 'output_audio_buffer.clear'],
  );
  life.accept(created('delayed'));
  assert.equal(count('response.cancel'), 1);
  assert.equal(count('output_audio_buffer.clear'), 1);
});

void test('OpenAI lifecycle: cancellation clears active audio and completed playback, but close discards deferred clear', () => {
  const active = fixture('openai');
  assert.ok(active.life instanceof OpenAILifecycle);
  active.life.accept(created('active'));
  active.interrupt();
  active.life.command({ type: 'output_audio_buffer.clear' });
  assert.deepEqual(
    active.sent.slice(-2).map((e) => e.type),
    ['response.cancel', 'output_audio_buffer.clear'],
  );
  // Generation can finish before the WebRTC playback buffer finishes playing.
  const playing = fixture('openai');
  assert.ok(playing.life instanceof OpenAILifecycle);
  playing.life.accept(created('playing'));
  playing.life.accept(done('playing'));
  playing.interrupt();
  playing.life.command({ type: 'output_audio_buffer.clear' });
  assert.equal(playing.count('response.cancel'), 0);
  assert.equal(playing.count('output_audio_buffer.clear'), 1);

  const closed = fixture('openai');
  assert.ok(closed.life instanceof OpenAILifecycle);
  closed.interrupt();
  closed.life.command({ type: 'output_audio_buffer.clear' });
  closed.life.close();
  closed.life.accept(created('late'));
  assert.equal(closed.count('response.cancel'), 0);
  assert.equal(closed.count('output_audio_buffer.clear'), 0);
});

void test('OpenAI lifecycle: a terminal before creation discards the deferred clear without touching the next reply', () => {
  const { life, interrupt, request, count } = fixture('openai');
  assert.ok(life instanceof OpenAILifecycle);
  interrupt();
  life.command({ type: 'output_audio_buffer.clear' });
  life.accept(done('terminal-before-created'));
  assert.equal(count('response.cancel'), 0);
  assert.equal(count('output_audio_buffer.clear'), 0);
  request();
  life.accept(created('next'));
  assert.equal(life.state, 'responding');
  assert.equal(count('response.cancel'), 0);
  assert.equal(count('output_audio_buffer.clear'), 0);
});

void test('Qwen lifecycle: server VAD never creates ordinary turns; policy waits for response then ACK', () => {
  const { life, sent, request, count } = fixture('qwen');
  life.accept(created('a'));
  life.policy('new');
  request();
  assert.equal(count('session.update'), 1);
  assert.equal(count('response.create'), 1);
  life.accept(done('a'));
  assert.deepEqual(sent.at(-1)!.session, { instructions: 'new' });
  assert.equal(life.state, 'updating');
  life.accept({ type: 'session.updated' });
  life.accept({ type: 'input_audio_buffer.speech_stopped' });
  life.accept({ type: 'input_audio_buffer.committed' });
  assert.equal(count('response.create'), 1);
  assert.equal(count('input_audio_buffer.commit'), 0);
});

void test('Qwen lifecycle: user speech supersedes a nudge queued behind a policy ACK', () => {
  const { life, count } = fixture('qwen');
  assert.ok(life instanceof QwenLifecycle);
  life.accept(created('opening'));
  life.accept(done('opening'));
  life.policy('updated');
  life.requestResponse('nudge');
  life.accept({ type: 'input_audio_buffer.speech_started' });
  life.accept({ type: 'input_audio_buffer.committed' });
  life.accept(created('automatic'));
  life.accept({ type: 'session.updated' });
  life.accept(done('automatic'));
  assert.equal(count('response.create'), 1);
  assert.equal(life.state, 'idle');
});

void test('GLM lifecycle: committed input after interrupt waits through complete config ACK exactly once', () => {
  const { life, sent, interrupt, count } = fixture('glm');
  assert.ok(life instanceof GLMLifecycle);
  life.accept(created('a'));
  interrupt();
  life.policy('next');
  life.requestResponse('input');
  life.accept(done('a'));
  assert.equal(count('response.create'), 1);
  const config = sent.at(-1)!.session as {
    model: string;
    input_audio_format: string;
    beta_fields: { greeting_config: { enable: boolean } };
  };
  assert.equal(config.model, 'glm-realtime-air');
  assert.equal(config.input_audio_format, 'pcm24');
  assert.equal(config.beta_fields.greeting_config.enable, false);
  life.accept({ type: 'session.updated' });
  life.accept(done('a'));
  life.requestResponse('tool');
  assert.equal(count('response.create'), 2);
  life.accept(created('b'));
  interrupt();
  life.requestResponse('input');
  life.finish();
  life.accept(done('b'));
  life.accept({ type: 'session.updated' });
  assert.equal(count('response.create'), 2, 'Pause clears input continuation');
});

void test('GLM lifecycle: initial model-generated opening starts once after accepted config, never on refresh', () => {
  const sent: Record<string, unknown>[] = [];
  const config = realtimeConfig({
    realtimeProvider: 'glm',
    realtimeModel: 'glm-realtime-air',
  });
  const first = new GLMLifecycle(config, 'memory-led opening', [], (event) =>
    sent.push(event as Record<string, unknown>),
  );
  first.accept({ type: 'session.created' });
  assert.equal(
    sent.filter((event) => event.type === 'response.create').length,
    0,
  );
  first.accept({ type: 'session.updated' });
  first.accept({ type: 'session.updated' });
  assert.equal(
    sent.filter((event) => event.type === 'response.create').length,
    1,
  );
  assert.equal(
    (
      sent[0].session as {
        beta_fields: { greeting_config: { enable: boolean } };
      }
    ).beta_fields.greeting_config.enable,
    false,
  );
  first.close();
  const refresh: Record<string, unknown>[] = [];
  const continuing = new GLMLifecycle(
    config,
    'continuing conversation',
    [],
    (event) => refresh.push(event as Record<string, unknown>),
    false,
  );
  continuing.accept({ type: 'session.created' });
  continuing.accept({ type: 'session.updated' });
  assert.equal(
    refresh.filter((event) => event.type === 'response.create').length,
    0,
  );
});

void test('GLM queue: recovered audio remains paced below 50 events per second', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  const sent: number[] = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 90000,
    send(_text: string, callback: () => void) {
      sent.push(now);
      callback();
    },
  };
  const output = new RealtimeOutput(
    socket,
    (code) => assert.fail(code),
    () => {},
    () => now,
    25,
  );
  t.after(() => output.close());
  for (let i = 0; i < 60; i++)
    output.send({ type: 'input_audio_buffer.append', audio: 'AAA=' });
  socket.bufferedAmount = 0;
  for (let i = 0; i < 60; i++) {
    now += 25;
    t.mock.timers.tick(25);
  }
  assert.equal(sent.length, 60);
  assert.ok(sent.every((value, i) => !i || value - sent[i - 1] >= 25));
});

void test('GLM schema: hint integer enum has required description; error paths exclude secret text', () => {
  const config = realtimeConfig({
    realtimeProvider: 'glm',
    realtimeModel: 'glm-realtime-air',
  });
  const payload = websocketSession(
    config,
    'x',
    realtimeSession(freshData(), config.model).tools,
  );
  const hint = payload.session.tools!.find(
    (t) => 'name' in t && t.name === 'record_hint',
  ) as {
    parameters: {
      properties: {
        level: { type: string; enum: number[]; description: string };
      };
    };
  };
  assert.deepEqual(hint.parameters.properties.level.enum, [1, 2, 3]);
  assert.equal(hint.parameters.properties.level.type, 'integer');
  assert.ok(hint.parameters.properties.level.description.length);
  assert.equal(
    realtimeFieldPath(
      'session.tools[0].parameters.properties.level.description',
    ),
    'session.tools.0.parameters.properties.level.description',
  );
  assert.equal(realtimeFieldPath('session.secret-key'), undefined);
  assert.equal(realtimeFieldPath('session.tools[99].name'), undefined);
});

void test('OpenAI HTTP error: preserve invalid_value param while dropping raw credentials and conversation', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'milo-rt-http-'));
  const repo = new SqliteRepository(':memory:');
  const settings = new SettingsStore(dir);
  const service = new CoachService(repo, settings);
  t.after(() => {
    service.close();
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  });
  settings.save({ ...defaultSettings, voiceKey: 'fixture-key' });
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'invalid_value',
            param: 'session.audio.output.speed',
            message: 'fixture-key private conversation',
            value: 'private',
          },
        }),
        { status: 400 },
      ),
  );
  await assert.rejects(
    service.upstream('/realtime/calls', 'fake sdp'),
    (error) => {
      assert.ok(error instanceof RealtimeRequestError);
      assert.equal(error.fault.fieldPath, 'session.audio.output.speed');
      assert.equal(error.fault.providerCode, 'invalid_value');
      assert.doesNotMatch(JSON.stringify(error), /fixture-key|private/);
      return true;
    },
  );
});

void test('diagnostics: only protocol metadata persists; audio, text, key, event ids and stable assertions are discarded', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'milo-rt-diagnostic-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const diagnostic = new RealtimeDiagnostics('qwen');
  diagnostic.sent('session.update');
  diagnostic.event({ type: 'session.updated' });
  diagnostic.sent('input_audio_buffer.append', 3200);
  diagnostic.event({
    type: 'input_audio_buffer.speech_started',
    item_id: 'private-item-id',
  });
  diagnostic.event({ type: 'input_audio_buffer.speech_stopped' });
  diagnostic.event({ type: 'input_audio_buffer.committed' });
  diagnostic.event({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'private-chat',
    item_id: 'private-item-id',
  });
  diagnostic.event(created('private-response-id'));
  diagnostic.event({
    type: 'response.output_audio.delta',
    response_id: 'private-response-id',
    delta: 'private-audio',
  });
  diagnostic.event({
    type: 'response.output_audio.delta',
    response_id: 'private-response-id',
    delta: 'private-audio',
  });
  diagnostic.event(done('private-response-id'));
  diagnostic.event(done('private-response-id'));
  diagnostic.fault(
    realtimeFault({
      code: 'invalid_value',
      param: 'session.audio.output.voice',
      message: 'private-key',
    }),
    true,
    ['session.instructions', 'private-key'],
  );
  diagnostic.close('protocol_error');
  const snapshot = diagnostic.snapshot();
  assert.equal(snapshot.counts.firstAudio, 1);
  assert.equal(snapshot.counts.responsesDone, 1);
  assert.equal(snapshot.counts.audioFramesSent, 1);
  assert.equal(snapshot.counts.userTranscriptsCompleted, 1);
  const store = new RealtimeDiagnosticStore(dir);
  store.save({
    ...snapshot,
    key: 'private-key',
    audio: 'private-audio',
    transcript: 'private-chat',
    stable: true,
    rejectedFields: ['session.instructions', 'private-key'],
    counts: { ...snapshot.counts, key: 'private-key' },
  });
  const path = join(dir, 'realtime-diagnostics/qwen.json');
  const saved = readFileSync(path, 'utf8');
  assert.doesNotMatch(saved, /private-/);
  assert.equal(JSON.parse(saved).stable, false);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(
    () => safeRealtimeDiagnostic({ provider: '../private-key' }),
    /INVALID_BODY/,
  );
  const next = new RealtimeDiagnostics('qwen').snapshot();
  next.startedAt = snapshot.startedAt + 1000;
  assert.ok(
    next.startedAt > 1e12,
    'Epoch milliseconds must not be truncated into a counter range',
  );
  store.save(next);
  assert.equal(
    JSON.parse(readFileSync(path, 'utf8')).startedAt,
    next.startedAt,
  );
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).state, 'connecting');
  store.save(snapshot);
  assert.equal(
    JSON.parse(readFileSync(path, 'utf8')).startedAt,
    next.startedAt,
  );
});

void test('OpenAI diagnostics: RTP packet counters never masquerade as PCM append frames', () => {
  const diagnostic = new RealtimeDiagnostics('openai');
  diagnostic.event({ type: 'session.created' });
  assert.equal(diagnostic.snapshot().counts.sessionUpdatesAccepted, 0);
  assert.deepEqual(
    diagnostic.snapshot().milestones.map((m) => m.event),
    ['connected'],
  );
  diagnostic.sent('session.update');
  diagnostic.event({ type: 'session.created' });
  assert.equal(
    diagnostic.snapshot().counts.sessionUpdatesAccepted,
    0,
    'Session creation must not acknowledge an in-flight policy update',
  );
  diagnostic.event({ type: 'session.updated' });
  diagnostic.rtp(20, 1000);
  diagnostic.rtp(19, 999);
  const counts = diagnostic.snapshot().counts;
  assert.equal(counts.sessionUpdatesAccepted, 1);
  assert.equal(counts.audioPacketsSent, 20);
  assert.equal(counts.audioFramesSent, 0);
  assert.equal(counts.audioBytesSent, 1000);
  diagnostic.sent('session.update');
  diagnostic.event({ type: 'session.updated' });
  assert.equal(diagnostic.snapshot().counts.sessionUpdatesAccepted, 2);
});

void test('invalid_value diagnostics distinguish omitted and filtered parameters without retaining values', () => {
  for (const field of ['item_id', 'audio_end_ms', 'item.content[0].type']) {
    const fault = safeRealtimeFault(
      realtimeFault({ code: 'invalid_value', param: field }),
    );
    assert.equal(fault.fieldPath, field.replace('[0]', '.0'));
    assert.equal(fault.parameterStatus, 'allowed');
  }
  const absent = realtimeFault({ code: 'invalid_value', param: null });
  assert.equal(absent.parameterStatus, 'absent');
  const filtered = safeRealtimeFault(
    realtimeFault({
      code: 'invalid_value',
      param: 'sk-private-value',
      message: 'private conversation',
    }),
  );
  assert.equal(filtered.parameterStatus, 'unrecognized');
  assert.equal(filtered.fieldPath, undefined);
  assert.doesNotMatch(
    JSON.stringify(filtered),
    /sk-private|private conversation/,
  );
});

void test('recoverable cancellation or policy rejection does not label a normal close as broken', () => {
  const diagnostic = new RealtimeDiagnostics('openai');
  diagnostic.fault({ code: 'response_cancel_not_active' });
  assert.equal(diagnostic.snapshot().error, undefined);
  diagnostic.sent('session.update');
  diagnostic.fault(
    { code: 'REALTIME_CONFIG', fieldPath: 'session.instructions' },
    true,
  );
  diagnostic.close('local_stop');
  assert.equal(diagnostic.snapshot().state, 'closed');
  assert.equal(diagnostic.snapshot().counts.sessionUpdatesRejected, 1);
  const failed = new RealtimeDiagnostics('openai');
  failed.fault({ code: 'response_cancel_not_active' });
  failed.fault({ code: 'REALTIME_TIMEOUT' });
  failed.close('protocol_error');
  assert.equal(failed.snapshot().state, 'error');
  assert.equal(failed.snapshot().error?.code, 'REALTIME_TIMEOUT');
});

void test('failed response terminals retain safe model errors without response payloads', () => {
  for (const provider of ['openai', 'qwen', 'glm'] as const) {
    const raw = {
      type: 'response.done',
      response: {
        id: 'private-id',
        status: 'failed',
        status_details: {
          error: {
            code: 'invalid_value',
            param: 'session.audio.output.voice',
            message: 'private speech and credentials',
          },
        },
      },
    };
    const normalized = new RealtimeEvents(provider).normalize(raw)!;
    assert.equal(
      normalized.response?.error?.fieldPath,
      'session.audio.output.voice',
    );
    assert.equal(normalized.response?.status_details, undefined);
    const diagnostic = new RealtimeDiagnostics(provider);
    diagnostic.event(raw);
    diagnostic.close('protocol_error');
    const result = diagnostic.snapshot();
    assert.equal(result.error?.code, 'REALTIME_CONFIG');
    assert.equal(result.counts.responsesDone, 1);
    assert.doesNotMatch(
      JSON.stringify(result),
      /private-id|private speech|credentials/,
    );
  }
  assert.deepEqual(
    safeRealtimeFault({
      code: 'REALTIME_CONFIG',
      requestType: 'output_audio_buffer.clear',
      requestStatus: 'matched',
      event_id: 'private-id',
    }),
    {
      code: 'REALTIME_CONFIG',
      requestType: 'output_audio_buffer.clear',
      requestStatus: 'matched',
    },
  );
  assert.equal(
    safeRealtimeFault({ code: 'REALTIME_CONFIG', requestType: 'private-event' })
      .requestType,
    undefined,
  );
});
