import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore, defaultSettings } from '../local/settings';
import { SqliteRepository } from '../local/repository';
import { CoachService } from '../local/service';
import { CoachClient } from '../lib/coach/client';
import {
  freshData,
  upgradeData,
  type LearningData,
  type Snapshot,
  type Turn,
} from '../lib/coach/model';
import { applyObservation, propose, type Proposal } from '../lib/coach/teacher';
import {
  initialDifficulty,
  advanceDifficulty,
  skillProgress,
  requestedChallenge,
  effectiveDifficulty,
} from '../lib/coach/learning-engine';
import { exportBackup, parseBackup, validateData } from '../lib/coach/backup';
import {
  providers,
  requestOptions,
  validateEndpoint,
  type ModelConfig,
} from '../lib/providers';
const at = '2026-09-01T10:00:00.000Z';
const model = (provider: ModelConfig['provider']): ModelConfig => ({
  provider,
  model: providers[provider].model,
  baseUrl: providers[provider].baseUrl,
  tokenParameter: 'max_tokens',
});
function rawData() {
  const d = freshData(at);
  d.sessions = [{ id: 's-one', startedAt: at, endedAt: null, summary: '' }];
  d.activeSessionId = 's-one';
  d.turns = [
    {
      id: 't-one',
      sessionId: 's-one',
      at,
      role: 'user',
      text: 'I like music.',
      source: 'realtime',
      seconds: 3,
      hint: 0,
      played: false,
      assessed: false,
    },
  ];
  return d;
}
function proposal(): Proposal {
  return {
    speech: 'What music do you like?',
    helpLevel: 0,
    focus: '聊爱好',
    reason: '从学生的兴趣接着聊',
    summary: '学生表达了音乐爱好',
    assessment: {
      outcome: 'success',
      phrases: [{ phrase: 'I like music', meaning: '喜欢音乐' }],
      context: 'interests',
      comprehension: 'clear',
    },
    facts: [],
  };
}
function response(p = proposal()) {
  return new Response(
    JSON.stringify({
      choices: [
        { finish_reason: 'stop', message: { content: JSON.stringify(p) } },
      ],
    }),
  );
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'milo-analysis-'));
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
  const p = service.repo.read();
  return service.command(action, {
    commandId: crypto.randomUUID(),
    revision: p.revision,
    epoch: p.epoch,
    sessionId: p.data.activeSessionId,
    ...body,
  });
}
function textBody(value: unknown): string {
  assert.equal(typeof value, 'string');
  return value as string;
}
function mock(t: TestContext, fetcher: typeof fetch) {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  t.after(() => {
    globalThis.fetch = original;
  });
}
void test('analysis: live and analysis requests use independent providers and keys, and live never claims achievements', async (t) => {
  const { repo, settings, service, directory } = fixture(t);
  settings.save({
    ...defaultSettings,
    teacher: model('deepseek'),
    evaluator: model('glm'),
    teacherKey: 'live-only-secret',
    evaluatorKey: 'analysis-only-secret',
  });
  repo.commit(repo.read(), rawData(), 'seed-data');
  const calls: { url: string; authorization: string; body: string }[] = [];
  mock(t, async (url, options) => {
    calls.push({
      url:
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      authorization: new Headers(options?.headers).get('Authorization') ?? '',
      body: textBody(options?.body),
    });
    return response();
  });
  await command(service, 'turn', {
    role: 'user',
    text: 'I like music.',
    source: 'browser-speech',
    seconds: 3,
  });
  await service.waitForLiveChecks();
  const liveCalls = calls.filter((c) => c.url.includes('deepseek'));
  const liveChecks = calls.filter((c) =>
    c.body.includes('Silent live English usage check'),
  );
  assert.equal(liveCalls.length, 1);
  assert.equal(liveCalls[0].authorization, 'Bearer live-only-secret');
  assert.equal(liveChecks.length, 1);
  assert.match(liveChecks[0].url, /bigmodel/);
  assert.equal(liveChecks[0].authorization, 'Bearer analysis-only-secret');
  assert.equal(repo.read().data.evidence.length, 0);
  assert.equal(repo.read().data.facts.length, 0);
  await command(service, 'end');
  await service.waitForAnalysis();
  assert.equal(repo.read().data.analyses[0].status, 'complete');
  assert.equal(calls.filter((c) => c.url.includes('deepseek')).length, 1);
  assert.equal(calls.filter((c) => c.url.includes('bigmodel')).length, 3);
  assert.ok(
    calls.every((c) =>
      c.url.includes('deepseek')
        ? c.authorization === 'Bearer live-only-secret'
        : c.url.includes('bigmodel') &&
          c.authorization === 'Bearer analysis-only-secret',
    ),
  );
  assert.ok(calls.every((c) => !`${c.url}${c.body}`.includes('-only-secret')));
  assert.ok(!JSON.stringify(repo.read().data).includes('-only-secret'));
  assert.ok(
    !readFileSync(join(directory, 'preferences.json'), 'utf8').includes(
      'secret',
    ),
  );
  settings.save({
    ...defaultSettings,
    teacher: model('openai'),
    evaluator: model('deepseek'),
  });
  assert.equal(settings.public().evaluatorKeyConfigured, false);
  assert.equal(settings.public().teacherKeyConfigured, false);
});
void test('analysis: slow evaluator does not block hangup or a new call and merges into the original session', async (t) => {
  const { repo, settings, service } = fixture(t);
  settings.save({
    ...defaultSettings,
    voiceMode: 'realtime',
    voiceKey: 'voice-secret',
    evaluatorKey: 'analysis-secret',
  });
  repo.commit(repo.read(), rawData(), 'seed-data');
  const started = deferred<void>(),
    finish = deferred<Response>();
  mock(t, async () => {
    started.resolve();
    return finish.promise;
  });
  const ended = await command(service, 'end');
  assert.equal(ended.snapshot.data.activeSessionId, null);
  await started.promise;
  await command(service, 'start');
  const nextId = repo.read().data.activeSessionId!;
  await command(service, 'checkpoint', {
    focus: '新对话的带法',
    reason: '从今天开始',
  });
  await command(service, 'turn', {
    role: 'user',
    text: 'Good morning.',
    source: 'realtime',
    hint: 0,
  });
  finish.resolve(response());
  await service.waitForAnalysis();
  const d = repo.read().data;
  assert.equal(d.activeSessionId, nextId);
  assert.equal(d.sessions.find((s) => s.id === nextId)?.summary, '');
  assert.equal(d.sessions[0].summary, '学生表达了音乐爱好');
  assert.equal(d.plan.focus, '新对话的带法');
  assert.equal(d.turns.at(-1)?.assessed, false);
  assert.equal(d.analyses[0].status, 'complete');
  assert.doesNotThrow(() => validateData(d));
});
void test('analysis: errors persist a cursor, explicit retry resumes once without re-counting successful turns', async (t) => {
  const { repo, settings, service } = fixture(t);
  settings.save({ ...defaultSettings, evaluatorKey: 'analysis-secret' });
  const d = rawData();
  d.turns.push({ ...d.turns[0], id: 't-two' });
  repo.commit(repo.read(), d, 'seed-data');
  let calls = 0;
  mock(t, async () =>
    ++calls === 2
      ? new Response('provider secret', { status: 503 })
      : response(),
  );
  await command(service, 'end');
  await service.waitForAnalysis();
  assert.equal(repo.read().data.analyses[0].cursor, 1);
  assert.equal(repo.read().data.analyses[0].status, 'failed');
  assert.equal(repo.read().data.analyses[0].error, 'MODEL_FAILED');
  service.resumeAnalysis();
  await service.waitForAnalysis();
  assert.equal(calls, 2);
  await command(service, 'analysis/retry');
  await service.waitForAnalysis();
  assert.equal(calls, 3);
  assert.equal(repo.read().data.evidence.length, 2);
  assert.equal(repo.read().data.analyses[0].status, 'complete');
  assert.ok(
    !JSON.stringify(await service.export()).includes('provider secret'),
  );
});
void test('analysis: process restart recovers unfinished jobs, waits for keys, and keeps completed cursors', async (t) => {
  const { directory, repo, service } = fixture(t);
  const d = rawData();
  d.turns.push({ ...d.turns[0], id: 't-two' });
  const observed = applyObservation(d, proposal(), d.turns[0], at);
  observed.activeSessionId = null;
  observed.sessions[0].endedAt = at;
  observed.analyses = [
    {
      id: 'j-one',
      sessionId: 's-one',
      turnIds: ['t-one', 't-two'],
      cursor: 1,
      status: 'running',
      attempts: 1,
      error: null,
      updatedAt: at,
    },
  ];
  repo.commit(repo.read(), observed, 'seed-data');
  service.close();
  const settings = new SettingsStore(directory);
  const resumed = new CoachService(repo, settings);
  t.after(() => resumed.close());
  let calls = 0;
  mock(t, async () => {
    calls++;
    return response();
  });
  resumed.resumeAnalysis();
  await resumed.waitForAnalysis();
  assert.equal(calls, 0);
  assert.equal(repo.read().data.analyses[0].status, 'waiting');
  settings.save({ ...defaultSettings, evaluatorKey: 'analysis-secret' });
  resumed.resumeAnalysis();
  await resumed.waitForAnalysis();
  assert.equal(calls, 1);
  assert.equal(repo.read().data.evidence.length, 2);
  assert.equal(repo.read().data.analyses[0].status, 'complete');
});
void test('analysis: importing while an old evaluator is in flight prevents late evidence from leaking into the new data', async (t) => {
  const { repo, settings, service } = fixture(t);
  settings.save({ ...defaultSettings, evaluatorKey: 'analysis-secret' });
  repo.commit(repo.read(), rawData(), 'seed-data');
  const started = deferred<void>(),
    finish = deferred<Response>();
  mock(t, async () => {
    started.resolve();
    return finish.promise;
  });
  await command(service, 'end');
  await started.promise;
  const pack = await exportBackup({
    revision: 0,
    epoch: 'other',
    data: freshData(),
  });
  const p = repo.read();
  const imported = await service.import(
    JSON.stringify(pack),
    p.revision,
    p.epoch,
  );
  finish.resolve(response());
  await service.waitForAnalysis();
  assert.equal(repo.read().epoch, imported.epoch);
  assert.equal(repo.read().data.turns.length, 0);
  assert.equal(repo.read().data.evidence.length, 0);
});
void test('analysis: target context includes the original question and excludes later same-time turns', async (t) => {
  const d = rawData();
  d.turns.unshift({
    ...d.turns[0],
    id: 'teacher-original',
    role: 'assistant',
    text: 'Which music do you enjoy?',
    played: true,
  });
  d.turns.push({
    ...d.turns[1],
    id: 'later-student',
    text: 'FUTURE_CONTEXT_SHOULD_NOT_APPEAR',
  });
  let prompt = '';
  mock(t, async (_url, options) => {
    prompt = textBody(options?.body);
    return response();
  });
  await propose(
    d,
    model('deepseek'),
    'analysis-secret',
    'checkpoint',
    d.turns[1],
  );
  assert.match(prompt, /Which music/);
  assert.ok(!prompt.includes('FUTURE_CONTEXT_SHOULD_NOT_APPEAR'));
});
void test('client: background revisions get one same-session retry; migration and different sessions do not', async (t) => {
  const client = new CoachClient(() => {});
  const snapshot: Snapshot = {
    revision: 1,
    epoch: 'epoch-one',
    data: rawData(),
  };
  client.snapshot = snapshot;
  const bodies: Record<string, unknown>[] = [];
  mock(t, async (_url, options) => {
    bodies.push(JSON.parse(textBody(options?.body)));
    return bodies.length === 1
      ? Response.json(
          {
            code: 'CONFLICT',
            error: 'updated',
            snapshot: { ...snapshot, revision: 2 },
          },
          { status: 409 },
        )
      : Response.json({ snapshot: { ...snapshot, revision: 3 } });
  });
  await client.command('hint', { level: 1 });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].commandId, bodies[1].commandId);
  assert.equal(bodies[1].revision, 2);
  let rejectedCalls = 0;
  globalThis.fetch = async () => {
    rejectedCalls++;
    return Response.json(
      {
        code: 'CONFLICT',
        error: 'imported',
        snapshot: { ...snapshot, revision: 4, epoch: 'epoch-two' },
      },
      { status: 409 },
    );
  };
  await assert.rejects(client.command('hint', { level: 1 }));
  assert.equal(rejectedCalls, 1);
});
function variedData() {
  const d = freshData('2026-08-31T00:00:00.000Z');
  d.sessions = [
    { id: 's-one', startedAt: at, endedAt: at, summary: '' },
    {
      id: 's-two',
      startedAt: '2026-09-02T10:00:00.000Z',
      endedAt: '2026-09-02T11:00:00.000Z',
      summary: '',
    },
  ];
  for (let i = 0; i < 6; i++) {
    const text = ['I like music', 'I enjoy coffee', 'I love reading'][i % 3];
    const date = `2026-09-0${i < 3 ? 1 : 2}T10:0${i}:00.000Z`;
    d.turns.push({
      id: 't-' + i,
      sessionId: i < 3 ? 's-one' : 's-two',
      role: 'user',
      text,
      at: date,
      source: 'realtime',
      seconds: 3,
      hint: 0,
      played: false,
      assessed: true,
      observation: {
        outcome: 'success',
        context: 'interests',
        comprehension: 'clear',
      },
    });
    d.evidence.push({
      id: 'e-' + i,
      turnId: 't-' + i,
      phrase: text,
      meaning: '表达爱好',
      context: 'interests',
      outcome: 'independent',
      at: date,
    });
  }
  return d;
}
void test('learning: only repeated varied independent evidence across days adds one small challenge', () => {
  const d = variedData();
  const next = advanceDifficulty(d, '2026-09-09T00:00:00.000Z');
  assert.equal(next.steps, 1);
  assert.equal(next.sentenceWords, 9);
  assert.equal(next.grammar, 0);
  d.plan.difficulty = next;
  assert.deepEqual(advanceDifficulty(d, '2026-09-10T00:00:00.000Z'), next);
  for (const mutate of [
    (d: LearningData) => {
      d.evidence = [];
      d.turns.forEach((t) => (t.text = '我不知道'));
    },
    (d: LearningData) => d.turns.forEach((t) => (t.hint = 3)),
    (d: LearningData) =>
      d.turns.forEach((t) => (t.observation!.comprehension = 'uncertain')),
    (d: LearningData) => d.turns.forEach((t) => (t.text = 'yes')),
    (d: LearningData) => d.evidence.forEach((e) => (e.outcome = 'exposed')),
  ]) {
    const changed = variedData();
    mutate(changed);
    assert.equal(
      advanceDifficulty(changed, '2026-09-09T00:00:00.000Z').steps,
      0,
    );
  }
});
void test('learning: seeing a demonstration never postpones independent retrieval or grants mastery', () => {
  const d = variedData();
  d.evidence = [d.evidence[0]];
  const before = skillProgress(d, '2026-09-09T10:00:00.000Z')[0];
  assert.equal(before.due, true);
  d.evidence.push({
    ...d.evidence[0],
    id: 'exposure-one',
    turnId: 'teacher-one',
    outcome: 'exposed',
    at: '2026-09-09T10:00:00.000Z',
  });
  const after = skillProgress(d, '2026-09-09T10:00:00.000Z')[0];
  assert.equal(after.dueAt, before.dueAt);
  assert.equal(after.stage, '独立说过');
});
void test('learning: difficulty feedback is temporary and ignores negatives and quoted questions', () => {
  assert.equal(requestedChallenge('This is too easy.'), 'harder');
  assert.equal(requestedChallenge('Please slow down.'), 'slower');
  for (const phrase of [
    "Don't make it harder.",
    'What does too easy mean?',
    '不是太难',
    'He said “too easy”.',
  ])
    assert.equal(requestedChallenge(phrase), null);
  const d = rawData();
  d.sessions[0].challenge = 'harder';
  assert.equal(effectiveDifficulty(d).answerWords, 5);
  assert.equal(d.plan.difficulty.answerWords, 3);
  d.activeSessionId = null;
  assert.equal(effectiveDifficulty(d).answerWords, 3);
});
void test('learning: heard phrases require played teacher speech and echoing remains assisted', () => {
  const d = rawData();
  const teacher: Turn = {
    ...d.turns[0],
    id: 'teacher-one',
    role: 'assistant',
    text: 'Say: I like music.',
    played: true,
  };
  d.turns.unshift(teacher);
  const p = proposal();
  p.assessment.presented = [
    { phrase: 'I like music', meaning: '喜欢音乐' },
    { phrase: 'I can fly', meaning: '捏造' },
  ];
  const next = applyObservation(d, p, d.turns[1], at);
  assert.equal(next.evidence.length, 2);
  assert.equal(next.evidence[0].outcome, 'exposed');
  assert.equal(next.evidence[1].outcome, 'assisted');
  assert.doesNotThrow(() => validateData(next));
  const invalid = structuredClone(next);
  invalid.turns[0].played = false;
  assert.throws(() => validateData(invalid));
});
void test('migration: schema 3 preserves raw records with conservative defaults; new fields reject forged evidence and keys', async () => {
  const d = rawData();
  const old = JSON.parse(JSON.stringify(d));
  old.schemaVersion = 3;
  delete old.analyses;
  delete old.plan.difficulty;
  const bytes = new TextEncoder().encode(JSON.stringify(old));
  const checksum = Buffer.from(
    await crypto.subtle.digest('SHA-256', bytes),
  ).toString('hex');
  const parsed = await parseBackup(
    JSON.stringify({
      format: 'milo-learning-backup',
      formatVersion: 1,
      dataSchemaVersion: 3,
      exportedAt: at,
      checksum,
      data: old,
    }),
  );
  assert.deepEqual(parsed.data.turns, d.turns);
  assert.deepEqual(parsed.data.plan.difficulty, initialDifficulty(at));
  assert.deepEqual(parsed.data.analyses, []);
  assert.deepEqual(upgradeData(old), parsed.data);
  for (const name of [
    'teacherKey',
    'voice_key',
    'analysisKey',
    'evaluatorKey',
    'realtime_key',
  ])
    await assert.rejects(
      parseBackup(
        JSON.stringify({
          version: 2,
          profile: {},
          items: {},
          evidence: [],
          [name]: 'private-secret',
        }),
      ),
      /密钥/,
    );
  const bad = rawData();
  bad.plan.difficulty.evidenceTurnIds = ['no-such-turn'];
  assert.throws(() => validateData(bad));
  const observed = applyObservation(d, proposal(), d.turns[0], at);
  observed.evidence.push({ ...observed.evidence[0], id: 'duplicate-other-id' });
  assert.throws(() => validateData(observed), /重复/);
});
void test('providers: new text adapters retain HTTPS restrictions and separate reasoning content', () => {
  assert.match(validateEndpoint(model('qwen')), /dashscope/);
  assert.match(
    validateEndpoint(model('minimax')),
    /api.minimax.io\/v1\/chat\/completions/,
  );
  const qwen = {
    ...model('qwen'),
    baseUrl:
      'https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  };
  assert.match(validateEndpoint(qwen), /workspace-123/);
  assert.throws(() =>
    validateEndpoint({
      ...qwen,
      baseUrl:
        'https://workspace-123.cn-beijing.maas.aliyuncs.com.evil.example/v1',
    }),
  );
  const options = requestOptions(model('minimax'));
  assert.ok('reasoning_split' in options && options.reasoning_split === true);
});
void test('learning: punctuation variants and Chinese phrases cannot create an unexportable observation', () => {
  const d = rawData();
  d.turns[0].text = 'I like music. 我喜欢音乐。';
  const p = proposal();
  p.assessment.phrases = [
    { phrase: 'I like music', meaning: '音乐' },
    { phrase: 'I like music.', meaning: '重复' },
    { phrase: '我喜欢音乐', meaning: '中文' },
  ];
  const next = applyObservation(d, p, d.turns[0], at);
  assert.equal(next.evidence.length, 1);
  assert.doesNotThrow(() => validateData(next));
});
void test('learning: late analysis of older difficult sessions can lower the current trial difficulty', () => {
  const d = variedData();
  d.plan.difficulty = advanceDifficulty(d, '2026-09-09T10:00:00.000Z');
  assert.equal(d.plan.difficulty.sentenceWords, 9);
  for (let i = 0; i < 6; i++)
    d.turns.push({
      ...d.turns[i],
      id: 'late-' + i,
      at: '2026-09-01T09:00:00.000Z',
      hint: 2,
      observation: {
        outcome: 'needs_support',
        comprehension: 'needs_support',
        context: 'daily',
        observedAt: '2026-09-10T00:00:00.000Z',
      },
    });
  const next = advanceDifficulty(d, '2026-09-10T00:00:00.000Z');
  assert.equal(next.sentenceWords, 7);
  assert.ok(next.evidenceTurnIds.every((id) => id.startsWith('late-')));
});
void test('learning: a filler word cannot turn immediate imitation into independent speech', () => {
  const d = rawData();
  d.turns[0].text = 'Oh, I like music.';
  d.turns.unshift({
    ...d.turns[0],
    id: 'teacher-example',
    role: 'assistant',
    text: 'Try saying: I like music.',
    played: true,
  });
  const p = proposal();
  assert.equal(
    applyObservation(d, p, d.turns[1], at).evidence[0].outcome,
    'assisted',
  );
  p.helpLevel = 3;
  d.turns.shift();
  assert.equal(
    applyObservation(d, p, d.turns[0], at).evidence[0].outcome,
    'assisted',
  );
});
void test('analysis: delayed student transcripts retain spoken order and are not mistaken for repeating the subsequent teacher reply', async (t) => {
  const { repo, settings, service } = fixture(t);
  settings.save({
    ...defaultSettings,
    voiceMode: 'realtime',
    voiceKey: 'voice-secret',
    evaluatorKey: 'analysis-secret',
  });
  const d = rawData();
  d.turns = [
    {
      ...d.turns[0],
      id: 'original-question',
      role: 'assistant',
      text: 'What do you like?',
      played: true,
    },
  ];
  repo.commit(repo.read(), d, 'seed-data');
  mock(t, async () => response());
  await command(service, 'turn', {
    role: 'assistant',
    text: 'I like music too!',
    source: 'realtime',
    occurredAt: '2026-09-01T10:00:10.000Z',
  });
  const teacherId = repo.read().data.turns.at(-1)!.id;
  await command(service, 'played', { turnId: teacherId });
  await command(service, 'turn', {
    role: 'user',
    text: 'I like music.',
    source: 'realtime',
    hint: 0,
    occurredAt: '2026-09-01T10:00:05.000Z',
  });
  await command(service, 'end');
  await service.waitForAnalysis();
  const result = repo.read().data;
  assert.deepEqual(
    result.turns.map((t) => t.role),
    ['assistant', 'user', 'assistant'],
  );
  assert.equal(result.evidence[0].outcome, 'independent');
  assert.doesNotThrow(() => validateData(result));
});
