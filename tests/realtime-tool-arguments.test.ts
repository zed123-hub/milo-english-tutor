import assert from 'node:assert/strict';
import test from 'node:test';
import { RealtimeEvents } from '../lib/coach/realtime-providers';
import {
  decodeRealtimeToolArguments,
  INVALID_REALTIME_TOOL_OUTPUT,
} from '../lib/coach/realtime-tool-arguments';

void test('realtime tool arguments: reject malformed JSON without repairing or exposing it', () => {
  for (const raw of [
    '',
    '{',
    "{'level': 1}",
    '```json\n{"level":1}\n```',
    '{"level":1,}',
    '{"level": fixture-private-key}',
  ]) {
    assert.deepEqual(decodeRealtimeToolArguments('record_hint', raw), {
      ok: false,
      category: 'malformed_json',
    });
  }
});

void test('realtime tool arguments: valid JSON must be an object', () => {
  for (const raw of ['null', '[]', '[1]', '"text"', '1', 'true', 'false']) {
    assert.deepEqual(decodeRealtimeToolArguments('checkpoint', raw), {
      ok: false,
      category: 'non_object',
    });
  }
});

void test('realtime tool arguments: hint level is a required integer enum with no extra fields', () => {
  for (const provider of ['openai', 'qwen', 'glm'] as const) {
    for (const level of [1, 2, 3]) {
      assert.deepEqual(
        decodeRealtimeToolArguments(
          'record_hint',
          JSON.stringify({ level }),
          provider,
        ),
        { ok: true, args: { level } },
      );
    }
    for (const args of [
      {},
      { level: 0 },
      { level: 4 },
      { level: 1.5 },
      { level: '1' },
      { level: true },
      { level: null },
      { level: 1, reason: 'extra' },
    ]) {
      assert.deepEqual(
        decodeRealtimeToolArguments(
          'record_hint',
          JSON.stringify(args),
          provider,
        ),
        { ok: false, category: 'schema' },
      );
    }
  }
});

void test('realtime tool arguments: checkpoint required fields differ by provider', () => {
  const complete = {
    focus: 'Ordering food',
    reason: 'Practice a clear request.',
  };
  for (const provider of ['openai', 'qwen', 'glm'] as const) {
    assert.deepEqual(
      decodeRealtimeToolArguments(
        'checkpoint',
        JSON.stringify(complete),
        provider,
      ),
      { ok: true, args: complete },
    );
    for (const args of [
      {},
      { focus: 'Ordering food' },
      { reason: 'Practice' },
    ]) {
      assert.deepEqual(
        decodeRealtimeToolArguments(
          'checkpoint',
          JSON.stringify(args),
          provider,
        ),
        provider === 'glm'
          ? { ok: false, category: 'schema' }
          : { ok: true, args },
      );
    }
    // The published schemas impose string types, not minLength constraints.
    assert.deepEqual(
      decodeRealtimeToolArguments(
        'checkpoint',
        '{"focus":"","reason":""}',
        provider,
      ),
      { ok: true, args: { focus: '', reason: '' } },
    );
  }
  assert.deepEqual(decodeRealtimeToolArguments('checkpoint', '{}'), {
    ok: true,
    args: {},
  });
});

void test('realtime tool arguments: checkpoint text types and existing limits are enforced', () => {
  const boundary = { focus: 'f'.repeat(500), reason: 'r'.repeat(1000) };
  assert.deepEqual(
    decodeRealtimeToolArguments('checkpoint', JSON.stringify(boundary), 'glm'),
    { ok: true, args: boundary },
  );
  for (const args of [
    { focus: 'f'.repeat(501) },
    { reason: 'r'.repeat(1001) },
    { focus: 1 },
    { reason: null },
    { focus: {} },
    { reason: [] },
    { extra: 'fixture-private-key' },
  ]) {
    assert.deepEqual(
      decodeRealtimeToolArguments('checkpoint', JSON.stringify(args)),
      { ok: false, category: 'schema' },
    );
  }
});

void test('realtime tool arguments: end schema permits empty base arguments and requires a GLM reason', () => {
  for (const provider of ['openai', 'qwen'] as const) {
    assert.deepEqual(
      decodeRealtimeToolArguments('end_conversation', '{}', provider),
      {
        ok: true,
        args: {},
      },
    );
    assert.deepEqual(
      decodeRealtimeToolArguments(
        'end_conversation',
        '{"reason":"done"}',
        provider,
      ),
      { ok: false, category: 'schema' },
    );
  }
  for (const reason of ['', 'done', 'r'.repeat(1000)]) {
    assert.deepEqual(
      decodeRealtimeToolArguments(
        'end_conversation',
        JSON.stringify({ reason }),
        'glm',
      ),
      { ok: true, args: { reason } },
    );
  }
  for (const args of [
    {},
    { reason: 1 },
    { reason: 'r'.repeat(1001) },
    { reason: 'done', extra: 1 },
  ]) {
    assert.deepEqual(
      decodeRealtimeToolArguments(
        'end_conversation',
        JSON.stringify(args),
        'glm',
      ),
      { ok: false, category: 'schema' },
    );
  }
});

void test('realtime tool arguments: input size and unknown names or properties fail with metadata only', () => {
  assert.deepEqual(
    decodeRealtimeToolArguments('checkpoint', '{}'.padEnd(5000)),
    {
      ok: true,
      args: {},
    },
  );
  for (const [name, raw] of [
    ['checkpoint', '{}'.padEnd(5001)],
    ['unknown_fixture_private_key', '{}'],
    ['checkpoint', '{"__proto__":{"fixture":"private-key"}}'],
    ['checkpoint', '{"constructor":"private-key"}'],
    ['checkpoint', '{"prototype":"private-key"}'],
  ]) {
    assert.deepEqual(decodeRealtimeToolArguments(name, raw), {
      ok: false,
      category: 'schema',
    });
  }
  assert.deepEqual(INVALID_REALTIME_TOOL_OUTPUT, {
    ok: false,
    error: 'INVALID_TOOL_ARGUMENTS',
    continueSpeaking: true,
  });
  assert.equal(Object.isFrozen(INVALID_REALTIME_TOOL_OUTPUT), true);
});

void test('GLM tools: same-name calls retain separate indices across mixed and late carriers', () => {
  const events = new RealtimeEvents('glm');
  const args = (index: number) => ({
    type: 'response.function_call_arguments.done',
    response_id: 'reply',
    name: 'record_hint',
    output_index: index,
    arguments: JSON.stringify({ level: index + 1 }),
  });
  assert.equal(events.normalize(args(0)), null);
  const result = events.normalize({
    type: 'response.done',
    response: {
      id: 'reply',
      status: 'completed',
      output: [
        {
          type: 'function_call',
          name: 'record_hint',
          call_id: '',
          arguments: '{"level":1}',
        },
        {
          type: 'function_call',
          name: 'record_hint',
          call_id: '',
          arguments: '{"level":2}',
        },
      ],
    },
  });
  const calls = result!.response!.output!;
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].call_id, calls[1].call_id);
  assert.equal(
    events.normalize(args(1)),
    null,
    'Late duplicate must not run twice',
  );
  assert.throws(
    () => new RealtimeEvents('glm').normalize(args(-1)),
    /MODEL_OUTPUT/,
  );
  const late = new RealtimeEvents('glm');
  late.normalize({
    type: 'response.done',
    response: { id: 'reply', status: 'completed' },
  });
  assert.equal(late.normalize(args(0))!.response!.output!.length, 1);
  assert.equal(late.normalize(args(1))!.response!.output!.length, 1);
});

void test('GLM tools: mixed call_id carriers execute once and preserve the actual result ID', () => {
  for (const argumentsFirst of [true, false]) {
    const events = new RealtimeEvents('glm');
    const args = {
      type: 'response.function_call_arguments.done',
      response_id: 'mixed',
      name: 'record_hint',
      output_index: 0,
      arguments: '{"level":1}',
    };
    const done = {
      type: 'response.done',
      response: {
        id: 'mixed',
        status: 'completed',
        output: [
          {
            type: 'function_call',
            name: 'record_hint',
            call_id: 'call-real',
            arguments: '{"level":1}',
          },
        ],
      },
    };
    const outputs = (argumentsFirst ? [args, done] : [done, args]).flatMap(
      (e) => events.normalize(e)?.response?.output ?? [],
    );
    assert.equal(outputs.length, 1);
    assert.equal(
      events.toolResult(outputs[0].call_id, '{}').item.call_id,
      'call-real',
    );
  }
});
