export type RealtimeFault = {
  code: string;
  providerCode?: string;
  parameter?: string;
  fieldPath?: string;
  parameterStatus?: 'absent' | 'allowed' | 'unrecognized';
  requestType?: string;
  requestStatus?: 'absent' | 'matched' | 'unmatched';
  validation?: { path: string; rule: string }[];
};
const requestTypes = new Set([
  'session.update',
  'response.create',
  'response.cancel',
  'output_audio_buffer.clear',
  'conversation.item.create',
]);
export class RealtimeRequestError extends Error {
  constructor(readonly fault: RealtimeFault) {
    super(fault.code);
  }
}
const validationFields = new Set([
  'body',
  'session',
  'tools',
  'function',
  'name',
  'description',
  'parameters',
  'properties',
  'required',
  'type',
  'enum',
  'additionalProperties',
  'level',
  'focus',
  'reason',
  'audio',
  'input',
  'output',
  'format',
  'rate',
  'sample_rate',
  'transcription',
  'model',
  'voice',
  'speed',
  'instructions',
  'modalities',
  'output_modalities',
  'turn_detection',
  'threshold',
  'prefix_padding_ms',
  'silence_duration_ms',
  'create_response',
  'interrupt_response',
  'tracing',
  'tool_choice',
  'input_audio_format',
  'output_audio_format',
  'beta_fields',
  'greeting_config',
  'enable',
  'content',
  'chat_mode',
  'tts_source',
  'auto_search',
  'response',
  'item',
  'id',
  'item_id',
  'call_id',
  'event_id',
  'response_id',
  'previous_item_id',
  'output_index',
  'content_index',
  'audio_end_ms',
  'object',
  'role',
  'text',
  'arguments',
  'conversation',
  'input_audio_transcription',
  'noise_reduction',
  'eagerness',
  'max_response_output_tokens',
  'max_output_tokens',
  'temperature',
  'truncation',
  'retention_ratio',
  'token_limits',
  'post_instructions',
]);
export function realtimeFieldPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 240) return;
  const parts = value.replace(/\[(\d{1,2})\]/g, '.$1').split('.');
  if (
    !parts.length ||
    parts.length > 14 ||
    !parts.every(
      (part) =>
        validationFields.has(part) ||
        /^(?:[0-9]|[1-5][0-9]|6[0-4])$/.test(part),
    )
  )
    return;
  return parts.join('.');
}
const validationRules = new Set([
  'missing',
  'string_type',
  'int_type',
  'bool_type',
  'dict_type',
  'list_type',
  'literal_error',
  'enum',
  'extra_forbidden',
  'too_short',
  'too_long',
]);
function validationDetails(message: string) {
  try {
    const start = message.indexOf('{');
    if (start < 0) return [];
    const parsed = JSON.parse(message.slice(start)) as { detail?: unknown };
    if (!Array.isArray(parsed.detail)) return [];
    return parsed.detail.slice(0, 8).flatMap((item: unknown) => {
      if (!item || typeof item !== 'object') return [];
      const entry = item as { loc?: unknown; type?: unknown };
      if (
        !Array.isArray(entry.loc) ||
        entry.loc.length > 14 ||
        typeof entry.type !== 'string' ||
        !validationRules.has(entry.type)
      )
        return [];
      if (
        !entry.loc.length ||
        !entry.loc.every((part: unknown) =>
          typeof part === 'string'
            ? validationFields.has(part)
            : typeof part === 'number' &&
              Number.isInteger(part) &&
              part >= 0 &&
              part <= 64,
        )
      )
        return [];
      return [{ path: entry.loc.join('.'), rule: entry.type }];
    });
  } catch {
    return [];
  }
}
const knownCodes: Record<string, string> = {
  stop_task_error: 'response_cancel_not_active',
  response_cancel_not_active: 'response_cancel_not_active',
  invalid_api_key: 'MODEL_AUTH',
  authentication_error: 'MODEL_AUTH',
  insufficient_quota: 'MODEL_BALANCE',
  rate_limit_exceeded: 'MODEL_LIMIT',
  permission_denied: 'MODEL_PERMISSION',
  model_not_found: 'REALTIME_MODEL',
  invalid_event: 'REALTIME_PROTOCOL',
  invalid_request_error: 'REALTIME_CONFIG',
  invalid_value: 'REALTIME_CONFIG',
  missing_required_parameter: 'REALTIME_CONFIG',
  unsupported_parameter: 'REALTIME_CONFIG',
  invalid_audio_format: 'REALTIME_AUDIO',
  audio_decode_error: 'REALTIME_AUDIO',
  context_length_exceeded: 'REALTIME_CONTEXT',
  model_query_error: 'MODEL_FAILED',
  video_model_query_error: 'MODEL_FAILED',
  asr_no_result: 'REALTIME_TRANSCRIPTION',
  ASR_ERROR: 'REALTIME_TRANSCRIPTION',
  '1000': 'MODEL_AUTH',
  '1001': 'MODEL_AUTH',
  '1002': 'MODEL_AUTH',
  '1003': 'MODEL_AUTH',
  '1004': 'MODEL_AUTH',
  '1005': 'MODEL_AUTH',
  '1113': 'MODEL_BALANCE',
  '1210': 'REALTIME_CONFIG',
  '1211': 'REALTIME_MODEL',
  '1213': 'REALTIME_CONFIG',
  '1214': 'REALTIME_CONFIG',
  '1215': 'REALTIME_CONFIG',
  '1220': 'MODEL_PERMISSION',
  '1261': 'REALTIME_CONTEXT',
  '1302': 'MODEL_LIMIT',
  '1305': 'MODEL_BUSY',
  '1311': 'MODEL_PERMISSION',
  '1315': 'MODEL_PERMISSION',
};
const knownParameters = [
  'input_audio_format',
  'output_audio_format',
  'turn_detection',
  'greeting_config',
  'beta_fields',
  'voice',
  'tools',
  'instructions',
  'modalities',
  'model',
] as const;
/** Inspect in memory, but return only fixed categories and allowlisted protocol labels. */
export function realtimeFault(raw: unknown): RealtimeFault {
  const error =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const sourceCode =
    typeof error.code === 'number' || typeof error.code === 'string'
      ? String(error.code)
      : '';
  const type = typeof error.type === 'string' ? error.type : '';
  const message =
    typeof error.message === 'string' ? error.message.slice(0, 4096) : '';
  const param = typeof error.param === 'string' ? error.param : '';
  const fieldPath = realtimeFieldPath(param);
  const validation = validationDetails(message);
  const providerCode = Object.hasOwn(knownCodes, sourceCode)
    ? sourceCode
    : undefined;
  let code = providerCode
    ? knownCodes[providerCode]
    : Object.hasOwn(knownCodes, type)
      ? knownCodes[type]
      : 'MODEL_FAILED';
  const parameter = knownParameters.find(
    (p) =>
      param === p ||
      param === `session.${p}` ||
      new RegExp(`\\b${p}\\b`).test(message),
  );
  if (
    code === 'MODEL_FAILED' &&
    parameter &&
    /invalid|missing|required|unsupported|\b422\b|dict_type|list_type|不支持|必填|无效|参数/i.test(
      message,
    )
  )
    code = 'REALTIME_CONFIG';
  if (
    code === 'MODEL_FAILED' &&
    /audio.*(?:decode|format)|(?:decode|format).*audio|音频.*(?:格式|解码)/i.test(
      message,
    )
  )
    code = 'REALTIME_AUDIO';
  return {
    code,
    ...(providerCode ? { providerCode } : {}),
    ...(parameter ? { parameter } : {}),
    ...(fieldPath ? { fieldPath } : {}),
    ...(providerCode === 'invalid_value'
      ? {
          parameterStatus: !param
            ? ('absent' as const)
            : fieldPath
              ? ('allowed' as const)
              : ('unrecognized' as const),
        }
      : {}),
    ...(validation.length ? { validation } : {}),
  };
}

/** Failed response payloads use the same privacy boundary as explicit error events. */
export function realtimeResponseFault(
  value: unknown,
): RealtimeFault | undefined {
  if (!value || typeof value !== 'object') return;
  const response = value as {
    status?: unknown;
    status_details?: unknown;
    error?: unknown;
  };
  if (response.status !== 'failed' && response.status !== 'incomplete') return;
  if (response.error) return safeRealtimeFault(response.error);
  const details = response.status_details;
  return realtimeFault(
    details && typeof details === 'object'
      ? (details as { error?: unknown }).error
      : undefined,
  );
}
const messages: Record<string, string> = {
  MODEL_AUTH: '实时服务的 Key 无效或已过期，请在模型设置中重新填写。',
  MODEL_PERMISSION:
    '当前 Key 没有这项实时模型的使用权限；普通文本或编程套餐权限不一定包含实时音频。',
  MODEL_BALANCE: '实时服务返回余额或额度不足，请检查对应 API 账户。',
  MODEL_LIMIT: '实时服务请求受限，请稍后重新连接。',
  MODEL_BUSY: '实时模型当前繁忙，请稍后重新连接。',
  REALTIME_MODEL: '实时服务不支持当前模型名称，请检查模型设置。',
  REALTIME_CONFIG:
    '实时服务拒绝了会话配置；这是参数兼容问题，请刷新应用后重连。',
  REALTIME_PROTOCOL: '实时对话事件无法处理，连接已暂停。',
  REALTIME_BACKPRESSURE:
    '实时声音传输积压，连接已暂停。请检查网络或浏览器是否卡顿后重新连接。',
  REALTIME_EVENT_LIMIT:
    '本机实时控制事件过于频繁，连接已暂停。请刷新应用后重新连接。',
  REALTIME_STALE_SESSION: '这段实时会话已失效，请重新连接。',
  REALTIME_CONNECTION: '实时服务的连接意外断开，请检查网络后重新连接。',
  REALTIME_AUDIO: '实时服务无法解析上传的音频，连接已暂停。',
  REALTIME_TRANSCRIPTION: '实时服务未能识别这段声音，请重新说一句。',
  REALTIME_CONTEXT: '本轮对话超过模型的上下文限制，请重新连接接着聊。',
  REALTIME_TIMEOUT: '实时模型连接超时，请检查网络或切换服务后重连。',
  REALTIME_INPUT_STALLED:
    '没有持续收到麦克风声音，请确认浏览器选中了正确的麦克风。',
  MODEL_FAILED: '实时模型返回了服务错误，连接已暂停；收到的对话仍保留在本机。',
};
/** Revalidate diagnostic input even when it originated in the local browser. */
export function safeRealtimeFault(value: unknown): RealtimeFault {
  const raw =
    value && typeof value === 'object'
      ? (value as RealtimeFault)
      : { code: '' };
  const code =
    Object.hasOwn(messages, raw.code) ||
    raw.code === 'response_cancel_not_active'
      ? raw.code
      : 'MODEL_FAILED';
  const fieldPath = realtimeFieldPath(raw.fieldPath);
  return {
    code,
    ...(raw.providerCode && Object.hasOwn(knownCodes, raw.providerCode)
      ? { providerCode: raw.providerCode }
      : {}),
    ...(knownParameters.includes(
      raw.parameter as (typeof knownParameters)[number],
    )
      ? { parameter: raw.parameter }
      : {}),
    ...(fieldPath ? { fieldPath } : {}),
    ...(requestTypes.has(raw.requestType ?? '')
      ? { requestType: raw.requestType }
      : {}),
    ...(['absent', 'matched', 'unmatched'].includes(raw.requestStatus ?? '')
      ? { requestStatus: raw.requestStatus }
      : {}),
    ...(Array.isArray(raw.validation)
      ? {
          validation: raw.validation.slice(0, 8).flatMap((v) => {
            const path = realtimeFieldPath(v?.path);
            return path && validationRules.has(v?.rule)
              ? [{ path, rule: v.rule }]
              : [];
          }),
        }
      : {}),
    ...(['absent', 'allowed', 'unrecognized'].includes(
      raw.parameterStatus ?? '',
    )
      ? { parameterStatus: raw.parameterStatus }
      : {}),
  };
}
export function realtimeErrorMessage(fault?: RealtimeFault) {
  const safeCode =
    fault?.code && Object.hasOwn(messages, fault.code)
      ? fault.code
      : 'MODEL_FAILED';
  const detail =
    fault?.providerCode && Object.hasOwn(knownCodes, fault.providerCode)
      ? `服务代码 ${fault.providerCode}`
      : '';
  const parameter = knownParameters.find((p) => p === fault?.parameter);
  const fieldPath = realtimeFieldPath(fault?.fieldPath);
  const details = [
    detail,
    fieldPath ? `字段 ${fieldPath}` : parameter ? `参数 ${parameter}` : '',
  ]
    .filter(Boolean)
    .join('，');
  return messages[safeCode] + (details ? `（${details}）` : '');
}
