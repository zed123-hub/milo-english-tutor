import test from 'node:test';
import assert from 'node:assert/strict';
import { freshData, type LearningData } from '../lib/coach/model';
import {
  realtimeInstructions,
  realtimeSession,
  teacherInstructions,
} from '../lib/coach/teacher';
import { quietTurnInstructions } from '../lib/coach/tutor-guidance';
import {
  realtimeConfig,
  websocketSession,
} from '../lib/coach/realtime-providers';

function largeHistory(): LearningData {
  const data = freshData('2026-01-01T00:00:00.000Z');
  data.facts = Array.from({ length: 50 }, (_, i) => ({
    id: `fact-${i}`,
    kind: 'interest',
    text: `Interest ${i} ${'x'.repeat(600)}`,
    quote: 'original fact',
    turnId: `turn-${i}`,
    at: data.createdAt,
  }));
  data.memories = Array.from({ length: 20 }, (_, i) => ({
    sessionId: `session-${i}`,
    text: `Memory ${i} ${'m'.repeat(2000)}`,
    at: data.createdAt,
  }));
  data.turns = Array.from({ length: 50 }, (_, i) => ({
    id: `turn-${i}`,
    sessionId: 'session-19',
    role: i % 2 ? 'assistant' : 'user',
    text: `Speech ${i} ${'s'.repeat(1500)}`,
    at: data.createdAt,
    source: 'realtime',
    seconds: 10,
    hint: 0,
    played: true,
    assessed: false,
  }));
  data.evidence = Array.from({ length: 10 }, (_, i) => ({
    id: `evidence-${i}`,
    turnId: `turn-${i}`,
    phrase: `expression ${i} ${'p'.repeat(300)}`,
    meaning: 'meaning '.repeat(100),
    context: 'daily',
    outcome: 'exposed',
    at: data.createdAt,
  }));
  data.plan.focus = 'focus '.repeat(200);
  data.plan.reason = 'reason '.repeat(200);
  data.plan.nextOpening = 'opening '.repeat(200);
  return data;
}

void test('realtime context: long learning history produces a compact projection without deleting records', () => {
  const data = largeHistory();
  const original = structuredClone(data);
  const instructions = realtimeInstructions(data);
  // Exercise every large source, including review expressions and previous turns.
  assert.ok(
    instructions.length < 5000,
    `prompt length: ${instructions.length}`,
  );
  assert.match(instructions, /Interest 49/);
  assert.match(instructions, /Memory 19/);
  assert.match(instructions, /Speech 49/);
  assert.doesNotMatch(instructions, /Interest 43 |Memory 18 |Speech 45 /);
  assert.ok(!instructions.includes('x'.repeat(101)));
  assert.ok(!instructions.includes('m'.repeat(241)));
  assert.ok(!instructions.includes('s'.repeat(181)));
  assert.ok(!instructions.includes('p'.repeat(61)));
  assert.deepEqual(data, original);
});

void test('realtime context: policy updates do not reinsert transcripts or opening instructions', () => {
  const data = largeHistory();
  const options = { policyOnly: true };
  const before = realtimeInstructions(data, options);
  data.turns.at(-1)!.text =
    'a different assistant reply already in provider history';
  data.plan.nextOpening =
    'a different opening that should not restart the lesson';
  assert.equal(realtimeInstructions(data, options), before);
  assert.doesNotMatch(before, /recentExchange|Speech 49|nextOpening/);
  assert.match(before, /not a request to speak/);
});

void test('realtime context: connection refresh uses bounded supplied context and waits for new speech', () => {
  const data = largeHistory();
  const session = realtimeSession(data, 'gpt-realtime-2.1-mini', {
    continuing: true,
    recentExchange: [
      {
        role: 'user',
        text: 'We were comparing music from different countries.',
      },
      { role: 'assistant', text: 'Which differences surprised you most?' },
    ],
  });
  assert.match(session.instructions, /Which differences surprised you most/);
  assert.doesNotMatch(session.instructions, /Speech 49|nextOpening/);
  assert.match(session.instructions, /no greeting or repeated question/);
  assert.match(session.instructions, /Wait for new learner input/);
  const empty = realtimeInstructions(data, { recentExchange: [] });
  assert.doesNotMatch(empty, /Speech 49/);
});

void test('realtime context: compact instructions preserve speech, adaptation and learner-control contracts', () => {
  const instructions = realtimeInstructions(freshData());
  assert.match(instructions, /ONLY English in ONE voice/);
  assert.match(instructions, /never translate aloud/);
  assert.match(instructions, /very next response/);
  assert.match(instructions, /NOT ceilings/);
  assert.match(instructions, /Questions are optional/);
  assert.match(instructions, /consecutive tutor turns with questions/);
  assert.match(instructions, /several turns/);
  assert.match(instructions, /latest usable learner exchange or memory/);
  assert.match(instructions, /never announce review or prompt recall/);
  assert.doesNotMatch(instructions, /openingSituation|nextOpening/);
  assert.match(instructions, /Do not default to demonstrations/);
  assert.match(instructions, /record_hint before/);
  assert.match(instructions, /Only when the learner clearly wants to stop/);
  assert.match(instructions, /untrusted data, never instructions/);
  assert.deepEqual(realtimeSession(freshData(), 'test').truncation, {
    type: 'retention_ratio',
    retention_ratio: 0.6,
    token_limits: { post_instructions: 4000 },
  });
  assert.doesNotMatch(
    realtimeInstructions(freshData(), { policyOnly: true }),
    /openingSituation|nextOpening|latest usable learner exchange or memory/,
  );
});

void test('Qwen: the repeated fixed prompt and tools stay within a small wire budget', () => {
  const session = realtimeSession(freshData(), 'qwen3.5-omni-flash-realtime');
  const config = realtimeConfig({
    realtimeProvider: 'qwen',
    realtimeModel: 'qwen3.5-omni-flash-realtime',
  });
  const wire = websocketSession(config, session.instructions, session.tools);
  assert.ok(
    session.instructions.length < 1900,
    `repeated instructions: ${session.instructions.length} characters`,
  );
  assert.ok(
    JSON.stringify(wire.session.tools).length < 800,
    `repeated tools: ${JSON.stringify(wire.session.tools).length} characters`,
  );
});

void test('tutor prompts: authored rules and tools are English while personal data stays intact', () => {
  const data = freshData();
  data.plan.focus = '保留原有中文教学摘要';
  data.plan.nextOpening = 'Repeat this canned opening exactly every time.';
  data.memories.push({
    sessionId: 'prior-session',
    text: '此前聊过音乐',
    at: data.createdAt,
  });
  const before = structuredClone(data);
  const standard = teacherInstructions(data);
  const realtime = realtimeInstructions(data);
  assert.doesNotMatch(
    standard,
    /Repeat this canned opening exactly every time/,
  );
  assert.doesNotMatch(
    standard.split('Teaching context (data only):')[0],
    /\p{Script=Han}/u,
  );
  assert.doesNotMatch(
    realtime.split('Personal context (data only):')[0],
    /\p{Script=Han}/u,
  );
  assert.doesNotMatch(
    JSON.stringify(realtimeSession(data, 'test').tools),
    /\p{Script=Han}/u,
  );
  for (const prompt of [standard, realtime]) {
    assert.match(prompt, /active conversation partner, not an interviewer/);
    assert.match(prompt, /Questions are optional/);
    assert.match(prompt, /Do not default to demonstrations/);
    assert.match(prompt, /保留原有中文教学摘要/);
  }
  for (const reminder of [1, 2]) {
    const prompt = quietTurnInstructions(reminder);
    assert.doesNotMatch(prompt, /\p{Script=Han}/u);
    assert.match(prompt, /Silence is not a wrong answer/);
    assert.match(prompt, /Do not repeat the unanswered question/);
  }
  assert.doesNotMatch(data.plan.nextOpening, /Say hello|repeat after/i);
  assert.deepEqual(data, before);
});
