import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CoachCaptions } from '../components/coach-captions';
import { CoachClient } from '../lib/coach/client';
import { VoiceCoach } from '../lib/coach/voice-coach';
import { freshData } from '../lib/coach/model';
import { effectiveDifficulty } from '../lib/coach/learning-engine';
import {
  RealtimeEvents,
  type RealtimeEvent,
} from '../lib/coach/realtime-providers';
import type { TestContext } from 'node:test';
import { realtimeInstructions } from '../lib/coach/teacher';
void test('realtime: delayed translation keeps spoken English visible instead of replacing it with a waiting message', () => {
  const client = new CoachClient(() => {});
  const markup = renderToStaticMarkup(
    createElement(CoachCaptions, {
      mode: 'bilingual',
      client,
      dispatch() {},
      cues: [
        {
          id: 'teacher-one',
          turnId: 'turn-one',
          text: 'What do you think about travelling alone?',
          words: 8,
          started: true,
          done: false,
          interrupted: false,
          approximate: true,
        },
      ],
    }),
  );
  assert.ok(
    markup.includes('What do you think about travelling alone?'),
    'English must remain readable while Chinese translation is pending',
  );
});
void test('realtime: a fluent first response immediately changes the current teaching pace without claiming long-term mastery', () => {
  const data = freshData();
  const at = new Date().toISOString();
  data.sessions = [{ id: 'one', startedAt: at, endedAt: null, summary: '' }];
  data.activeSessionId = 'one';
  data.turns = [
    {
      id: 'fluent-one',
      sessionId: 'one',
      role: 'user',
      text: 'Actually, I have been using English at work for several years, and I would prefer discussing why remote collaboration sometimes fails despite having so many communication tools.',
      at,
      source: 'realtime',
      seconds: 12,
      hint: 0,
      played: false,
      assessed: false,
    },
  ];
  const now = effectiveDifficulty(data);
  assert.ok(
    now.sentenceWords >= 16,
    'a fluent response must not stay capped at seven words',
  );
  assert.ok(now.scaffolding <= 1);
  assert.equal(data.plan.difficulty.steps, 0);
  assert.equal(data.evidence.length, 0);
});
void test('realtime: a checkpoint cannot hold the next spoken response waiting for a delayed student transcript', async () => {
  const client = new CoachClient(() => {});
  client.snapshot = { revision: 1, epoch: 'one', data: freshData() };
  client.command = async () => ({ snapshot: client.snapshot! });
  const voice = new VoiceCoach(client, {
    status() {},
    error() {},
    message() {},
  });
  const pending = new Set(['delayed-transcript']);
  Object.assign(voice, {
    alive: true,
    pending,
    dc: { readyState: 'open', send() {} },
  });
  const inner = voice as unknown as {
    tool: (item: {
      name: string;
      call_id: string;
      arguments: string;
    }) => Promise<void>;
  };
  const work = inner.tool({
    name: 'checkpoint',
    call_id: 'call-one',
    arguments: '{}',
  });
  const result = await Promise.race([
    work.then(() => 'finished'),
    new Promise<string>((r) => setTimeout(() => r('blocked'), 150)),
  ]);
  pending.clear();
  await work;
  Object.assign(voice, { alive: false });
  assert.equal(result, 'finished');
});

function controlledVoice(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const client = new CoachClient(() => {});
  client.snapshot = { revision: 1, epoch: 'one', data: freshData() };
  const states: string[] = [],
    errors: string[] = [],
    messages: string[] = [],
    sent: { type: string }[] = [];
  const voice = new VoiceCoach(client, {
    status: (s) => states.push(s),
    error: (s) => errors.push(s),
    message: (s) => messages.push(s),
  });
  Object.assign(voice, {
    alive: true,
    dc: {
      readyState: 'open',
      send(raw: string) {
        sent.push(JSON.parse(raw) as { type: string });
      },
    },
    fail(error: Error) {
      errors.push(error.message);
    },
  });
  const inner = voice as unknown as {
    event(e: RealtimeEvent): void;
    send(e: unknown): void;
    clearResponseWait(): void;
    pending: Set<string>;
  };
  t.after(() => {
    inner.clearResponseWait();
    Object.assign(voice, { alive: false });
  });
  return { client, voice, inner, states, errors, messages, sent };
}

void test('realtime: GLM resumes speech after tool arguments arrive after response completion', async (t) => {
  const { client, voice, inner, sent, errors } = controlledVoice(t);
  client.command = async () => ({ snapshot: client.snapshot! });
  const events = new RealtimeEvents('glm');
  const deliver = (event: RealtimeEvent) => {
    const normalized = events.normalize(event);
    if (normalized) inner.event(normalized);
  };
  deliver({ type: 'response.created', response_id: 'late' });
  deliver({
    type: 'response.done',
    response: { id: 'late', status: 'completed' },
  });
  const call = {
    type: 'response.function_call_arguments.done',
    response_id: 'late',
    name: 'checkpoint',
    arguments: '{}',
  };
  deliver(call);
  deliver(call);
  await (voice as unknown as { toolQueue: Promise<void> }).toolQueue;
  assert.equal(
    sent.filter((e) => e.type === 'conversation.item.create').length,
    1,
  );
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 1);
  assert.deepEqual(errors, []);
});

void test('realtime: malformed tools return safe errors and allow only one automatic repair per learner turn', async (t) => {
  const { client, voice, inner, sent, errors, states } = controlledVoice(t);
  const actions: string[] = [];
  client.command = async (action) => {
    actions.push(action);
    return { snapshot: client.snapshot! };
  };
  const respond = async (id: string, name: string, args: string) => {
    inner.event({ type: 'response.created', response_id: id });
    inner.event({
      type: 'response.done',
      response_id: id,
      response: {
        status: 'completed',
        output: [
          {
            type: 'function_call',
            name,
            call_id: id + '-call',
            arguments: args,
          },
        ],
      },
    });
    await (voice as unknown as { toolQueue: Promise<void> }).toolQueue;
  };
  await respond('bad-json', 'checkpoint', '{private-key-and-speech');
  assert.deepEqual(errors, []);
  assert.deepEqual(actions, []);
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 1);
  await respond('bad-level', 'record_hint', '{"level":99}');
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 1);
  assert.equal(states.at(-1), 'listening');
  assert.deepEqual(actions, []);
  assert.equal(
    sent.filter((e) => e.type === 'conversation.item.create').length,
    2,
  );
  assert.match(JSON.stringify(sent), /INVALID_TOOL_ARGUMENTS/);
  assert.doesNotMatch(JSON.stringify(sent), /private-key-and-speech/);
  inner.event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'new-input',
    transcript: 'Could you help me?',
  });
  await respond('next-input', 'record_hint', 'null');
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 2);
  assert.deepEqual(errors, []);
});

void test('realtime: late duplicated malformed GLM arguments produce one error result and one repair', async (t) => {
  const { voice, inner, sent, errors } = controlledVoice(t);
  const normalizer = new RealtimeEvents('glm');
  const deliver = (e: RealtimeEvent) => {
    const normalized = normalizer.normalize(e);
    if (normalized) inner.event(normalized);
  };
  deliver({ type: 'response.created', response_id: 'late-invalid' });
  deliver({
    type: 'response.done',
    response: { id: 'late-invalid', status: 'completed' },
  });
  const argumentsDone = {
    type: 'response.function_call_arguments.done',
    response_id: 'late-invalid',
    name: 'checkpoint',
    arguments: '{broken',
  };
  deliver(argumentsDone);
  deliver(argumentsDone);
  await (voice as unknown as { toolQueue: Promise<void> }).toolQueue;
  assert.deepEqual(errors, []);
  assert.equal(
    sent.filter((e) => e.type === 'conversation.item.create').length,
    1,
  );
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 1);
  assert.match(JSON.stringify(sent), /INVALID_TOOL_ARGUMENTS/);
});
void test('realtime: silent provider gets a bounded response timeout; text alone cannot conceal missing audio', (t) => {
  const { inner, errors, messages } = controlledVoice(t);
  inner.send({ type: 'response.create' });
  t.mock.timers.tick(9000);
  assert.equal(messages.length, 1);
  inner.event({
    type: 'response.output_audio_transcript.delta',
    item_id: 'a',
    response_id: 'r',
    delta: 'Hello.',
  });
  t.mock.timers.tick(16000);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /回应超时/);
});
void test('realtime: failed/incomplete responses fail promptly; cancelled responses leave thinking', (t) => {
  const { inner, errors, states } = controlledVoice(t);
  for (const status of ['failed', 'incomplete']) {
    inner.event({ type: 'response.created', response_id: 'current' });
    inner.event({
      type: 'response.done',
      response_id: 'current',
      response: { status },
    });
  }
  assert.equal(errors.length, 2);
  inner.event({
    type: 'response.done',
    response_id: 'current',
    response: { status: 'cancelled' },
  });
  assert.equal(states.at(-1), 'listening');
});
void test('realtime: a lost transcript cannot disable the next quiet reminder', (t) => {
  const { inner, sent } = controlledVoice(t);
  inner.event({ type: 'input_audio_buffer.speech_started', item_id: 'lost' });
  inner.event({ type: 'input_audio_buffer.speech_stopped', item_id: 'lost' });
  inner.event({ type: 'output_audio_buffer.stopped' });
  t.mock.timers.tick(22000);
  assert.equal(inner.pending.size, 0);
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 1);
});
void test('realtime: late cancellation of an old reply cannot clear the current response timeout', (t) => {
  const { inner, errors } = controlledVoice(t);
  inner.event({ type: 'response.created', response_id: 'new' });
  inner.event({
    type: 'response.done',
    response_id: 'old',
    response: { status: 'cancelled' },
  });
  t.mock.timers.tick(25000);
  assert.equal(errors.length, 1);
});
void test('realtime: copied or supported long sentences do not trigger fluent adaptation', () => {
  const data = freshData(),
    at = new Date().toISOString();
  const text =
    'Although travelling alone can feel intimidating at first, I would still recommend it because you get to make your own decisions and meet people from different backgrounds.';
  const turn = {
    id: 'user',
    sessionId: 'one',
    role: 'user' as const,
    text,
    at,
    source: 'realtime' as const,
    seconds: 10,
    hint: 3,
    played: false,
    assessed: false,
  };
  data.turns = [turn];
  assert.equal(effectiveDifficulty(data).sentenceWords, 7);
  data.turns = [
    { ...turn, id: 'teacher', role: 'assistant', hint: 0, played: true },
    { ...turn, hint: 0, text: 'Well, ' + text },
  ];
  assert.equal(effectiveDifficulty(data).sentenceWords, 7);
});

void test('realtime: pause saves a final transcript arriving during its bounded drain and never continues speaking', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const originals = ['window', 'cancelAnimationFrame'].map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { speechSynthesis: { cancel() {} } },
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    value: () => {},
  });
  t.after(() => {
    for (const [name, value] of originals) {
      if (value) Object.defineProperty(globalThis, name, value);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  const client = new CoachClient(() => {}),
    data = freshData();
  data.activeSessionId = 'session';
  client.snapshot = { revision: 1, epoch: 'one', data };
  const commands: { action: string; body: Record<string, unknown> }[] = [],
    sent: { type: string }[] = [];
  client.load = async () => ({ snapshot: client.snapshot! });
  client.command = async (action, body) => {
    commands.push({ action, body: body ?? {} });
    return { snapshot: client.snapshot! };
  };
  const voice = new VoiceCoach(client, {
    status() {},
    message() {},
    error() {},
  });
  Object.assign(voice, {
    alive: true,
    ownedEpoch: 'one',
    ownedSession: 'session',
    dc: {
      readyState: 'open',
      send(raw: string) {
        sent.push(JSON.parse(raw) as { type: string });
      },
      close() {},
    },
  });
  const inner = voice as unknown as { event(e: RealtimeEvent): void };
  inner.event({ type: 'input_audio_buffer.speech_started', item_id: 'late' });
  inner.event({ type: 'input_audio_buffer.speech_stopped', item_id: 'late' });
  const stopped = voice.stop();
  inner.event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'late',
    transcript: 'Goodbye for now.',
  });
  inner.event({
    type: 'response.done',
    response: {
      status: 'completed',
      output: [
        {
          type: 'function_call',
          name: 'checkpoint',
          call_id: 'too-late',
          arguments: '{}',
        },
      ],
    },
  });
  t.mock.timers.tick(50);
  await stopped;
  assert.equal(
    commands.filter(
      (c) => c.action === 'turn' && c.body.text === 'Goodbye for now.',
    ).length,
    1,
  );
  assert.equal(commands.filter((c) => c.action === 'end').length, 1);
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 0);
});

void test('realtime: cancellation arriving after student speech ends does not swallow the new wait', (t) => {
  const { inner, errors } = controlledVoice(t);
  inner.event({ type: 'response.created', response_id: 'old' });
  inner.event({
    type: 'input_audio_buffer.speech_started',
    item_id: 'learner',
  });
  inner.event({
    type: 'input_audio_buffer.speech_stopped',
    item_id: 'learner',
  });
  inner.event({
    type: 'response.done',
    response_id: 'old',
    response: { status: 'cancelled' },
  });
  t.mock.timers.tick(25000);
  assert.equal(errors.length, 1);
});
void test('realtime: teaching context remains bounded as saved history grows', () => {
  const data = freshData();
  data.facts = Array.from({ length: 500 }, (_, i) => ({
    id: String(i),
    kind: 'interest' as const,
    text: 'x'.repeat(500),
    quote: 'x',
    turnId: 'a',
    at: data.createdAt,
  }));
  data.memories = Array.from({ length: 50 }, (_, i) => ({
    sessionId: String(i),
    text: 'y'.repeat(2000),
    at: data.createdAt,
  }));
  const instructions = realtimeInstructions(data);
  assert.ok(instructions.length < 9000);
  assert.match(instructions, /very next response/);
  assert.match(instructions, /NOT ceilings/);
  assert.equal(data.facts.length, 500);
});
