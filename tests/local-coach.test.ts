import test, { type TestContext } from 'node:test';
import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRepository } from '../local/repository';
import { SettingsStore, defaultSettings } from '../local/settings';
import { CoachService } from '../local/service';
import { runServer } from '../local/server';
import { exportBackup, parseBackup, validateData } from '../lib/coach/backup';
import {
  freshData,
  accomplishments,
  wantsToStop,
  type LearningData,
  type Turn,
} from '../lib/coach/model';
import {
  applyObservation,
  type Proposal,
  realtimeSession,
} from '../lib/coach/teacher';

const now = '2026-09-09T10:00:00.000Z';
function dataWithTurns(): LearningData {
  const data = freshData(now);
  data.sessions = [
    { id: 'session-one', startedAt: now, endedAt: null, summary: '初次问候' },
  ];
  data.activeSessionId = 'session-one';
  data.turns = [
    {
      id: 'student-one',
      sessionId: 'session-one',
      role: 'user',
      text: 'Hello, I like music.',
      at: now,
      source: 'asr',
      seconds: 3,
      hint: 0,
      played: false,
      assessed: false,
    },
  ];
  return data;
}
function observation(): Proposal {
  return {
    speech: 'Nice! What music do you like?',
    helpLevel: 0,
    focus: '聊音乐',
    reason: '学生表达了兴趣',
    summary: '聊了音乐爱好',
    assessment: {
      outcome: 'success',
      phrases: [{ phrase: 'I like music', meaning: '我喜欢音乐' }],
      context: '兴趣',
    },
    facts: [{ kind: 'interest', text: '喜欢音乐', quote: 'I like music' }],
  };
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'milo-test-'));
  const repo = new SqliteRepository(join(directory, 'learning.sqlite'));
  const settings = new SettingsStore(directory);
  const service = new CoachService(repo, settings);
  t.after(() => {
    service.close();
    repo.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, repo, settings, service };
}
function command(
  service: CoachService,
  action: string,
  body: Record<string, unknown> = {},
) {
  const snap = service.repo.read();
  return service.command(action, {
    revision: snap.revision,
    epoch: snap.epoch,
    sessionId: snap.data.activeSessionId,
    commandId: crypto.randomUUID(),
    ...body,
  });
}
function modelResponse(p: Proposal) {
  return new Response(
    JSON.stringify({
      choices: [
        { finish_reason: 'stop', message: { content: JSON.stringify(p) } },
      ],
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

void test('local: complete backup roundtrip retains profile, all turns, evidence, memories, and plan', async () => {
  let data = dataWithTurns();
  data = applyObservation(data, observation(), data.turns[0], now);
  data.turns.push(
    ...Array.from({ length: 260 }, (_, i) => ({
      ...data.turns[0],
      id: 'turn-' + i,
    })),
  );
  const packed = await exportBackup({
    revision: 20,
    epoch: 'old-device',
    data,
  });
  const result = await parseBackup(JSON.stringify(packed));
  assert.deepEqual(result.data, data);
  assert.equal(result.data.turns.length, 261);
  assert.equal(result.data.facts.length, 1);
  assert.equal(result.data.memories.length, 1);
  assert.equal(accomplishments(result.data).phrases[0].stage, '独立说过');
});
void test('local: corruption, future schemas, secret fields and invalid evidence are refused', async () => {
  const data = dataWithTurns();
  const pack = await exportBackup({ revision: 0, epoch: 'test', data });
  await assert.rejects(
    parseBackup(JSON.stringify({ ...pack, checksum: 'corrupt' })),
    /校验/,
  );
  await assert.rejects(
    parseBackup(JSON.stringify({ ...pack, formatVersion: 999 })),
    /版本/,
  );
  await assert.rejects(
    parseBackup(JSON.stringify({ ...pack, password: 'secret' })),
    /密钥/,
  );
  const observed = applyObservation(data, observation(), data.turns[0], now);
  for (const mutate of [
    (d: LearningData) => {
      d.turns[0].role = 'assistant';
    },
    (d: LearningData) => {
      d.turns[0].source = 'legacy-text';
    },
    (d: LearningData) => {
      d.evidence[0].phrase = 'I can fly';
    },
    (d: LearningData) => {
      d.turns[0].hint = 3;
    },
  ]) {
    const changed = structuredClone(observed);
    mutate(changed);
    assert.throws(() => validateData(changed));
  }
});
void test('local: supplied model extras cannot enter the portable schema; assisted and Chinese responses do not become independent speech', () => {
  const data = dataWithTurns();
  data.turns[0].hint = 3;
  const p = observation();
  Object.assign(p.facts[0], { confidence: 1, apiKey: 'fake' });
  const next = applyObservation(data, p, data.turns[0], now);
  assert.doesNotThrow(() => validateData(next));
  assert.equal(next.evidence[0].outcome, 'assisted');
  const chinese: Turn = { ...data.turns[0], text: '我喜欢音乐', hint: 0 };
  const raw = { ...data, turns: [chinese] };
  assert.equal(applyObservation(raw, p, chinese, now).evidence.length, 0);
  assert.equal(
    applyObservation(
      data,
      { ...p, assessment: { ...p.assessment, outcome: 'uncertain' } },
      data.turns[0],
      now,
    ).evidence.length,
    0,
  );
});
void test('local: SQLite persists without account, deduplicates, rejects races and atomically restores import', async (t) => {
  const { repo, service } = fixture(t);
  const first = repo.read();
  const data = dataWithTurns();
  const saved = repo.commit(first, data, 'command-original');
  assert.deepEqual(repo.commit(first, freshData(), 'command-original'), saved);
  assert.throws(
    () => repo.commit(first, freshData(), 'stale-command'),
    /CONFLICT/,
  );
  const pack = await exportBackup({
    revision: 0,
    epoch: 'other',
    data: freshData(),
  });
  const imported = await service.import(
    JSON.stringify(pack),
    saved.revision,
    saved.epoch,
  );
  assert.notEqual(imported.epoch, saved.epoch);
  assert.deepEqual(repo.recovery(), data);
  assert.throws(() => repo.commit(saved, data, 'late-voice-turn'), /CONFLICT/);
  const restored = await service.restore(imported.revision, imported.epoch);
  assert.equal(restored.data.turns[0].text, data.turns[0].text);
  assert.equal(restored.data.activeSessionId, null);
});
void test('local: keys stay only in backend memory, sanitized preferences survive restart, shared OpenAI key rotates', (t) => {
  const { settings, directory } = fixture(t);
  const config = {
    ...defaultSettings,
    evaluator: undefined,
    teacher: {
      provider: 'openai',
      model: 'gpt-5.4-nano',
      baseUrl: 'https://api.openai.com/v1',
      tokenParameter: 'max_completion_tokens',
      apiKey: 'nested-secret',
    },
  };
  const publicState = settings.save({
    ...config,
    teacherKey: 'test-key-first',
  });
  assert.equal(publicState.ready, true);
  assert.equal(settings.openAI().key, 'test-key-first');
  settings.save({ ...config, teacherKey: 'test-key-second' });
  assert.equal(settings.openAI().key, 'test-key-second');
  const file = readFileSync(join(directory, 'preferences.json'), 'utf8');
  assert.ok(!file.includes('secret') && !file.includes('test-key'));
  assert.ok(!JSON.stringify(publicState).includes('test-key'));
  assert.equal(
    statSync(join(directory, 'preferences.json')).mode & 0o777,
    0o600,
  );
  assert.equal(new SettingsStore(directory).public().ready, false);
  settings.save({ ...config, forgetKeys: true });
  assert.equal(settings.public().ready, false);
});
void test('local: checkpoint keeps live intent; hangup analysis observes each target without holding the call', async (t) => {
  const { repo, settings, service } = fixture(t);
  settings.save({
    ...defaultSettings,
    voiceMode: 'realtime',
    teacherKey: 'test-teacher-key',
    voiceKey: 'test-voice-key',
  });
  const data = dataWithTurns();
  data.turns.push({
    ...data.turns[0],
    id: 'student-two',
    text: 'Good morning.',
  });
  repo.commit(repo.read(), data, 'seed-data');
  const targets: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(textBody(options?.body)) as {
      messages: { content: string }[];
    };
    const prompt = body.messages[1].content;
    targets.push(prompt);
    const p = observation();
    if (prompt.includes('student-two')) {
      p.assessment.phrases = [{ phrase: 'Good morning', meaning: '早上好' }];
      p.facts = [];
    }
    return modelResponse(p);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const result = await command(service, 'checkpoint');
  assert.equal(targets.length, 0);
  await command(service, 'end');
  await service.waitForAnalysis();
  assert.equal(targets.length, 2);
  assert.match(targets[0], /student-one/);
  assert.match(targets[1], /student-two/);
  assert.equal(repo.read().data.evidence.length, 2);
  assert.ok(repo.read().data.turns.every((turn) => turn.assessed));
  assert.ok(
    'instructions' in result &&
      String(result.instructions).includes('record_hint'),
  );
});
void test('local: model failure keeps raw speech; retry can recover without duplicate student turn', async (t) => {
  const { repo, settings, service } = fixture(t);
  settings.save({ ...defaultSettings, teacherKey: 'test-teacher-key' });
  repo.commit(repo.read(), dataWithTurns(), 'seed-data');
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 503 });
  t.after(() => {
    globalThis.fetch = original;
  });
  const id = 'retry-command';
  await assert.rejects(
    command(service, 'turn', {
      commandId: id,
      role: 'user',
      source: 'asr',
      text: 'I like music.',
      seconds: 2,
    }),
    /MODEL_FAILED/,
  );
  assert.equal(repo.read().data.turns.length, 2);
  globalThis.fetch = async () => modelResponse(observation());
  await command(service, 'turn', {
    commandId: id,
    role: 'user',
    source: 'asr',
    text: 'I like music.',
    seconds: 2,
  });
  assert.equal(
    repo.read().data.turns.filter((t) => t.role === 'user').length,
    2,
  );
  assert.equal(
    repo.read().data.turns.filter((t) => t.role === 'assistant').length,
    1,
  );
});
void test('local: hint belongs to the speech that started after it, even when transcripts are delayed', async (t) => {
  const { settings, service, repo } = fixture(t);
  settings.save({
    ...defaultSettings,
    voiceMode: 'realtime',
    teacherKey: 'test-teacher-key',
    voiceKey: 'test-voice-key',
  });
  await command(service, 'start');
  await command(service, 'hint', { level: 3 });
  await command(service, 'turn', {
    role: 'user',
    source: 'realtime',
    text: 'Hi.',
    seconds: 2,
    hint: 0,
  });
  await command(service, 'turn', {
    role: 'user',
    source: 'realtime',
    text: 'Hello.',
    seconds: 1,
    hint: 3,
  });
  assert.deepEqual(
    repo.read().data.turns.map((t) => t.hint),
    [0, 3],
  );
});
void test('local: HTTP has no login, denies foreign origins/hosts without private data, exports no key, validates import', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'milo-http-'));
  const server = await runServer({ port: 0, directory: dir });
  t.after(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const address = server.server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { 'X-Milo-Local': '1' };
  for (const bad of [{}, { ...headers, Origin: 'https://malicious.example' }]) {
    const response = await fetch(base + '/api/local/bootstrap', {
      headers: bad,
    });
    assert.equal(response.status, 403);
    assert.ok(
      !('snapshot' in ((await response.json()) as Record<string, unknown>)),
    );
  }
  const forbidden = await new Promise<{
    status: number | undefined;
    body: string;
  }>((resolve, reject) => {
    const req = httpRequest(
      base + '/api/local/bootstrap',
      { headers: { ...headers, Host: 'malicious.example' } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += String(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(forbidden.status, 403);
  assert.ok(!forbidden.body.includes('snapshot'));
  const response = await fetch(base + '/api/local/bootstrap', { headers });
  assert.equal(response.status, 200);
  assert.equal(
    (
      (await response.json()) as {
        snapshot: { data: { schemaVersion: number } };
      }
    ).snapshot.data.schemaVersion,
    4,
  );
  for (const path of [
    '/.private/PROJECT_PLAN.md',
    '/AGENTS.md',
    '/PROJECT_PLAN.md',
    '/%2eprivate%2fPROJECT_PLAN.md',
    '/@fs' + process.cwd() + '/.private/PROJECT_PLAN.md',
    '/.milo-data/learning.sqlite',
    '/releases/anything.zip',
  ]) {
    const denied = await fetch(base + path, {
      headers: { 'X-Milo-Local': '1' },
    });
    assert.equal(denied.status, 404);
    const body = await denied.text();
    assert.ok(!body.includes('snapshot'));
    assert.ok(!body.includes('Milo 项目计划'));
  }
  const settings = await fetch(base + '/api/local/settings', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...defaultSettings, teacherKey: 'test-secret-key' }),
  });
  assert.equal(settings.status, 200);
  assert.ok(!(await settings.text()).includes('test-secret-key'));
  const exported = await fetch(base + '/api/local/export', { headers });
  const text = await exported.text();
  assert.ok(!text.includes('test-secret-key'));
  await parseBackup(text);
  const auth = await fetch(base + '/api/auth/login', { headers });
  assert.equal(auth.status, 404);
  const before = server.service.repo.read();
  const invalid = await fetch(base + '/api/local/import', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      backup: { format: 'invalid' },
      epoch: before.epoch,
      revision: before.revision,
    }),
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(server.service.repo.read(), before);
});
void test('local: legacy imports stay historical, no invented spoken evidence', async () => {
  const old = {
    version: 2,
    profile: { name: 'Student' },
    items: {},
    evidence: [{ source: 'text' }],
  };
  const result = await parseBackup(JSON.stringify({ state: old, revision: 3 }));
  assert.equal(result.legacy, true);
  assert.deepEqual(result.data.legacy?.state, old);
  assert.equal(accomplishments(result.data).turns, 0);
  assert.equal(result.data.evidence.length, 0);
});
void test('local: explicit stop avoids ending when the student asks to continue', () => {
  assert.ok(wantsToStop('Bye!'));
  assert.ok(wantsToStop('休息一下'));
  assert.ok(!wantsToStop("Don't stop, please."));
  assert.ok(!wantsToStop('What does stop mean?'));
  assert.equal(
    realtimeSession(freshData(), 'gpt-realtime-2.1-mini').tools.length,
    3,
  );
});

void test('local: slow older reads cannot replace a newer imported snapshot', async (t) => {
  const { CoachClient } = await import('../lib/coach/client');
  const client = new CoachClient(() => {});
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const resolvers: ((r: Response) => void)[] = [];
  globalThis.fetch = () => new Promise((r) => resolvers.push(r));
  const older = client.load(),
    newer = client.load();
  resolvers[1](
    Response.json({
      snapshot: { revision: 9, epoch: 'imported', data: freshData() },
    }),
  );
  await newer;
  resolvers[0](
    Response.json({
      snapshot: { revision: 8, epoch: 'old-device', data: freshData() },
    }),
  );
  await older;
  assert.equal(client.snapshot?.epoch, 'imported');
  assert.equal(client.snapshot?.revision, 9);
});

void test('local: stopping a stale voice instance never ends a different session', async (t) => {
  const { CoachClient } = await import('../lib/coach/client');
  const { VoiceCoach } = await import('../lib/coach/voice-coach');
  const client = new CoachClient(() => {});
  const data = dataWithTurns();
  const foreign = {
    revision: 20,
    epoch: 'new-epoch',
    data: { ...data, activeSessionId: 'session-new' },
  };
  client.snapshot = foreign;
  const oldFetch = globalThis.fetch;
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldFrame = Object.getOwnPropertyDescriptor(
    globalThis,
    'cancelAnimationFrame',
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
    globalThis.fetch = oldFetch;
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (oldFrame)
      Object.defineProperty(globalThis, 'cancelAnimationFrame', oldFrame);
    else Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
  });
  const requests: string[] = [];
  globalThis.fetch = async (path) => {
    requests.push(requestUrl(path));
    return Response.json({ snapshot: foreign });
  };
  const voice = new VoiceCoach(client, {
    status() {},
    error() {},
    message() {},
  });
  Object.assign(voice, {
    alive: true,
    ownedSession: 'session-one',
    ownedEpoch: 'old-epoch',
  });
  await voice.stop();
  assert.deepEqual(requests, ['/api/local/bootstrap']);
});

void test('local: stopping drains received realtime transcript before closing its own session', async (t) => {
  const { CoachClient } = await import('../lib/coach/client');
  const { VoiceCoach } = await import('../lib/coach/voice-coach');
  const { service, settings } = fixture(t);
  settings.save({
    ...defaultSettings,
    voiceMode: 'realtime',
    teacherKey: 'test-teacher-key',
    voiceKey: 'test-voice-key',
  });
  await command(service, 'start');
  const client = new CoachClient(() => {});
  client.snapshot = service.repo.read();
  const original = globalThis.fetch;
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldFrame = Object.getOwnPropertyDescriptor(
    globalThis,
    'cancelAnimationFrame',
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
    globalThis.fetch = original;
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (oldFrame)
      Object.defineProperty(globalThis, 'cancelAnimationFrame', oldFrame);
    else Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
  });
  globalThis.fetch = async (path, init) => {
    if (requestUrl(path).startsWith('https:'))
      return modelResponse(observation());
    const action = requestUrl(path).split('/').at(-1)!;
    return Response.json(
      action === 'bootstrap'
        ? service.bootstrap()
        : await service.command(
            action,
            JSON.parse(textBody(init?.body)) as Record<string, unknown>,
          ),
    );
  };
  const voice = new VoiceCoach(client, {
    status() {},
    error() {},
    message() {},
  });
  Object.assign(voice, {
    alive: true,
    ownedSession: client.snapshot.data.activeSessionId,
    ownedEpoch: client.snapshot.epoch,
  });
  const event = (
    voice as unknown as { event: (e: unknown) => void }
  ).event.bind(voice);
  event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'input-one',
    transcript: 'I like music.',
  });
  await voice.stop();
  assert.equal(service.repo.read().data.turns.length, 1);
  assert.equal(service.repo.read().data.turns[0].text, 'I like music.');
  assert.equal(service.repo.read().data.activeSessionId, null);
});

function textBody(value: unknown) {
  assert.ok(typeof value === 'string');
  return value;
}
function requestUrl(value: string | URL | Request) {
  return typeof value === 'string'
    ? value
    : value instanceof URL
      ? value.toString()
      : value.url;
}

void test('local: one realtime response with multiple tools creates exactly one continuation', async (t) => {
  const { CoachClient } = await import('../lib/coach/client');
  const { VoiceCoach } = await import('../lib/coach/voice-coach');
  const { service, settings } = fixture(t);
  settings.save({
    ...defaultSettings,
    voiceMode: 'realtime',
    teacherKey: 'test-teacher-key',
    voiceKey: 'test-voice-key',
  });
  await command(service, 'start');
  const client = new CoachClient(() => {});
  client.snapshot = service.repo.read();
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (path, init) =>
    Response.json(
      await service.command(
        requestUrl(path).split('/').at(-1)!,
        JSON.parse(textBody(init?.body)) as Record<string, unknown>,
      ),
    );
  const sent: { type: string }[] = [];
  const errors: string[] = [];
  const voice = new VoiceCoach(client, {
    status() {},
    error(e) {
      errors.push(e);
    },
    message() {},
  });
  Object.assign(voice, {
    alive: true,
    ownedSession: client.snapshot.data.activeSessionId,
    ownedEpoch: client.snapshot.epoch,
    dc: {
      readyState: 'open',
      send(raw: string) {
        sent.push(JSON.parse(raw) as { type: string });
      },
    },
  });
  const inner = voice as unknown as {
    event: (e: unknown) => void;
    toolQueue: Promise<void>;
  };
  inner.event({
    type: 'response.done',
    response: {
      status: 'completed',
      output: [
        {
          type: 'function_call',
          name: 'record_hint',
          call_id: 'call-one',
          arguments: '{"level":3}',
        },
        {
          type: 'function_call',
          name: 'checkpoint',
          call_id: 'call-two',
          arguments: '{}',
        },
      ],
    },
  });
  await inner.toolQueue;
  assert.deepEqual(errors, []);
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 1);
  assert.equal(
    sent.filter((e) => e.type === 'conversation.item.create').length,
    2,
  );
  (voice as unknown as { clearResponseWait(): void }).clearResponseWait();
  Object.assign(voice, { alive: false });
});

void test('local: subtitles translate only the saved teacher speech, reuse one request and never enter audio', async (t) => {
  const { repo, settings, service } = fixture(t);
  settings.save({
    ...defaultSettings,
    voiceMode: 'audio',
    teacherKey: 'test-teacher-key',
    voiceKey: 'test-voice-key',
  });
  const data = dataWithTurns();
  data.turns.push({
    ...data.turns[0],
    id: 'teacher-line',
    role: 'assistant',
    text: 'Hello there. How are you?',
  });
  repo.commit(repo.read(), data, 'subtitle-seed');
  const epoch = repo.read().epoch,
    original = globalThis.fetch;
  let requests = 0;
  const bodies: string[] = [];
  globalThis.fetch = async (_url, options) => {
    requests++;
    const body = textBody(options?.body);
    bodies.push(body);
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify([
              { english: 'Hello there.', chinese: '你好。' },
              { english: 'How are you?', chinese: '你好吗？' },
            ]),
          },
        },
      ],
    });
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const [a, b] = await Promise.all([
    service.subtitles('teacher-line', epoch),
    service.subtitles('teacher-line', epoch),
  ]);
  assert.deepEqual(a, b);
  assert.equal(requests, 1);
  assert.ok(bodies[0].includes('Hello there. How are you?'));
  assert.ok(!bodies[0].includes('test-voice-key'));
  assert.ok(!bodies[0].includes('I like music'));
  await assert.rejects(
    service.subtitles('student-one', epoch),
    /INVALID_ACTION/,
  );
  await assert.rejects(
    service.subtitles('teacher-line', 'stale-epoch'),
    /CONFLICT/,
  );
  const now = repo.read();
  const mixed = structuredClone(now.data);
  mixed.turns.at(-1)!.text = '你好，Hello.';
  repo.commit(now, mixed, 'mixed-voice');
  await assert.rejects(service.speech('teacher-line', epoch), /ENGLISH_ONLY/);
  assert.equal(requests, 1);
});
