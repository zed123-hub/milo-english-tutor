import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyStudent,
  makePlan,
  startSession,
  reduceEvidence,
  continueSession,
  revealHint,
  ruleEvaluation,
  studentSummary,
  localDay,
  type Evidence,
  type StudentState,
} from '../lib/tutor/domain';
import { getTask, observedItems } from '../lib/tutor/inventory';
import { completedTools } from '../lib/tutor/voice';
import { realtimeConfig } from '../lib/tutor/realtime-config';
import { evaluateAnswer } from '../lib/tutor/evaluator';
import { defaultConfig } from '../lib/providers';
import { readBody, safeError } from '../lib/tutor/http';

function evidence(patch: Partial<Evidence> = {}): Evidence {
  return {
    id: crypto.randomUUID(),
    sessionId: 'session-test',
    taskId: 'coffee-simple',
    at: '2026-09-08T04:00:00Z',
    studyDay: '2026-09-08',
    inputMode: 'browser-speech',
    transcript: 'Can I have a coffee, please?',
    hintLevel: 0,
    sourceExposed: false,
    audioPlayed: true,
    retry: false,
    outcome: 'pass',
    verifiedItems: ['can-i-have', 'please'],
    feedback: '你表达清楚了。',
    assessment: 'rules',
    ...patch,
  };
}
void test('first meeting assesses distinct abilities and low energy reduces later workload', () => {
  const state = emptyStudent();
  assert.deepEqual(makePlan(state, '2026-09-08T04:00:00Z', 'plan-id').taskIds, [
    'intro',
    'listen-routine',
    'coffee-simple',
  ]);
  state.diagnosticCompleted = true;
  state.profile.energy = 'low';
  assert.equal(
    makePlan(state, '2026-09-08T04:00:00Z', 'plan-id').taskIds.length,
    1,
  );
});
void test('evidence uses distinct speech days; repeats and duplicates do not accelerate mastery', () => {
  const first = evidence();
  let state = reduceEvidence(emptyStudent(), first);
  assert.equal(state.items['can-i-have'].stage, 'RECALL');
  assert.equal(reduceEvidence(state, first), state);
  const due = state.items['can-i-have'].due;
  for (let i = 0; i < 5; i++) state = reduceEvidence(state, evidence());
  assert.equal(state.items['can-i-have'].stage, 'RECALL');
  assert.equal(state.items['can-i-have'].due, due);
  state = reduceEvidence(state, evidence({ studyDay: '2026-09-09' }));
  assert.equal(state.items['can-i-have'].stage, 'INDEPENDENT_USE');
  state = reduceEvidence(
    state,
    evidence({
      studyDay: '2026-09-10',
      taskId: 'office-request',
      transcript: 'Could you send me the file, please?',
      verifiedItems: ['please'],
    }),
  );
  assert.equal(state.items.please.stage, 'TRANSFER_USE');
});
void test('typing, hints and retries never count as independent spoken days', () => {
  for (const patch of [
    { inputMode: 'typed' as const },
    { hintLevel: 1 },
    { hintLevel: 3, sourceExposed: true },
    { sourceExposed: true },
    { retry: true },
  ]) {
    let state = emptyStudent();
    for (let day = 8; day <= 12; day++)
      state = reduceEvidence(
        state,
        evidence({
          ...patch,
          studyDay: `2026-09-${String(day).padStart(2, '0')}`,
        }),
      );
    assert.equal(state.items['can-i-have'].spokenDays.length, 0);
    assert.equal(studentSummary(state).activeItems, 0);
  }
});
void test('listening only builds understanding from unexposed played audio, never production', () => {
  const base = {
    taskId: 'listen-routine',
    transcript: 'I usually have coffee in the morning.',
    verifiedItems: ['usually'],
  };
  for (const patch of [
    { audioPlayed: false },
    { sourceExposed: true },
    { hintLevel: 1 },
    { retry: true },
  ]) {
    const state = reduceEvidence(
      emptyStudent(),
      evidence({ ...base, ...patch }),
    );
    assert.equal(Object.keys(state.items).length, 0);
  }
  const state = reduceEvidence(
    emptyStudent(),
    evidence({
      ...base,
      transcript: '早晨',
      inputMode: 'typed',
      verifiedItems: [],
    }),
  );
  assert.equal(state.items.usually.stage, 'UNDERSTAND');
  assert.equal(state.items.usually.spokenDays.length, 0);
  assert.equal(studentSummary(state).listening.successful, 1);
});
void test('revealed answers cannot unlock higher difficulty', () => {
  let state: StudentState = { ...emptyStudent(), diagnosticCompleted: true };
  for (const studyDay of [
    '2026-09-07',
    '2026-09-07',
    '2026-09-08',
    '2026-09-08',
  ])
    state = reduceEvidence(state, evidence({ studyDay, sourceExposed: true }));
  state.items = {};
  const plan = makePlan(state, '2026-09-08T04:00:00Z', 'plan-test');
  assert.ok(plan.taskIds.every((id) => getTask(id).level === 1));
});
void test('hints persist through retries and reset only at a different task', () => {
  let state = emptyStudent();
  state.session = startSession(
    makePlan(state, '2026-09-08T04:00:00Z', 'session-test'),
  );
  state = revealHint(revealHint(revealHint(state)));
  state = reduceEvidence(
    state,
    evidence({ taskId: 'intro', outcome: 'fail', verifiedItems: [] }),
  );
  state = continueSession(state);
  assert.equal(state.session?.hintLevel, 3);
  assert.equal(state.session?.retries, 1);
  assert.equal(state.session?.sourceExposed, true);
  state = reduceEvidence(
    state,
    evidence({ taskId: 'intro', hintLevel: 3, retry: true }),
  );
  state = continueSession(state);
  assert.equal(state.session?.index, 1);
  assert.equal(state.session?.hintLevel, 0);
  assert.equal(state.session?.sourceExposed, false);
});
void test('unknown and fabricated language items do not enter the model', () => {
  const state = reduceEvidence(
    emptyStudent(),
    evidence({
      transcript: 'Coffee, please.',
      verifiedItems: ['can-i-have', 'im', 'please', 'invented'],
    }),
  );
  assert.deepEqual(Object.keys(state.items), ['please']);
  assert.deepEqual(observedItems('I imagine this', ['im']), []);
});
void test('fallback accepts clear requests but defers ambiguous, negative and incomplete answers', () => {
  assert.equal(
    ruleEvaluation(getTask('coffee-simple'), 'Can I have a coffee, please?')
      .outcome,
    'pass',
  );
  assert.equal(
    ruleEvaluation(getTask('listen-routine'), '在早晨').outcome,
    'pass',
  );
  for (const [id, text] of [
    ['intro', "I'm not Alex."],
    ['intro', "I'm fine."],
    ['coffee-simple', 'Coffee is disgusting, please take it away.'],
    ['airport-clarify', 'Please do not repeat that again.'],
    ['friends-preference', 'I prefer pizza because'],
    ['morning-plan', 'william'],
  ])
    assert.notEqual(
      ruleEvaluation(getTask(id), text).outcome,
      'pass',
      `${id}: ${text}`,
    );
});
void test('model evaluator accepts alternatives but cannot fabricate used items or stages', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  outcome: 'pass',
                  feedback: '点单意思清楚。',
                  verifiedItems: ['can-i-have'],
                  stage: 'TRANSFER_USE',
                }),
              },
            },
          ],
        }),
      ),
  );
  const result = await evaluateAnswer(
    getTask('coffee-simple'),
    'One coffee, please.',
    defaultConfig,
    'test-only-key',
  );
  assert.equal(result.outcome, 'pass');
  assert.deepEqual(result.verifiedItems, ['please']);
  assert.equal('stage' in result, false);
});
void test('a malformed model response does not silently fall back or save a grade', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'I think you did great' } }],
        }),
      ),
  );
  await assert.rejects(
    evaluateAnswer(
      getTask('intro'),
      'My name is Alex.',
      defaultConfig,
      'test-only-key',
    ),
    /MODEL_OUTPUT/,
  );
});
void test('realtime executes tools only after a completed response and keeps audio-only modality', () => {
  const call = {
    type: 'function_call',
    name: 'finish_task',
    call_id: 'c1',
    arguments: '{}',
  };
  assert.deepEqual(
    completedTools({
      type: 'response.function_call_arguments.done',
      response: { status: 'completed', output: [call] },
    }),
    [],
  );
  assert.deepEqual(
    completedTools({
      type: 'response.done',
      response: { status: 'cancelled', output: [call] },
    }),
    [],
  );
  assert.equal(
    completedTools({
      type: 'response.done',
      response: { status: 'completed', output: [call] },
    }).length,
    1,
  );
  const state = emptyStudent();
  state.session = startSession(
    makePlan(state, '2026-09-08T04:00:00Z', 'test-plan'),
  );
  const config = realtimeConfig(state, 'gpt-realtime-mini');
  assert.deepEqual(config.output_modalities, ['audio']);
  assert.equal(config.audio.input.turn_detection.interrupt_response, true);
});
void test('HTTP parsing is bounded and malformed JSON returns a client error', async () => {
  await assert.rejects(
    readBody(
      new Request('https://milo.test/api/study', {
        method: 'POST',
        headers: { origin: 'https://other.test' },
        body: '{}',
      }),
    ),
    /ORIGIN/,
  );
  await assert.rejects(
    readBody(
      new Request('https://milo.test/api/study', {
        method: 'POST',
        body: 'x'.repeat(20),
      }),
      10,
    ),
    /TOO_LARGE/,
  );
  assert.equal(safeError(new SyntaxError()).status, 400);
  assert.equal(localDay('2026-09-08T17:00:00Z'), '2026-09-09');
});
