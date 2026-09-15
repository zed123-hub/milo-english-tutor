import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { env } from './cloudflare-env';
import { GET, POST } from '../app/api/study/route';
import { POST as realtimePOST } from '../app/api/realtime/route';
import { currentTask } from '../lib/tutor/domain';
import type { Snapshot } from '../lib/tutor/storage';

const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("test"); } };',
  d1Databases: ['DB'],
  compatibilityDate: '2026-05-15',
});
before(async () => {
  const db = await mf.getD1Database('DB');
  env.DB = db;
  const sql = await readFile('drizzle/0000_broad_yellowjacket.sql', 'utf8');
  for (const statement of sql.split('--> statement-breakpoint'))
    if (statement.trim()) await db.prepare(statement).run();
});
after(async () => {
  await mf.dispose();
});
function request(body?: unknown, user = 'learner-a') {
  return new Request('https://milo.test/api/study', {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'oai-authenticated-user-id': user,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function load(user = 'learner-a') {
  return (await (await GET(request(undefined, user))).json()) as Snapshot;
}
async function act(
  snapshot: Snapshot,
  action: string,
  data: Record<string, unknown> = {},
  user = 'learner-a',
) {
  const session = snapshot.state.session;
  const body = {
    eventId: crypto.randomUUID(),
    revision: snapshot.revision,
    action,
    sessionId: session?.id,
    taskId: session ? currentTask(snapshot.state).id : undefined,
    taskIndex: session?.index,
    attempt: session?.retries,
    ...data,
  };
  const response = await POST(request(body, user));
  return { response, body, data: (await response.json()) as Snapshot };
}
void test('API stores a complete diagnosis in D1, isolates users and resumes after reload', async () => {
  let state = await load();
  let result = await act(state, 'profile', {
    profile: { ...state.state.profile, name: 'Alex' },
  });
  assert.equal(result.response.status, 200);
  state = result.data;
  result = await act(state, 'start');
  assert.equal(result.response.status, 200);
  state = result.data;
  const first = await act(state, 'submit', {
    transcript: 'My name is Alex.',
    inputMode: 'typed',
  });
  assert.equal(first.response.status, 200);
  state = first.data;
  const duplicate = await POST(request(first.body));
  assert.equal(duplicate.status, 200);
  assert.equal(((await duplicate.json()) as Snapshot).revision, state.revision);
  const conflict = await act({ ...state, revision: 0 }, 'continue');
  assert.equal(conflict.response.status, 409);
  state = (await act(state, 'continue')).data;
  assert.equal(currentTask(state.state).id, 'listen-routine');
  const stale = await act(state, 'played', { taskId: 'intro', taskIndex: 0 });
  assert.equal(stale.response.status, 400);
  state = (await act(state, 'played')).data;
  state = (
    await act(state, 'submit', { transcript: '早晨', inputMode: 'typed' })
  ).data;
  assert.equal(state.state.items.usually.stage, 'UNDERSTAND');
  state = (await act(state, 'continue')).data;
  state = (await act(state, 'hint', { level: 3 })).data;
  state = (await act(state, 'hint', { level: 1 })).data;
  assert.equal(state.state.session?.hintLevel, 3);
  state = (
    await act(state, 'submit', {
      transcript: 'Can I have a coffee, please?',
      inputMode: 'browser-speech',
    })
  ).data;
  state = (await act(state, 'continue')).data;
  assert.equal(state.state.diagnosticCompleted, true);
  assert.equal(state.state.session?.status, 'complete');
  assert.equal(state.state.items['can-i-have'].stage, 'GUIDED_USE');
  assert.deepEqual(await load(), state);
  assert.equal((await load('learner-b')).state.configured, false);
  const realtime = await realtimePOST(
    request({
      apiKey: 'test-only-key',
      sdp: 'v=0',
      sessionId: state.state.session?.id,
    }),
  );
  assert.equal(realtime.status, 400);
});
void test('competing mutations commit exactly once and responses do not overwrite another learner', async () => {
  const state = await load('learner-c');
  const attempts = await Promise.all([
    act(
      state,
      'profile',
      { profile: { ...state.state.profile, name: 'One' } },
      'learner-c',
    ),
    act(
      state,
      'profile',
      { profile: { ...state.state.profile, name: 'Two' } },
      'learner-c',
    ),
  ]);
  assert.deepEqual(
    attempts.map((r) => r.response.status).sort((a, b) => a - b),
    [200, 409],
  );
  assert.equal((await load('learner-c')).revision, 1);
  assert.equal((await load('learner-b')).revision, 0);
});
void test('API rejects unauthenticated and cross-origin writes', async () => {
  assert.equal(
    (await GET(new Request('https://milo.test/api/study'))).status,
    401,
  );
  assert.equal(
    (
      await POST(
        new Request('https://milo.test/api/study', {
          method: 'POST',
          headers: {
            'oai-authenticated-user-id': 'learner-a',
            origin: 'https://other.test',
          },
          body: '{}',
        }),
      )
    ).status,
    403,
  );
});

void test('realtime negotiation uses server-owned instructions, multipart SDP and never persists the key', async (t) => {
  let state = await load('learner-voice');
  state = (
    await act(
      state,
      'profile',
      { profile: state.state.profile },
      'learner-voice',
    )
  ).data;
  state = (await act(state, 'start', {}, 'learner-voice')).data;
  const before = state.revision;
  t.mock.method(
    globalThis,
    'fetch',
    async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(url, 'https://api.openai.com/v1/realtime/calls');
      assert.equal(
        new Headers(init?.headers).get('Authorization'),
        'Bearer test-only-key',
      );
      assert.ok(init?.body instanceof FormData);
      assert.equal(init.body.get('sdp'), 'v=0\r\n');
      const sessionJson = init.body.get('session');
      assert.equal(typeof sessionJson, 'string');
      const config = JSON.parse(sessionJson as string);
      assert.equal(config.type, 'realtime');
      assert.deepEqual(config.output_modalities, ['audio']);
      assert.match(config.instructions, /Milo/);
      assert.equal(config.model, 'gpt-realtime-mini');
      assert.equal(config.tools.length, 2);
      return new Response('v=0\r\nanswer');
    },
  );
  const res = await realtimePOST(
    request(
      {
        apiKey: 'test-only-key',
        sdp: 'v=0\r\n',
        sessionId: state.state.session?.id,
        taskId: currentTask(state.state).id,
        taskIndex: state.state.session?.index,
        attempt: state.state.session?.retries,
      },
      'learner-voice',
    ),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sdp: 'v=0\r\nanswer' });
  const after = await load('learner-voice');
  assert.equal(after.revision, before);
  assert.equal(JSON.stringify(after).includes('test-only-key'), false);
});
