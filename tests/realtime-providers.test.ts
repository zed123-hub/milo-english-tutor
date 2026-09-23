import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import WebSocket, { WebSocketServer } from 'ws';
import {
  realtimeConfig,
  websocketSession,
  RealtimeEvents,
  type RealtimeProvider,
} from '../lib/coach/realtime-providers';
import { realtimeSession } from '../lib/coach/teacher';
import { freshData } from '../lib/coach/model';
import { SettingsStore, defaultSettings } from '../local/settings';
import { SqliteRepository } from '../local/repository';
import { CoachService } from '../local/service';
import { RealtimeRelay } from '../local/realtime-relay';
import { GLMInput } from '../local/glm-input';
import { RealtimeOutput } from '../local/realtime-output';
import { PCMPlayback, decodePCM } from '../lib/coach/pcm-realtime';
import {
  realtimeFault,
  realtimeErrorMessage,
} from '../lib/coach/realtime-errors';
import type { RealtimeDiagnostic } from '../lib/coach/realtime-diagnostics';

void test('realtime output: congestion drains in order and close discards queued work', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: string[] = [];
  const failures: string[] = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 256001,
    send(text: string, callback: (error?: Error) => void) {
      sent.push(JSON.parse(text).type);
      callback();
    },
  };
  const output = new RealtimeOutput(
    socket,
    (code) => failures.push(code),
    () => {},
  );
  t.after(() => output.close());
  for (const type of [
    'input_audio_buffer.append',
    'input_audio_buffer.commit',
    'response.create',
  ])
    output.send({ type });
  assert.deepEqual(sent, []);
  socket.bufferedAmount = 0;
  t.mock.timers.tick(25);
  assert.deepEqual(sent, [
    'input_audio_buffer.append',
    'input_audio_buffer.commit',
    'response.create',
  ]);
  socket.bufferedAmount = 256001;
  output.send({ type: 'response.create' });
  output.close();
  socket.bufferedAmount = 0;
  t.mock.timers.tick(10000);
  assert.equal(sent.length, 3);
  assert.deepEqual(failures, []);
});

void test('realtime output: a temporary 12 second stall recovers without locally ending the call', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  const sent: string[] = [],
    failures: string[] = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 69168,
    send(text: string, callback: (error?: Error) => void) {
      sent.push(JSON.parse(text).type);
      callback();
    },
  };
  const output = new RealtimeOutput(
    socket,
    (error) => failures.push(error),
    () => {},
    () => now,
  );
  t.after(() => output.close());
  for (const type of [
    'input_audio_buffer.append',
    'input_audio_buffer.commit',
    'response.create',
  ])
    output.send({ type });
  now = 12000;
  t.mock.timers.tick(25);
  assert.deepEqual(
    failures,
    [],
    'Elapsed queue age alone is not a remote disconnect',
  );
  socket.bufferedAmount = 0;
  t.mock.timers.tick(25);
  assert.deepEqual(sent, [
    'input_audio_buffer.append',
    'input_audio_buffer.commit',
    'response.create',
  ]);
  assert.equal(output.idle, true);
});

void test('realtime output: congestion is byte-bounded and a closed socket still fails', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  const failures: string[] = [];
  let sent = 0;
  const socket = {
    readyState: 1,
    bufferedAmount: 256001,
    send() {
      sent++;
    },
  };
  const output = new RealtimeOutput(
    socket,
    (code) => failures.push(code),
    () => {},
    () => now,
  );
  t.after(() => output.close());
  output.send({ type: 'input_audio_buffer.append', audio: 'AAA=' });
  assert.throws(
    () => output.send({ audio: 'A'.repeat(1024 * 1024) }),
    /REALTIME_BACKPRESSURE/,
  );
  now = 10000;
  t.mock.timers.tick(25);
  assert.deepEqual([...failures], []);
  socket.readyState = 3;
  t.mock.timers.tick(25);
  assert.deepEqual(failures, ['REALTIME_CONNECTION']);
  socket.readyState = 1;
  socket.bufferedAmount = 0;
  t.mock.timers.tick(1000);
  output.send({ type: 'response.create' });
  assert.equal(sent, 0);
  assert.equal(failures.length, 1);
});

void test('realtime output: interruption and pause discard unsent response requests', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const action of ['interrupt', 'pause']) {
    const sent: string[] = [];
    const socket = {
      readyState: 1,
      bufferedAmount: 256001,
      send(text: string, callback: (error?: Error) => void) {
        sent.push(JSON.parse(text).type);
        callback();
      },
    };
    const output = new RealtimeOutput(
      socket,
      () => assert.fail('Unexpected connection failure'),
      () => {},
    );
    t.after(() => output.close());
    output.send({ type: 'input_audio_buffer.commit' });
    output.send({ type: 'response.create' });
    if (action === 'interrupt') output.send({ type: 'response.cancel' });
    else output.cancelResponses();
    socket.bufferedAmount = 0;
    t.mock.timers.tick(25);
    assert.deepEqual(
      sent,
      action === 'interrupt'
        ? ['input_audio_buffer.commit', 'response.cancel']
        : ['input_audio_buffer.commit'],
    );
  }
});

void test('GLM client VAD: silence and brief noise do not call the model; a spoken turn commits automatically', () => {
  const sent: { type: string }[] = [];
  const speech: { type: string; item_id?: string }[] = [];
  const input = new GLMInput(
    (e) => sent.push(e as { type: string }),
    (e) => speech.push(e),
    () => sent.push({ type: 'response.create' }),
  );
  for (let i = 0; i < 20; i++) input.push('silence', 0, 100);
  input.push('click', 0.1, 100);
  input.push('silence', 0, 100);
  assert.equal(sent.length, 0);
  input.push('speech-one', 0.03, 100);
  input.push('speech-two', 0.03, 100);
  assert.equal(speech[0].type, 'input_audio_buffer.speech_started');
  for (let i = 0; i < 11; i++) input.push('silence', 0, 100);
  assert.equal(
    sent.filter((e) => e.type === 'input_audio_buffer.commit').length,
    0,
  );
  input.push('silence', 0, 100);
  assert.equal(sent.at(-1)?.type, 'input_audio_buffer.commit');
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 0);
  assert.equal(speech[1].type, 'input_audio_buffer.speech_stopped');
  assert.equal(speech[0].item_id, speech[1].item_id);
  input.accept({
    type: 'input_audio_buffer.committed',
    item_id: 'upstream-first',
  });
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 1);
  for (let i = 0; i < 280; i++) input.push('long-speech', 0.03, 100);
  assert.equal(
    sent.filter((e) => e.type === 'input_audio_buffer.commit').length,
    2,
  );
  assert.equal(
    sent.filter((e) => e.type === 'response.create').length,
    1,
    'Long speech is segmented without interrupting the learner with a reply',
  );
  for (let i = 0; i < 12; i++) input.push('silence', 0, 100);
  assert.equal(
    sent.filter((e) => e.type === 'response.create').length,
    1,
    'Final silence still waits for the segmented commit acknowledgement',
  );
  input.accept({
    type: 'input_audio_buffer.committed',
    item_id: 'upstream-second',
  });
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 2);
  input.accept({
    type: 'input_audio_buffer.committed',
    item_id: 'upstream-second',
  });
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 2);
  input.clear();
});

void test('GLM client VAD: acknowledged long segments wait for final silence and respond once', () => {
  const sent: { type: string }[] = [];
  const input = new GLMInput(
    (event) => sent.push(event as { type: string }),
    () => {},
    () => sent.push({ type: 'response.create' }),
  );
  for (let i = 0; i < 280; i++) input.push('long-one', 0.03, 100);
  input.accept({
    type: 'input_audio_buffer.committed',
    item_id: 'long-upstream-one',
  });
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 0);
  for (let i = 0; i < 280; i++) input.push('long-two', 0.03, 100);
  input.accept({
    type: 'input_audio_buffer.committed',
    item_id: 'long-upstream-two',
  });
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 0);
  for (let i = 0; i < 12; i++) input.push('silence', 0, 100);
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 1);
  input.accept({
    type: 'input_audio_buffer.committed',
    item_id: 'long-upstream-two',
  });
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 1);
});

void test('GLM client VAD: a late acknowledgement cannot answer while the next utterance is active', () => {
  const sent: { type: string }[] = [];
  const input = new GLMInput(
    (event) => sent.push(event as { type: string }),
    () => {},
    () => sent.push({ type: 'response.create' }),
  );
  input.push('first-one', 0.03, 100);
  input.push('first-two', 0.03, 100);
  for (let i = 0; i < 12; i++) input.push('silence', 0, 100);
  input.push('second-one', 0.03, 100);
  input.push('second-two', 0.03, 100);
  input.accept({
    type: 'input_audio_buffer.committed',
    item_id: 'late-first',
  });
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 0);
  for (let i = 0; i < 12; i++) input.push('silence', 0, 100);
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 0);
  input.accept({
    type: 'input_audio_buffer.committed',
    item_id: 'second-final',
  });
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 1);
});

void test('GLM client VAD: early transcription keeps the local speech identity and hint timing', () => {
  const speech: { item_id?: string }[] = [];
  let responses = 0;
  const input = new GLMInput(
    () => {},
    (event) => speech.push(event),
    () => responses++,
  );
  input.push('one', 0.03, 100);
  input.push('two', 0.03, 100);
  for (let i = 0; i < 12; i++) input.push('silence', 0, 100);
  const transcription = {
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'upstream-one',
    transcript: 'I enjoy learning English.',
  };
  assert.deepEqual(input.accept(transcription), []);
  assert.equal(responses, 0);
  const delivered = input.accept({
    type: 'input_audio_buffer.committed',
    item_id: 'upstream-one',
  });
  assert.equal(delivered.length, 2);
  assert.equal(responses, 1);
  assert.ok(delivered.every((event) => event.item_id === speech[0].item_id));
  assert.equal(input.accept(transcription)[0].item_id, speech[0].item_id);
  input.accept({
    type: 'input_audio_buffer.committed',
    item_id: 'upstream-one',
  });
  assert.equal(responses, 1);
});

void test('GLM client VAD: pause and clear revoke replies waiting on late acknowledgements', () => {
  const sent: { type: string }[] = [];
  const input = new GLMInput(
    (event) => sent.push(event as { type: string }),
    () => {},
    () => sent.push({ type: 'response.create' }),
  );
  input.push('one', 0.03, 100);
  input.push('two', 0.03, 100);
  input.finish();
  input.finish();
  assert.equal(
    sent.filter((e) => e.type === 'input_audio_buffer.commit').length,
    1,
  );
  input.accept({
    type: 'input_audio_buffer.committed',
    item_id: 'paused-input',
  });
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 0);
  input.push('next-one', 0.03, 100);
  input.push('next-two', 0.03, 100);
  for (let i = 0; i < 12; i++) input.push('silence', 0, 100);
  input.clear();
  input.accept({
    type: 'input_audio_buffer.committed',
    item_id: 'cleared-input',
  });
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 0);
  for (let i = 0; i < 280; i++) input.push('long-before-pause', 0.03, 100);
  input.finish();
  input.accept({
    type: 'input_audio_buffer.committed',
    item_id: 'paused-long-segment',
  });
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 0);
});

void test('realtime errors: preserve actionable GLM codes without exposing key-bearing upstream text', () => {
  for (const [code, category] of [
    ['1113', 'MODEL_BALANCE'],
    ['1002', 'MODEL_AUTH'],
    ['1220', 'MODEL_PERMISSION'],
    ['1213', 'REALTIME_CONFIG'],
    ['1261', 'REALTIME_CONTEXT'],
    ['1302', 'MODEL_LIMIT'],
    ['1305', 'MODEL_BUSY'],
    ['1315', 'MODEL_PERMISSION'],
  ]) {
    const fault = realtimeFault({
      code: Number(code),
      message:
        'input_audio_format missing; Authorization: Bearer fixture-private-key',
      request: { key: 'fixture-private-key' },
    });
    assert.equal(fault.code, category);
    assert.equal(fault.providerCode, code);
    assert.doesNotMatch(
      JSON.stringify(fault) + realtimeErrorMessage(fault),
      /fixture-private-key|Bearer|Authorization/,
    );
  }
  assert.match(
    realtimeErrorMessage(
      realtimeFault({
        code: '1213',
        message: 'input_audio_format is required',
      }),
    ),
    /参数兼容问题/,
  );
  assert.doesNotMatch(
    realtimeErrorMessage(realtimeFault({ code: '1213' })),
    /余额|充值/,
  );
  assert.deepEqual(
    realtimeFault({
      code: 'fixture-private-key',
      message: 'fixture-private-key',
    }),
    { code: 'MODEL_FAILED' },
  );
  assert.deepEqual(realtimeFault({ code: 'constructor', type: '__proto__' }), {
    code: 'MODEL_FAILED',
  });
});

void test('realtime errors: retain only allowlisted validation paths, never rejected values or request text', () => {
  const fault = realtimeFault({
    code: 'model_query_error',
    message:
      'request failed with status: 422, rsp body: ' +
      JSON.stringify({
        detail: [
          {
            type: 'string_type',
            loc: [
              'body',
              'tools',
              0,
              'function',
              'parameters',
              'properties',
              'level',
              'description',
            ],
            input: 'fixture-private-key',
            msg: 'Bearer fixture-private-key',
          },
          {
            type: 'missing',
            loc: ['body', 'fixture-private-key'],
            input: { key: 'fixture-private-key' },
          },
          { type: 'fixture-private-key', loc: ['body', 'tools'] },
        ],
      }),
  });
  assert.equal(fault.code, 'REALTIME_CONFIG');
  assert.deepEqual(fault.validation, [
    {
      path: 'body.tools.0.function.parameters.properties.level.description',
      rule: 'string_type',
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(fault),
    /fixture-private-key|Bearer|input|msg/,
  );
});

void test('providers: official endpoints, model families and provider-specific sessions', () => {
  const base = realtimeSession(freshData(), 'test');
  const qwen = realtimeConfig({
    realtimeProvider: 'qwen',
    realtimeModel: 'qwen3.5-omni-flash-realtime',
  });
  const glm = realtimeConfig({
    realtimeProvider: 'glm',
    realtimeModel: 'glm-realtime-air',
  });
  const q = websocketSession(qwen, base.instructions, base.tools).session;
  const g = websocketSession(glm, base.instructions, base.tools).session;
  assert.ok('audio' in q && q.audio?.input.format.sample_rate === 16000);
  assert.ok('input_audio_format' in g && g.input_audio_format === 'pcm24');
  assert.match(
    g.instructions,
    /never end consecutive tutor turns with questions/i,
  );
  assert.equal(g.beta_fields.greeting_config.enable, false);
  assert.equal(g.beta_fields.greeting_config.content, 'Hello.');
  assert.ok('output_audio_format' in g && g.output_audio_format === 'pcm');
  assert.ok(!('input_audio_transcription' in g));
  assert.ok(!('tool_choice' in q));
  assert.equal(
    (q.tools[0] as { function?: { name: string } }).function?.name,
    'record_hint',
  );
  assert.equal((g.tools[0] as { name?: string }).name, 'record_hint');
  for (const realtimeBaseUrl of [
    'wss://evil.example/api-ws/v1/realtime',
    'ws://dashscope.aliyuncs.com/api-ws/v1/realtime',
    'wss://dashscope.aliyuncs.com.evil.test/api-ws/v1/realtime',
    'wss://key@dashscope.aliyuncs.com/api-ws/v1/realtime',
    'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?api_key=x',
  ]) {
    assert.throws(
      () =>
        realtimeConfig({
          realtimeProvider: 'qwen',
          realtimeModel: qwen.model,
          realtimeBaseUrl,
        }),
      /MODEL_ENDPOINT/,
    );
  }
  assert.throws(
    () =>
      realtimeConfig({
        realtimeProvider: 'qwen',
        realtimeModel: 'qwen3-omni-flash-realtime',
      }),
    /REALTIME_MODEL/,
  );
  assert.equal(
    realtimeConfig({
      realtimeProvider: 'qwen',
      realtimeModel: qwen.model,
      realtimeBaseUrl:
        'wss://workspace-123.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',
    }).provider,
    'qwen',
  );
});

void test('GLM: tutor tools avoid empty schemas rejected after session setup', () => {
  const base = realtimeSession(freshData(), 'test');
  const config = realtimeConfig({
    realtimeProvider: 'glm',
    realtimeModel: 'glm-realtime-air',
  });
  const session = websocketSession(
    config,
    base.instructions,
    base.tools,
  ).session;
  for (const tool of session.tools) {
    const parameters = (
      tool as {
        parameters: { properties: Record<string, unknown>; required: string[] };
      }
    ).parameters;
    assert.ok(Object.keys(parameters.properties).length > 0);
    assert.ok(parameters.required?.length > 0);
  }
  const fault = realtimeFault({
    code: 'model_query_error',
    message:
      'request failed with status: 422; tools parameters properties dict_type null; fixture-private-key',
  });
  assert.equal(fault.code, 'REALTIME_CONFIG');
  assert.equal(fault.providerCode, 'model_query_error');
  assert.doesNotMatch(JSON.stringify(fault), /fixture-private-key/);
});

void test('providers: keys stay in memory, never cross provider or endpoint boundaries', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'milo-rt-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SettingsStore(dir);
  store.save({
    ...defaultSettings,
    voiceMode: 'realtime',
    voiceKey: 'fixture-openai-key',
    realtimeProvider: 'qwen',
    realtimeModel: 'qwen3.5-omni-flash-realtime',
  });
  assert.equal(store.public().conversationReady, false);
  store.save({ ...store.public(), realtimeKey: 'fixture-qwen-key' });
  assert.equal(store.realtimeCredentials().key, 'fixture-qwen-key');
  assert.equal(store.public().conversationReady, true);
  assert.doesNotMatch(
    readFileSync(join(dir, 'preferences.json'), 'utf8'),
    /fixture-/,
  );
  assert.doesNotMatch(JSON.stringify(store.public()), /fixture-/);
  store.save({
    ...store.public(),
    realtimeBaseUrl: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime',
  });
  assert.throws(() => store.realtimeCredentials(), /KEY_REQUIRED/);
  store.save({
    ...store.public(),
    realtimeProvider: 'glm',
    realtimeModel: 'glm-realtime-air',
    realtimeBaseUrl: '',
    realtimeVoice: 'tongtong',
  });
  assert.equal(store.public().conversationReady, false);
  store.save({ ...store.public(), realtimeKey: 'fixture-glm-key' });
  assert.equal(store.realtimeCredentials().key, 'fixture-glm-key');
  assert.equal(new SettingsStore(dir).public().conversationReady, false);
  store.save({ ...store.public(), forgetKeys: true });
  assert.equal(store.public().realtimeKeyConfigured, false);
});

void test('providers: beta audio normalization and one tool batch preserve call identity', () => {
  for (const provider of ['qwen', 'glm'] as const) {
    const events = new RealtimeEvents(provider);
    events.normalize({
      type: 'response.created',
      response: { id: 'r1', status: 'in_progress' },
    });
    assert.equal(
      events.normalize({ type: 'response.audio.delta', delta: 'AQI=' })
        ?.response_id,
      'r1',
    );
    assert.equal(
      events.normalize({
        type: 'response.audio_transcript.done',
        transcript: 'Hello.',
      })?.type,
      'response.output_audio_transcript.done',
    );
    const call = {
      type: 'response.function_call_arguments.done',
      response_id: 'r1',
      name: 'checkpoint',
      arguments: '{}',
      ...(provider === 'qwen' ? { call_id: 'c1' } : {}),
    };
    events.normalize(call);
    events.normalize(call);
    const done = events.normalize({
      type: 'response.done',
      response: { id: 'r1', status: 'completed' },
    })!;
    assert.equal(done.response?.output?.length, 1);
    const result = events.toolResult(
      done.response!.output![0].call_id,
      '{"ok":true}',
    );
    assert.equal(Object.hasOwn(result.item, 'call_id'), provider === 'qwen');
    assert.equal(
      events.normalize({ type: 'error', error: { code: 'stop_task_error' } })
        ?.error?.code,
      'response_cancel_not_active',
    );
    assert.equal(
      events.normalize({ type: 'debug.secret', delta: 'fixture-api-key' }),
      null,
    );
  }
});

void test('GLM: late tool arguments are delivered once, but cancelled responses stay cancelled', () => {
  for (const status of ['completed', 'cancelled']) {
    const events = new RealtimeEvents('glm');
    events.normalize({ type: 'response.created', response_id: 'late' });
    const terminal = {
      type: 'response.done',
      response: { id: 'late', status },
    };
    const first = events.normalize(terminal);
    assert.equal(first?.response?.output?.length, 0);
    const call = {
      type: 'response.function_call_arguments.done',
      response_id: 'late',
      name: 'checkpoint',
      arguments: '{}',
    };
    const delivered = events.normalize(call);
    assert.equal(
      delivered?.response?.output?.length ?? 0,
      status === 'completed' ? 1 : 0,
      'A completed response must still deliver its late tool result',
    );
    assert.equal(events.normalize(call), null, 'Never execute a tool twice');
    assert.equal(events.normalize(terminal)?.response?.output?.length ?? 0, 0);
  }
});

void test('audio: worklet resamples 44.1/48 kHz continuously into little-endian 100 ms frames', () => {
  for (const sourceRate of [44100, 48000])
    for (const targetRate of [16000, 24000]) {
      const frames: ArrayBuffer[] = [];
      let Capture: new (options: {
        processorOptions: { targetRate: number };
      }) => { process(inputs: Float32Array[][]): boolean };
      runInNewContext(
        readFileSync('public/audio/milo-pcm-worklet.js', 'utf8'),
        {
          sampleRate: sourceRate,
          AudioWorkletProcessor: class {
            port = { postMessage: (frame: ArrayBuffer) => frames.push(frame) };
          },
          registerProcessor(_name: string, ctor: typeof Capture) {
            Capture = ctor;
          },
        },
      );
      const capture = new Capture!({ processorOptions: { targetRate } });
      for (let offset = 0; offset < sourceRate; offset += 128)
        capture.process([
          [new Float32Array(Math.min(128, sourceRate - offset)).fill(0.5)],
        ]);
      assert.equal(frames.length, 10);
      assert.ok(frames.every((f) => f.byteLength === (targetRate / 10) * 2));
      assert.equal(new DataView(frames[0]).getInt16(0, true), 16384);
    }
  assert.deepEqual(
    Array.from(decodePCM(Buffer.from([0, 128, 255, 127]).toString('base64'))),
    [-1, 32767 / 32768],
  );
});

void test('audio: generation completion waits for actual playback; interruption discards late chunks', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sources: { onended: (() => void) | null; stop: () => void }[] = [];
  let stopped = 0;
  const context = {
    currentTime: 0,
    destination: {},
    createBuffer: (_channels: number, length: number, rate: number) => ({
      duration: length / rate,
      copyToChannel() {},
    }),
    createBufferSource: () => {
      const source = {
        onended: null as (() => void) | null,
        buffer: null,
        connect() {},
        disconnect() {},
        start() {},
        stop() {
          stopped++;
        },
      };
      sources.push(source);
      return source;
    },
  };
  const events: string[] = [];
  const player = new PCMPlayback(
    context as unknown as AudioContext,
    24000,
    (e) => events.push(e.type),
  );
  player.append('one', Buffer.alloc(4800).toString('base64'));
  t.mock.timers.tick(26);
  player.done('one');
  assert.deepEqual(events, ['output_audio_buffer.started']);
  sources[0].onended!();
  assert.deepEqual(events, [
    'output_audio_buffer.started',
    'output_audio_buffer.stopped',
  ]);
  player.append('two', Buffer.alloc(4800).toString('base64'));
  player.clear();
  player.append('two', Buffer.alloc(4800).toString('base64'));
  assert.equal(sources.length, 2);
  assert.equal(stopped, 1);
});

for (const provider of ['qwen', 'glm'] as RealtimeProvider[])
  void test(`relay: ${provider} streams through authenticated local ticket and shuts down with the session`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'milo-rt-relay-'));
    const repo = new SqliteRepository(join(dir, 'test.sqlite'));
    const settings = new SettingsStore(dir);
    settings.save({
      ...defaultSettings,
      voiceMode: 'realtime',
      realtimeProvider: provider,
      realtimeModel:
        provider === 'qwen'
          ? 'qwen3.5-omni-flash-realtime'
          : 'glm-realtime-air',
      realtimeKey: 'fixture-realtime-key',
    });
    const service = new CoachService(repo, settings);
    const state = repo.read(),
      data = freshData();
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
    const received: Record<string, unknown>[] = [];
    let remoteSocket: WebSocket | undefined;
    remote.on('connection', (ws, req) => {
      assert.equal(req.headers.authorization, 'Bearer fixture-realtime-key');
      remoteSocket = ws;
      ws.send(JSON.stringify({ type: 'session.created' }));
      ws.on('message', (raw) => {
        const event = JSON.parse(
          (Array.isArray(raw)
            ? Buffer.concat(raw)
            : Buffer.isBuffer(raw)
              ? raw
              : Buffer.from(raw)
          ).toString('utf8'),
        ) as Record<string, unknown>;
        received.push(event);
        if (event.type === 'session.update') {
          if (provider === 'glm')
            setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify({ type: 'session.updated' }));
            }, 30);
          else ws.send(JSON.stringify({ type: 'session.updated' }));
        }
      });
    });
    const server = createServer();
    let congested = false;
    const savedDiagnostics: RealtimeDiagnostic[] = [];
    const relay = new RealtimeRelay(
      service,
      (_url, key) => {
        const socket = new WebSocket(`ws://127.0.0.1:${remotePort}`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        Object.defineProperty(socket, 'bufferedAmount', {
          get: () =>
            congested
              ? 256001
              : Number(
                  Reflect.get(WebSocket.prototype, 'bufferedAmount', socket),
                ),
        });
        return socket;
      },
      (report) => savedDiagnostics.push(report),
    );
    relay.attach(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port,
      origin = `http://localhost:${port}`;
    t.after(async () => {
      relay.close();
      service.close();
      for (const ws of remote.clients) ws.terminate();
      await new Promise<void>((r) => remote.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const epoch = repo.read().epoch;
    const denied = relay.issue('session', epoch, origin);
    const bad = new WebSocket(
      `ws://localhost:${port}/api/local/realtime/socket`,
      ['milo-realtime', denied.ticket],
      { origin: 'https://evil.example' },
    );
    await assert.rejects(once(bad, 'open'), /403/);
    const ticket = relay.issue('session', epoch, origin);
    const browser = new WebSocket(
      `ws://localhost:${port}/api/local/realtime/socket`,
      ['milo-realtime', ticket.ticket],
      { origin },
    );
    const messages: Record<string, unknown>[] = [];
    browser.on('message', (raw) =>
      messages.push(
        JSON.parse(
          (Array.isArray(raw)
            ? Buffer.concat(raw)
            : Buffer.isBuffer(raw)
              ? raw
              : Buffer.from(raw)
          ).toString('utf8'),
        ) as Record<string, unknown>,
      ),
    );
    const until = async (predicate: () => boolean) => {
      const start = Date.now();
      while (!predicate()) {
        if (Date.now() - start > 1500) throw Error('fixture timed out');
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    await until(() => messages.some((e) => e.type === 'milo.ready'));
    if (provider === 'glm') {
      await until(() => received.some((e) => e.type === 'response.create'));
      assert.equal(
        received.filter((e) => e.type === 'response.create').length,
        1,
        'The opening is generated after configuration, never supplied as canned speech',
      );
      remoteSocket!.send(
        JSON.stringify({
          type: 'response.created',
          response: { id: 'opening', status: 'in_progress' },
        }),
      );
      remoteSocket!.send(
        JSON.stringify({
          type: 'response.done',
          response: { id: 'opening', status: 'completed' },
        }),
      );
      await until(() =>
        messages.some(
          (e) =>
            e.type === 'response.done' &&
            (e.response as { id?: string })?.id === 'opening',
        ),
      );
    }
    assert.equal(browser.protocol, 'milo-realtime');
    // Browser suspension is not a closed WebSocket. Move the media clock forward
    // without producing audio; the relay must remain available when capture resumes.
    const actualNow = Date.now;
    let timeOffset = 21000;
    t.mock.method(Date, 'now', () => actualNow() + timeOffset);
    await new Promise((r) => setTimeout(r, 2100));
    assert.equal(
      browser.readyState,
      WebSocket.OPEN,
      'A 21 second input gap must not end a healthy relay',
    );
    assert.equal(messages.filter((e) => e.type === 'error').length, 0);
    const replay = new WebSocket(
      `ws://localhost:${port}/api/local/realtime/socket`,
      ['milo-realtime', ticket.ticket],
      { origin },
    );
    await assert.rejects(once(replay, 'open'), /403/);
    browser.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: Buffer.alloc((ticket.inputRate / 10) * 2).toString('base64'),
      }),
    );
    await until(() => relay.status()?.inputFrames === 1);
    // More than three minutes have elapsed since setup, but the learner's
    // accepted microphone frame is recent enough to keep the call alive.
    timeOffset = 181000;
    await new Promise((r) => setTimeout(r, 2100));
    assert.equal(
      browser.readyState,
      WebSocket.OPEN,
      'Accepted learner audio must refresh the inactivity clock',
    );
    if (provider === 'glm') {
      const voiced = Buffer.alloc((ticket.inputRate / 10) * 2);
      for (let i = 0; i < voiced.length; i += 2) voiced.writeInt16LE(1000, i);
      for (let i = 0; i < 14; i++)
        browser.send(
          JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: (i < 2 ? voiced : Buffer.alloc(voiced.length)).toString(
              'base64',
            ),
          }),
        );
      await until(() =>
        received.some((e) => e.type === 'input_audio_buffer.commit'),
      );
      assert.ok(
        messages.some((e) => e.type === 'input_audio_buffer.speech_started'),
      );
      assert.ok(
        messages.some((e) => e.type === 'input_audio_buffer.speech_stopped'),
      );
      assert.equal(
        received.filter((e) => e.type === 'response.create').length,
        1,
      );
      remoteSocket!.send(
        JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: 'input-one',
          transcript: 'I enjoy learning English.',
        }),
      );
      remoteSocket!.send(
        JSON.stringify({
          type: 'input_audio_buffer.committed',
          item_id: 'input-one',
        }),
      );
      await until(
        () => received.filter((e) => e.type === 'response.create').length === 2,
      );
      assert.ok(
        received.findLastIndex((e) => e.type === 'response.create') >
          received.findIndex((e) => e.type === 'input_audio_buffer.commit'),
      );
      await until(() =>
        messages.some(
          (e) =>
            e.type === 'conversation.item.input_audio_transcription.completed',
        ),
      );
      assert.equal(
        messages.find(
          (e) =>
            e.type === 'conversation.item.input_audio_transcription.completed',
        )!.item_id,
        messages.find((e) => e.type === 'input_audio_buffer.speech_started')!
          .item_id,
      );
    }
    await until(() =>
      received.some((e) => e.type === 'input_audio_buffer.append'),
    );
    remoteSocket!.send(
      JSON.stringify({
        type: 'response.created',
        response: { id: 'r1', status: 'in_progress' },
      }),
    );
    remoteSocket!.send(
      JSON.stringify({
        type: 'response.audio.delta',
        response_id: 'r1',
        delta: 'AQI=',
      }),
    );
    await until(() =>
      messages.some((e) => e.type === 'response.output_audio.delta'),
    );
    if (provider === 'qwen') {
      // Chrome can deliver several seconds of queued Worklet messages together
      // after the main thread stalls while the teacher is speaking.
      congested = true;
      for (let i = 0; i < 120; i++)
        browser.send(
          JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: Buffer.alloc((ticket.inputRate / 10) * 2).toString('base64'),
          }),
        );
      await until(
        () =>
          messages.some((e) => e.type === 'error') ||
          relay.status()?.inputFrames === 121,
      );
      assert.equal(
        messages.some((e) => e.type === 'error'),
        false,
        'Valid queued microphone frames must not disconnect Qwen after its reply',
      );
      assert.equal(
        received.filter((e) => e.type === 'input_audio_buffer.append').length,
        1,
        'A temporarily busy upstream retains a bounded queue instead of dropping speech',
      );
      congested = false;
      await until(
        () =>
          received.filter((e) => e.type === 'input_audio_buffer.append')
            .length === 121,
      );
      assert.equal(
        received.filter((e) => e.type === 'input_audio_buffer.append').length,
        121,
      );
    }
    remoteSocket!.send(
      JSON.stringify({
        type: 'response.done',
        response: { id: 'r1', status: 'completed' },
      }),
    );
    await until(() => messages.some((e) => e.type === 'response.done'));
    assert.doesNotMatch(JSON.stringify(messages), /fixture-realtime-key/);
    browser.send(
      JSON.stringify({
        type: 'session.update',
        session: { instructions: 'UNTRUSTED_CLIENT_PROMPT' },
      }),
    );
    await until(
      () => received.filter((e) => e.type === 'session.update').length === 2,
    );
    assert.doesNotMatch(JSON.stringify(received), /UNTRUSTED_CLIENT_PROMPT/);
    if (provider === 'glm') {
      const refresh = received.filter((e) => e.type === 'session.update')[1]
        .session as Record<string, unknown>;
      assert.equal(
        refresh.voice,
        'tongtong',
        'GLM rejects or resets an instructions-only refresh after the greeting',
      );
      assert.equal(refresh.input_audio_format, 'pcm24');
      assert.equal(refresh.output_audio_format, 'pcm');
      assert.equal(
        (refresh.turn_detection as { type: string }).type,
        'client_vad',
      );
      assert.equal(
        (refresh.beta_fields as { greeting_config: { enable: boolean } })
          .greeting_config.enable,
        false,
        'Refreshing the lesson must not repeat the greeting',
      );
    }
    const call = {
      type: 'response.function_call_arguments.done',
      response_id: 'tools',
      name: 'checkpoint',
      arguments: '{}',
      ...(provider === 'qwen' ? { call_id: 'call-one' } : {}),
    };
    const done = {
      type: 'response.done',
      response: { id: 'tools', status: 'completed' },
    };
    for (const event of provider === 'glm' ? [done, call] : [call, done])
      remoteSocket!.send(JSON.stringify(event));
    const hasTools = (event: Record<string, unknown>) =>
      event.type === 'response.done' &&
      !!(event.response as { output?: unknown[] })?.output?.length;
    await until(() => messages.some(hasTools));
    const toolResponse = messages.find(hasTools) as {
      response: { output: { call_id: string }[] };
    };
    browser.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: toolResponse.response.output[0].call_id,
          output: '{"ok":true}',
        },
      }),
    );
    await until(() =>
      received.some((e) => e.type === 'conversation.item.create'),
    );
    const returned = received.find(
      (e) => e.type === 'conversation.item.create',
    ) as { item: { call_id?: string; output: string } };
    assert.equal(
      returned.item.call_id,
      provider === 'qwen' ? 'call-one' : undefined,
    );
    assert.equal(returned.item.output, '{"ok":true}');
    if (provider === 'glm') {
      assert.equal(
        (returned.item as { object?: string }).object,
        'realtime.item',
      );
      browser.send(JSON.stringify({ type: 'response.create', miloNudge: 1 }));
      await until(
        () => received.filter((e) => e.type === 'session.update').length === 3,
      );
      assert.equal(
        received.filter((e) => e.type === 'response.create').length,
        2,
        'GLM response must wait for the configuration acknowledgment',
      );
      const reminder = received.filter((e) => e.type === 'session.update')[2]
        .session as Record<string, unknown>;
      assert.equal(reminder.input_audio_format, 'pcm24');
      assert.equal(
        (reminder.turn_detection as { type: string }).type,
        'client_vad',
      );
      await until(
        () => received.filter((e) => e.type === 'response.create').length === 3,
      );
      remoteSocket!.send(
        JSON.stringify({
          type: 'response.created',
          response: { id: 'nudge-one', status: 'in_progress' },
        }),
      );
      remoteSocket!.send(
        JSON.stringify({
          type: 'response.done',
          response: { id: 'nudge-one', status: 'completed' },
        }),
      );
      await until(() =>
        messages.some(
          (e) =>
            (e.response as { id?: string })?.id === 'nudge-one' &&
            e.type === 'response.done',
        ),
      );
      browser.send(JSON.stringify({ type: 'response.create', miloNudge: 2 }));
      await until(
        () => received.filter((e) => e.type === 'session.update').length === 4,
      );
      browser.send(JSON.stringify({ type: 'milo.input.finish' }));
      await until(() => relay.status()?.updates === 4);
      assert.equal(
        received.filter((e) => e.type === 'response.create').length,
        3,
        'Pausing cancels a continuation waiting for a session acknowledgment',
      );
    }
    const closed = once(browser, 'close');
    remoteSocket!.send(
      JSON.stringify({
        type: 'error',
        error: {
          code: '1213',
          message: 'Missing input_audio_format; key=fixture-realtime-key',
        },
      }),
    );
    await closed;
    assert.equal(browser.readyState, WebSocket.CLOSED);
    const error = messages.find((e) => e.type === 'error') as {
      error: { code: string; providerCode: string };
    };
    assert.equal(error.error.code, 'REALTIME_CONFIG');
    assert.equal(error.error.providerCode, '1213');
    assert.equal(relay.status()?.phase, 'error');
    assert.equal(relay.status()?.inputFrames, provider === 'glm' ? 15 : 121);
    assert.equal(relay.status()?.signalFrames, provider === 'glm' ? 2 : 0);
    assert.equal(relay.status()?.localSpeechStops, provider === 'glm' ? 1 : 0);
    assert.doesNotMatch(
      JSON.stringify(relay.status()),
      /fixture-realtime-key|Missing/,
    );
    if (provider === 'qwen') {
      for (const scenario of [
        { type: 'malformed', code: 'REALTIME_PROTOCOL', stage: 'audio' },
        {
          type: 'controls',
          code: 'REALTIME_EVENT_LIMIT',
          stage: 'control_budget',
        },
        {
          type: 'tiny-audio',
          code: 'REALTIME_BACKPRESSURE',
          stage: 'audio_budget',
        },
        {
          type: 'paused-audio',
          code: 'REALTIME_BACKPRESSURE',
          stage: 'audio_budget',
        },
      ]) {
        const next = relay.issue('session', epoch, origin);
        const ws = new WebSocket(
          `ws://localhost:${port}/api/local/realtime/socket`,
          ['milo-realtime', next.ticket],
          { origin },
        );
        const seen: { type: string; error?: { code: string } }[] = [];
        ws.on('message', (raw) =>
          seen.push(
            JSON.parse(
              (Array.isArray(raw)
                ? Buffer.concat(raw)
                : Buffer.isBuffer(raw)
                  ? raw
                  : Buffer.from(raw)
              ).toString('utf8'),
            ),
          ),
        );
        await until(() => seen.some((event) => event.type === 'milo.ready'));
        const disconnected = once(ws, 'close');
        if (scenario.type === 'paused-audio')
          ws.send(JSON.stringify({ type: 'milo.input.finish' }));
        const event =
          scenario.type === 'controls'
            ? { type: 'response.cancel' }
            : {
                type: 'input_audio_buffer.append',
                audio:
                  scenario.type === 'malformed'
                    ? 'fixture-private-key!'
                    : 'AAA=',
              };
        const count =
          scenario.type === 'malformed'
            ? 1
            : scenario.type === 'controls'
              ? 240
              : 650;
        for (let i = 0; i < count; i++) ws.send(JSON.stringify(event));
        await disconnected;
        assert.equal(
          seen.find((event) => event.type === 'error')?.error?.code,
          scenario.code,
        );
        assert.equal(relay.status()?.localStage, scenario.stage);
        assert.equal(relay.status()?.errorSource, 'local');
        assert.equal(
          savedDiagnostics.at(-1)?.closeCategory,
          scenario.code === 'REALTIME_BACKPRESSURE'
            ? 'transport_error'
            : 'protocol_error',
        );
        assert.doesNotMatch(
          JSON.stringify(relay.status()),
          /fixture-private-key/,
        );
        if (scenario.type === 'paused-audio')
          assert.equal(relay.status()?.inputFrames, 0);
      }
    }
  });
