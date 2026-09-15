import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeRealtimeUsage,
  safeRealtimeUsage,
  safeRealtimeUsageDiagnostic,
} from '../lib/coach/realtime-usage';
import {
  RealtimeDiagnostics,
  safeRealtimeDiagnostic,
} from '../lib/coach/realtime-diagnostics';

function done(trace: RealtimeDiagnostics, id: string, usage?: unknown) {
  const response = { id, status: 'completed' };
  Object.assign(response, { usage });
  trace.event({ type: 'response.done', response });
}

void test('realtime usage: OpenAI keeps cache counts as a subset, never adds them to input', () => {
  assert.deepEqual(
    normalizeRealtimeUsage('openai', {
      total_tokens: 253,
      input_tokens: 132,
      output_tokens: 121,
      input_token_details: {
        text_tokens: 119,
        audio_tokens: 13,
        cached_tokens: 64,
        cached_tokens_details: { text_tokens: 60, audio_tokens: 4 },
      },
      output_token_details: { text_tokens: 30, audio_tokens: 91 },
    }),
    {
      totalTokens: 253,
      inputTokens: 132,
      outputTokens: 121,
      inputTextTokens: 119,
      inputAudioTokens: 13,
      cachedInputTokens: 64,
      cachedInputTextTokens: 60,
      cachedInputAudioTokens: 4,
      outputTextTokens: 30,
      outputAudioTokens: 91,
    },
  );
});

void test('realtime usage: Qwen uses plural details and does not invent a cache report', () => {
  assert.deepEqual(
    normalizeRealtimeUsage('qwen', {
      total_tokens: 377,
      input_tokens: 336,
      output_tokens: 41,
      input_tokens_details: { text_tokens: 228, audio_tokens: 108 },
      output_tokens_details: { text_tokens: 9, audio_tokens: 32 },
      input_token_details: { text_tokens: 999, cached_tokens: 999 },
      plugins: { search: { count: 1, strategy: 'private fixture' } },
    }),
    {
      totalTokens: 377,
      inputTokens: 336,
      outputTokens: 41,
      inputTextTokens: 228,
      inputAudioTokens: 108,
      outputTextTokens: 9,
      outputAudioTokens: 32,
    },
  );
  assert.deepEqual(
    normalizeRealtimeUsage('qwen', {
      input_tokens: 12,
      input_token_details: { audio_tokens: 12 },
    }),
    { inputTokens: 12 },
  );
});

void test('realtime usage: GLM placeholder zeroes remain distinct from absent usage', () => {
  const zeroes = normalizeRealtimeUsage('glm', {
    total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    input_token_details: { text_tokens: 0, audio_tokens: 0 },
    output_token_details: { text_tokens: 0, audio_tokens: 0 },
  });
  assert.equal(zeroes?.inputTokens, 0);
  assert.equal(zeroes?.cachedInputTokens, undefined);
  assert.equal(normalizeRealtimeUsage('glm', undefined), undefined);
  assert.equal(normalizeRealtimeUsage('glm', {}), undefined);
  assert.equal(normalizeRealtimeUsage('glm', []), undefined);
});

void test('realtime usage: only safe numeric fields survive, without coercion or derived totals', () => {
  for (const invalid of [
    '12',
    null,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_VALUE,
  ]) {
    assert.equal(safeRealtimeUsage({ inputTokens: invalid }), undefined);
    assert.equal(
      normalizeRealtimeUsage('openai', { input_tokens: invalid }),
      undefined,
    );
  }
  assert.deepEqual(
    safeRealtimeUsage({
      inputTokens: 0,
      outputTokens: 5,
      event_id: 'fixture-secret-id',
      apiKey: 'fixture-private-key',
      transcript: 'fixture-private-transcript',
      audio: 'fixture-private-audio',
    }),
    { inputTokens: 0, outputTokens: 5 },
  );
  assert.deepEqual(
    normalizeRealtimeUsage('openai', { input_tokens: 1, output_tokens: 2 }),
    { inputTokens: 1, outputTokens: 2 },
  );
  assert.equal(
    safeRealtimeUsage(Object.create({ inputTokens: 10 })),
    undefined,
  );
});

void test('realtime usage diagnostics: raw and normalized duplicates count once, including late usage', () => {
  const trace = new RealtimeDiagnostics('qwen');
  done(trace, 'fixture-private-response-a', {
    input_tokens: 20,
    output_tokens: 2,
    input_tokens_details: { audio_tokens: 10 },
  });
  done(trace, 'fixture-private-response-a', {
    inputTokens: 20,
    outputTokens: 2,
  });
  done(trace, 'fixture-private-response-b');
  done(trace, 'fixture-private-response-b', {
    inputTokens: 30,
    outputTokens: 0,
  });
  const snapshot = trace.snapshot();
  assert.equal(snapshot.counts.responsesDone, 2);
  assert.equal(snapshot.usage?.responses, 2);
  assert.deepEqual(snapshot.usage?.totals, {
    inputTokens: 50,
    outputTokens: 2,
    inputAudioTokens: 10,
  });
  assert.deepEqual(snapshot.usage?.reports, {
    inputTokens: 2,
    outputTokens: 2,
    inputAudioTokens: 1,
  });
  assert.equal(snapshot.usage?.latest?.inputAudioTokens, undefined);
  assert.equal(snapshot.usage?.latest?.response, 2);
  assert.equal(JSON.stringify(snapshot).includes('fixture-private'), false);
});

void test('realtime usage diagnostics: only terminal events with IDs report usage', () => {
  const trace = new RealtimeDiagnostics('openai');
  const response = { id: 'fixture-response', status: 'in_progress' };
  Object.assign(response, { usage: { input_tokens: 100 } });
  trace.event({ type: 'response.created', response });
  done(trace, '', { inputTokens: 20 });
  assert.equal(trace.snapshot().usage, undefined);
  done(trace, response.id, { inputTokens: 40 });
  trace.close('local_stop');
  done(trace, response.id, { inputTokens: 40 });
  done(trace, 'late-after-close', { inputTokens: 50 });
  assert.equal(trace.snapshot().usage?.totals.inputTokens, 40);
  assert.equal(trace.snapshot().usage?.responses, 1);
});

void test('realtime usage diagnostics: bounded sample history does not forget deduplication', () => {
  const trace = new RealtimeDiagnostics('glm');
  for (let i = 0; i < 80; i++)
    done(trace, `response-${i}`, { inputTokens: 10 });
  done(trace, 'response-0', { inputTokens: 10 });
  const usage = trace.snapshot().usage;
  assert.equal(usage?.responses, 80);
  assert.equal(usage?.totals.inputTokens, 800);
  assert.equal(usage?.samples.length, 64);
  assert.equal(usage?.samples[0].response, 17);
  assert.equal(usage?.latest?.response, 80);
});

void test('realtime usage diagnostics: persistence strips unknown nested fields and checks coverage', () => {
  const poisoned = {
    responses: 2,
    totals: {
      inputTokens: 50,
      outputTokens: 10,
      transcript: 'private fixture',
    },
    reports: { inputTokens: 2, outputTokens: 3, audio: 'private fixture' },
    latest: {
      response: 2,
      ms: 30,
      inputTokens: 30,
      event_id: 'private fixture',
      apiKey: 'private fixture',
    },
    samples: Array.from({ length: 100 }, (_, i) => ({
      response: i + 1,
      ms: i,
      inputTokens: i,
      transcript: 'private fixture',
      audio: 'private fixture',
    })),
    authorization: 'private fixture',
  };
  const result = safeRealtimeUsageDiagnostic(poisoned);
  assert.deepEqual(result?.totals, { inputTokens: 50 });
  assert.deepEqual(result?.reports, { inputTokens: 2 });
  assert.equal(result?.samples.length, 64);
  assert.equal(JSON.stringify(result).includes('private fixture'), false);
  assert.deepEqual(
    safeRealtimeDiagnostic({ provider: 'glm', usage: poisoned }).usage,
    result,
  );
  assert.equal(safeRealtimeUsageDiagnostic({ responses: -1 }), undefined);
});

void test('realtime usage diagnostics: aggregate arithmetic stays inside safe integer bounds', () => {
  const trace = new RealtimeDiagnostics('openai');
  done(trace, 'response-a', { inputTokens: Number.MAX_SAFE_INTEGER });
  done(trace, 'response-b', { inputTokens: 100 });
  assert.equal(
    trace.snapshot().usage?.totals.inputTokens,
    Number.MAX_SAFE_INTEGER,
  );
});
