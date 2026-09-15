import type { RealtimeProvider } from './realtime-providers';

export const realtimeUsageFields = [
  'totalTokens',
  'inputTokens',
  'outputTokens',
  'inputTextTokens',
  'inputAudioTokens',
  'cachedInputTokens',
  'cachedInputTextTokens',
  'cachedInputAudioTokens',
  'outputTextTokens',
  'outputAudioTokens',
] as const;
export type RealtimeUsageField = (typeof realtimeUsageFields)[number];
/** Provider-reported counts only. An absent field means unknown, not zero. */
export type RealtimeUsage = Partial<Record<RealtimeUsageField, number>>;
export type RealtimeUsageSample = RealtimeUsage & {
  /** Connection-local ordinal, never the provider's response ID. */
  response: number;
  ms: number;
};
export type RealtimeUsageDiagnostic = {
  responses: number;
  /** Sums of reported counts, with per-field coverage in reports. */
  totals: RealtimeUsage;
  reports: Partial<Record<RealtimeUsageField, number>>;
  latest?: RealtimeUsageSample;
  samples: RealtimeUsageSample[];
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Whitelist the normalized form again at every persistence boundary. */
export function safeRealtimeUsage(value: unknown): RealtimeUsage | undefined {
  const source = record(value);
  if (!source) return;
  const result: RealtimeUsage = {};
  for (const key of realtimeUsageFields) {
    const value = Object.hasOwn(source, key) ? count(source[key]) : undefined;
    if (value !== undefined) result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

/**
 * Parse response.done.response.usage using the provider's own field spelling.
 * Qwen uses tokens_details; OpenAI and GLM use token_details. Qwen's published
 * schema has no cached-token counts, so missing cache usage stays unknown.
 * GLM may report placeholder zeroes; these counts are not a price estimate.
 */
export function normalizeRealtimeUsage(
  provider: RealtimeProvider,
  value: unknown,
): RealtimeUsage | undefined {
  const source = record(value);
  if (!source || !['openai', 'qwen', 'glm'].includes(provider)) return;
  const input = record(
    provider === 'qwen'
      ? source.input_tokens_details
      : source.input_token_details,
  );
  const output = record(
    provider === 'qwen'
      ? source.output_tokens_details
      : source.output_token_details,
  );
  const cached =
    provider === 'openai' ? record(input?.cached_tokens_details) : undefined;
  return safeRealtimeUsage({
    totalTokens: source.total_tokens,
    inputTokens: source.input_tokens,
    outputTokens: source.output_tokens,
    inputTextTokens: input?.text_tokens,
    inputAudioTokens: input?.audio_tokens,
    cachedInputTokens: provider === 'qwen' ? undefined : input?.cached_tokens,
    cachedInputTextTokens: cached?.text_tokens,
    cachedInputAudioTokens: cached?.audio_tokens,
    outputTextTokens: output?.text_tokens,
    outputAudioTokens: output?.audio_tokens,
  });
}

function sample(value: unknown): RealtimeUsageSample | undefined {
  const source = record(value);
  if (!source) return;
  const usage = safeRealtimeUsage(source);
  const response = count(source.response);
  const ms = count(source.ms);
  if (!usage || response === undefined || response < 1 || ms === undefined)
    return;
  return { response, ms, ...usage };
}

export function safeRealtimeUsageDiagnostic(
  value: unknown,
): RealtimeUsageDiagnostic | undefined {
  const source = record(value);
  const responses = count(source?.responses);
  if (!source || responses === undefined || responses === 0) return;
  const totals = safeRealtimeUsage(source.totals) ?? {};
  const reports: RealtimeUsage = {};
  const rawReports = record(source.reports);
  for (const key of realtimeUsageFields) {
    const n = count(rawReports?.[key]);
    if (totals[key] !== undefined && n !== undefined && n > 0 && n <= responses)
      reports[key] = n;
    else delete totals[key];
  }
  const latest = sample(source.latest);
  const samples = (Array.isArray(source.samples) ? source.samples : [])
    .slice(-64)
    .flatMap((value) => {
      const result = sample(value);
      return result ? [result] : [];
    });
  return {
    responses,
    totals,
    reports,
    ...(latest ? { latest } : {}),
    samples,
  };
}
