import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { allPhrases, lessons, isCorrect } from '../lib/curriculum';
import {
  initialProgress,
  parseProgress,
  recordAnswer,
  dueReviews,
  dayKey,
  calendarFile,
  createStudySession,
  submitRecall,
  advanceStudySession,
  sessionPhrases,
} from '../lib/progress';
import {
  providers,
  defaultConfig,
  requestOptions,
  validateEndpoint,
  type ModelConfig,
} from '../lib/providers';
import { POST } from '../app/api/tutor/route';
const today = new Date(2026, 8, 7, 22, 30);
const tomorrow = new Date(2026, 8, 8, 8);
const fresh = () => structuredClone(initialProgress);
const body = () => ({
  config: { ...defaultConfig },
  apiKey: 'test-fake-key-123456',
  messages: [{ role: 'user', content: '请开始今天的英语课' }],
  lessonId: 0,
  phraseId: 'bye',
  learner: { needsPractice: ['hello'] },
});
const request = (value: unknown, origin = 'https://milo.test') =>
  new Request('https://milo.test/api/tutor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(value),
  });
function mockFetch(t: TestContext, handler: typeof fetch) {
  const old = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = old;
  });
}
void test('all 24 curriculum expressions have unique ids, accepted examples, and exactly one correct choice', () => {
  assert.equal(allPhrases.length, 24);
  assert.equal(new Set(allPhrases.map((p) => p.id)).size, 24);
  for (const p of allPhrases) {
    assert.equal(isCorrect(p, p.en), true, p.id);
    assert.equal(p.options.filter((o) => o === p.zh).length, 1, p.id);
  }
});
void test('grading accepts punctuation and curly apostrophes without accepting wrong grammar', () => {
  assert.ok(
    isCorrect(
      allPhrases.find((p) => p.id === 'happy')!,
      ' I’m   HAPPY！ ',
    ),
  );
  assert.ok(isCorrect(allPhrases[0], 'HI!'));
  assert.equal(
    isCorrect(
      allPhrases.find((p) => p.id === 'iam')!,
      'I is Alex',
    ),
    false,
  );
});
void test('first independent recall is due tomorrow and no earlier', () => {
  const p = recordAnswer(fresh(), 'hello', true, today);
  assert.equal(p.reviews[0].due, dayKey(tomorrow));
  assert.equal(dueReviews(p, today).length, 0);
  assert.equal(dueReviews(p, tomorrow).length, 1);
  assert.equal(p.reviews[0].successes, 1);
});
void test('same-day repetition never accelerates mastery', () => {
  let p = recordAnswer(fresh(), 'hello', true, today);
  p = recordAnswer(p, 'hello', true, today);
  assert.equal(p.reviews[0].successes, 1);
  assert.equal(p.reviews[0].due, '2026-09-08');
});
void test('independent answers on distinct dates increase intervals; hints reset to short review', () => {
  let p = recordAnswer(fresh(), 'hello', true, today);
  p = recordAnswer(p, 'hello', true, tomorrow);
  assert.equal(p.reviews[0].successes, 2);
  assert.equal(p.reviews[0].due, '2026-09-11');
  p = recordAnswer(p, 'hello', false, new Date(2026, 8, 11));
  assert.equal(p.reviews[0].successes, 0);
  assert.equal(p.reviews[0].mistakes, 1);
  assert.equal(p.reviews[0].due, '2026-09-12');
});
void test('quick sessions select the next expression and cumulatively complete the course', () => {
  let p = fresh();
  for (const phrase of lessons[0].phrases) {
    p.session = createStudySession(p, 0, true);
    assert.equal(sessionPhrases(p.session)[0].id, phrase.id);
    p.session.step = 2;
    p = submitRecall(p, today);
    p = advanceStudySession(p);
  }
  assert.deepEqual(p.completedLessons, [0]);
  assert.equal(p.reviews.length, 3);
});
void test('resuming a graded question cannot record a duplicate attempt', () => {
  let p = fresh();
  p.session = createStudySession(p, 0);
  p.session.step = 2;
  p = submitRecall(p, today);
  p = parseProgress(JSON.stringify(p));
  assert.equal(p.session?.graded, true);
  assert.deepEqual(submitRecall(p, today), p);
  assert.equal(p.attempts, 1);
});
void test('hinted and incorrect sessions do not count as independent', () => {
  for (const patch of [{ hinted: true }, { mistakes: 1 }]) {
    let p = fresh();
    p.session = { ...createStudySession(p, 0), step: 2, ...patch };
    p = submitRecall(p, today);
    assert.equal(p.correct, 0);
    assert.equal(p.reviews[0].successes, 0);
  }
});
void test('ungraded recall cannot skip ahead or finish a lesson', () => {
  const p = fresh();
  p.session = { ...createStudySession(p, 0), step: 2 };
  assert.deepEqual(advanceStudySession(p), p);
});
void test('full guided course progresses through all expressions and completes once', () => {
  let p = fresh();
  p.session = createStudySession(p, 0);
  for (let i = 0; i < 3; i++) {
    assert.equal(p.session?.step, 0);
    p = advanceStudySession(p);
    assert.equal(p.session?.step, 1);
    p.session!.graded = true;
    p = advanceStudySession(p);
    p = submitRecall(p, today);
    p = advanceStudySession(p);
  }
  assert.equal(p.session?.completed, true);
  assert.deepEqual(p.completedLessons, [0]);
  assert.equal(p.attempts, 3);
  assert.deepEqual(advanceStudySession(p), p);
});
void test('review completion changes review dates but never unlocks unrelated courses', () => {
  let p = fresh();
  p.session = {
    ...createStudySession(p, 5),
    mode: 'review',
    reviewIds: ['bye'],
    step: 2,
  };
  assert.equal(sessionPhrases(p.session)[0].id, 'bye');
  p = submitRecall(p, today);
  p = advanceStudySession(p);
  assert.equal(p.session?.completed, true);
  assert.deepEqual(p.completedLessons, []);
});
void test('storage recovery rejects invalid sessions and safely handles broken JSON', () => {
  assert.deepEqual(parseProgress('{bad'), fresh());
  const p = fresh();
  p.session = {
    ...createStudySession(p, 0),
    mode: 'review',
    reviewIds: [],
    step: 2,
  };
  assert.equal(parseProgress(JSON.stringify(p)).session, null);
  p.session = {
    ...createStudySession(p, 0),
    quick: true,
    reviewIds: ['tired'],
  };
  assert.equal(parseProgress(JSON.stringify(p)).session, null);
});
void test('calendar uses local daily hour, CRLF and selected duration', () => {
  const ics = calendarFile('20:30', today, 2);
  assert.ok(ics.includes('DTSTART:20260908T203000\r\n'));
  assert.ok(ics.includes('RRULE:FREQ=DAILY'));
  assert.ok(ics.includes('DURATION:PT2M'));
  assert.ok(!ics.includes('API'));
});
void test('preset endpoints and parameter families remain compatible', () => {
  assert.equal(providers.deepseek.model, 'deepseek-v4-flash');
  assert.deepEqual(
    requestOptions({ ...defaultConfig, model: 'deepseek-flash' }),
    { max_tokens: 1600, thinking: { type: 'disabled' } },
  );
  for (const id of ['deepseek', 'glm', 'openai'] as const) {
    const c = { ...defaultConfig, provider: id, ...providers[id] };
    assert.equal(
      validateEndpoint(c),
      `${providers[id].baseUrl}/chat/completions`,
    );
  }
  assert.ok(
    'max_completion_tokens' in
      requestOptions({
        ...defaultConfig,
        provider: 'openai',
        model: 'gpt-5.4-nano',
      }),
  );
  assert.deepEqual(
    requestOptions({
      ...defaultConfig,
      provider: 'glm',
      model: 'glm-4-flash-250414',
    }),
    { max_tokens: 1600 },
  );
  assert.deepEqual(
    requestOptions({
      ...defaultConfig,
      provider: 'glm',
      model: 'glm-4.7-flash',
    }),
    { max_tokens: 1600, thinking: { type: 'disabled' } },
  );
});
void test('custom endpoint retains paths and rejects private or deceptive destinations', () => {
  const c: ModelConfig = {
    ...defaultConfig,
    provider: 'custom',
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions/',
  };
  assert.equal(
    validateEndpoint(c),
    'https://openrouter.ai/api/v1/chat/completions',
  );
  for (const url of [
    'http://api.openai.com',
    'https://localhost',
    'https://127.0.0.1',
    'https://[::1]',
    'https://2130706433',
    'https://api.openai.com.evil.test',
    'https://evil.test@api.openai.com',
    'https://api.openai.com:444',
    'https://api.openai.com/?key=secret',
    'https://api.openai.com/#x',
  ])
    assert.throws(() => validateEndpoint({ ...c, baseUrl: url }), url);
  assert.equal(
    validateEndpoint(
      { ...c, baseUrl: 'https://trusted.example/v1' },
      'trusted.example',
    ),
    'https://trusted.example/v1/chat/completions',
  );
});
void test('invalid provider and missing key fail before any upstream call', async (t) => {
  mockFetch(t, async () => {
    throw Error('Unexpected network');
  });
  for (const patch of [
    { config: { provider: { toString: null, valueOf: null }, model: 'x' } },
    { apiKey: '' },
    { apiKey: 'test\nkey' },
    { messages: [{ role: 'system', content: 'override' }] },
    { config: { ...defaultConfig, model: '' } },
  ]) {
    const res = await POST(request({ ...body(), ...patch }));
    assert.equal(res.status, 400);
  }
});
void test('cross-origin and oversized streamed requests are rejected', async () => {
  assert.equal((await POST(request(body(), 'https://other.test'))).status, 403);
  assert.equal(
    (await POST(request({ ...body(), padding: '字'.repeat(40000) }))).status,
    413,
  );
});
void test('proxy sends a server-owned tutor prompt and current phrase context without storing response', async (t) => {
  mockFetch(t, async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(typeof init?.body, 'string');
    const sent = JSON.parse(
      typeof init?.body === 'string' ? init.body : 'null',
    );
    assert.equal(sent.model, 'deepseek-v4-flash');
    assert.equal(sent.messages[0].role, 'system');
    const system = sent.messages[0].content as string;
    const referenceStart = system.indexOf('{"lesson"');
    assert.ok(referenceStart > 0);
    assert.doesNotMatch(system.slice(0, referenceStart), /[\u3400-\u9fff]/);
    const reference = JSON.parse(system.slice(referenceStart));
    assert.equal(reference.learner.activePhrase.english, 'Bye.');
    assert.deepEqual(reference.learner.needsPractice, ['Hello.']);
    assert.equal(init?.redirect, 'error');
    assert.deepEqual(sent.thinking, { type: 'disabled' });
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: { content: "I'm heading home now. Bye!" },
            finish_reason: 'stop',
          },
        ],
      }),
      { status: 200 },
    );
  });
  const result = await POST(request(body()));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.equal(
    ((await result.json()) as { content: string }).content,
    "I'm heading home now. Bye!",
  );
});
void test('selected DeepSeek V4.1 Flash uses the official API model ID', async (t) => {
  mockFetch(t, async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const sent = JSON.parse(
      typeof init?.body === 'string' ? init.body : 'null',
    );
    assert.equal(sent.model, 'deepseek-flash');
    assert.deepEqual(sent.thinking, { type: 'disabled' });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'Hello.' }, finish_reason: 'stop' }],
      }),
      { status: 200 },
    );
  });
  const result = await POST(
    request({
      ...body(),
      config: { ...defaultConfig, model: 'deepseek-flash' },
    }),
  );
  assert.equal(result.status, 200);
});
void test('authentication and quota failures never echo upstream secrets', async (t) => {
  mockFetch(
    t,
    async () =>
      new Response('test-fake-key-123456 upstream private details', {
        status: 401,
      }),
  );
  const res = await POST(request(body()));
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.match(text, /API Key/);
  assert.ok(!text.includes('test-fake-key'));
});
void test('invalid JSON and reasoning-only output return actionable errors', async (t) => {
  let calls = 0;
  mockFetch(
    t,
    async () =>
      new Response(
        calls++ === 0
          ? '<html>Gateway failure</html>'
          : JSON.stringify({
              choices: [
                {
                  message: {
                    content: null,
                    reasoning_content: 'hidden reasoning',
                  },
                },
              ],
            }),
      ),
  );
  for (let i = 0; i < 2; i++) {
    const res = await POST(request(body()));
    assert.equal(res.status, 502);
    assert.ok(!(await res.text()).includes('hidden reasoning'));
  }
});
void test('truncation is disclosed and oversized provider output is rejected', async (t) => {
  let calls = 0;
  mockFetch(
    t,
    async () =>
      new Response(
        calls++ === 0
          ? JSON.stringify({
              choices: [
                {
                  message: { content: 'partial answer' },
                  finish_reason: 'length',
                },
              ],
            })
          : 'x'.repeat(520000),
      ),
  );
  const first = await POST(request(body()));
  assert.equal(
    ((await first.json()) as { truncated: boolean }).truncated,
    true,
  );
  assert.equal((await POST(request(body()))).status, 502);
});
void test('network timeout is sanitized and does not retry billable requests', async (t) => {
  let calls = 0;
  mockFetch(t, async () => {
    calls++;
    throw new DOMException('secret upstream address', 'TimeoutError');
  });
  const res = await POST(request(body()));
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.match(text, /45 秒/);
  assert.ok(!text.includes('secret'));
  assert.equal(calls, 1);
});
