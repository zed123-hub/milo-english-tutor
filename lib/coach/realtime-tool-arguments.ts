export type RealtimeToolArgumentsResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; category: 'malformed_json' | 'non_object' | 'schema' };

export const INVALID_REALTIME_TOOL_OUTPUT = Object.freeze({
  ok: false,
  error: 'INVALID_TOOL_ARGUMENTS',
  continueSpeaking: true,
});

/** Decode only documented JSON arguments; failures contain no model content. */
export function decodeRealtimeToolArguments(
  name: string,
  raw: string,
  provider: 'openai' | 'qwen' | 'glm' = 'openai',
): RealtimeToolArgumentsResult {
  if (typeof raw !== 'string' || raw.length > 5000)
    return { ok: false, category: 'schema' };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, category: 'malformed_json' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { ok: false, category: 'non_object' };
  const args = value as Record<string, unknown>;
  const keys = Object.keys(args);
  const only = (...allowed: string[]) =>
    keys.every((key) => allowed.includes(key));
  const optionalText = (key: string, limit: number) =>
    !Object.hasOwn(args, key) ||
    (typeof args[key] === 'string' && args[key].length <= limit);
  let valid = false;
  if (name === 'record_hint') {
    valid =
      only('level') &&
      Object.hasOwn(args, 'level') &&
      typeof args.level === 'number' &&
      Number.isInteger(args.level) &&
      [1, 2, 3].includes(args.level);
  } else if (name === 'checkpoint') {
    valid =
      only('focus', 'reason') &&
      optionalText('focus', 500) &&
      optionalText('reason', 1000) &&
      (provider !== 'glm' ||
        (Object.hasOwn(args, 'focus') && Object.hasOwn(args, 'reason')));
  } else if (name === 'end_conversation') {
    valid =
      provider === 'glm'
        ? only('reason') &&
          Object.hasOwn(args, 'reason') &&
          optionalText('reason', 1000)
        : keys.length === 0;
  }
  return valid ? { ok: true, args } : { ok: false, category: 'schema' };
}
