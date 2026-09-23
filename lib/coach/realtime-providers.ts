import { normalizeRealtimeUsage } from './realtime-usage';
import {
  realtimeFault,
  realtimeResponseFault,
  type RealtimeFault,
} from './realtime-errors';
export type RealtimeProvider = 'openai' | 'qwen' | 'glm';
export type RealtimeOptions = {
  realtimeProvider?: RealtimeProvider;
  realtimeModel: string;
  realtimeBaseUrl?: string;
  realtimeVoice?: string;
};
export const realtimeProviders = {
  openai: {
    name: 'OpenAI',
    model: 'gpt-realtime-2.1-mini',
    voice: 'marin',
    endpoint: 'https://api.openai.com/v1/realtime/calls',
    inputRate: 24000,
  },
  qwen: {
    name: '千问 Qwen',
    model: 'qwen3.5-omni-flash-realtime',
    voice: 'Ethan',
    endpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
    inputRate: 16000,
  },
  glm: {
    name: '智谱 GLM',
    model: 'glm-realtime-air',
    voice: 'tongtong',
    endpoint: 'wss://open.bigmodel.cn/api/paas/v4/realtime',
    inputRate: 24000,
  },
} as const;
export function realtimeConfig(options: RealtimeOptions) {
  const provider = options.realtimeProvider ?? 'openai';
  if (!Object.hasOwn(realtimeProviders, provider)) throw Error('INVALID_BODY');
  const preset = realtimeProviders[provider];
  const model = options.realtimeModel;
  if (typeof model !== 'string' || !/^[-\w./:]{1,150}$/.test(model))
    throw Error('INVALID_BODY');
  if (
    provider === 'qwen' &&
    !/^qwen3\.5-omni-(?:flash|plus)-realtime(?:-\d{4}-\d{2}-\d{2})?$/.test(
      model,
    )
  )
    throw Error('REALTIME_MODEL');
  if (provider === 'glm' && !/^glm-realtime(?:-air|-flash)?$/.test(model))
    throw Error('REALTIME_MODEL');
  const endpoint = options.realtimeBaseUrl || preset.endpoint;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw Error('MODEL_ENDPOINT');
  }
  if (url.username || url.password || url.port || url.search || url.hash)
    throw Error('MODEL_ENDPOINT');
  if (provider === 'qwen') {
    if (
      url.protocol !== 'wss:' ||
      url.pathname !== '/api-ws/v1/realtime' ||
      !(
        /^(?:dashscope|dashscope-intl)\.aliyuncs\.com$/.test(url.hostname) ||
        /^[a-z0-9-]+\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(
          url.hostname,
        )
      )
    )
      throw Error('MODEL_ENDPOINT');
  } else if (url.href !== preset.endpoint) throw Error('MODEL_ENDPOINT');
  const voice = options.realtimeVoice || preset.voice;
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,59}$/.test(voice)) throw Error('INVALID_BODY');
  return {
    provider,
    model,
    voice,
    endpoint: url.href,
    inputRate: preset.inputRate,
    outputRate: 24000,
  };
}
export type RealtimeConfig = ReturnType<typeof realtimeConfig>;
type Tool = {
  type: string;
  name: string;
  description: string;
  parameters: unknown;
};
export function websocketSession(
  config: RealtimeConfig,
  instructions: string,
  tools: Tool[],
) {
  if (config.provider === 'openai') throw Error('INVALID_ACTION');
  const common = {
    model: config.model,
    instructions,
    modalities: ['text', 'audio'],
    voice: config.voice,
  };
  return {
    type: 'session.update',
    event_id: crypto.randomUUID(),
    ...(config.provider === 'glm' ? { client_timestamp: Date.now() } : {}),
    session:
      config.provider === 'qwen'
        ? {
            ...common,
            audio: {
              input: { format: { type: 'pcm', sample_rate: 16000 } },
              output: { format: { type: 'pcm', sample_rate: 24000 } },
            },
            input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              silence_duration_ms: 800,
            },
            tools: tools.map(({ type, ...fn }) => ({ type, function: fn })),
          }
        : {
            ...common,
            input_audio_format: 'pcm24',
            output_audio_format: 'pcm',
            turn_detection: {
              type: 'client_vad',
            },
            tools: tools.map((tool) => {
              if (tool.name === 'record_hint')
                return {
                  ...tool,
                  parameters: {
                    ...(tool.parameters as Record<string, unknown>),
                    properties: {
                      level: {
                        type: 'integer',
                        enum: [1, 2, 3],
                        description:
                          '1 direction; 2 keyword; 3 requested answer.',
                      },
                    },
                  },
                };
              // Avoid GLM's reported empty object/array schema validation failure.
              if (tool.name === 'end_conversation')
                return {
                  ...tool,
                  parameters: {
                    type: 'object',
                    properties: {
                      reason: {
                        type: 'string',
                        description: 'The learner asked to stop.',
                      },
                    },
                    required: ['reason'],
                    additionalProperties: false,
                  },
                };
              if (tool.name === 'checkpoint')
                return {
                  ...tool,
                  parameters: {
                    ...(tool.parameters as Record<string, unknown>),
                    required: ['focus', 'reason'],
                  },
                };
              return tool;
            }),
            beta_fields: {
              chat_mode: 'audio',
              tts_source: 'e2e',
              auto_search: false,
              greeting_config: {
                enable: false,
                // GLM previously accepted this field even when the greeting was
                // disabled; keep a non-spoken compatibility value.
                content: 'Hello.',
              },
            },
          },
  };
}
export type RealtimeEvent = {
  type: string;
  response_id?: string;
  item_id?: string;
  transcript?: string;
  delta?: string;
  name?: string;
  call_id?: string;
  output_index?: number;
  arguments?: string;
  error?: RealtimeFault;
  response?: {
    id?: string;
    status: string;
    usage?: unknown;
    error?: RealtimeFault;
    status_details?: unknown;
    output?: {
      type: string;
      name: string;
      call_id: string;
      arguments: string;
    }[];
  };
};
/** Discard provider internals; translate only the voice and public tool protocol. */
export class RealtimeEvents {
  private responseId = '';
  private tools = new Map<
    string,
    NonNullable<NonNullable<RealtimeEvent['response']>['output']>
  >();
  private terminal = new Map<string, { status: string; calls: Set<string> }>();
  private callIndices = new Map<string, Map<string, string>>();
  private providerCallIds = new Map<string, string>();
  constructor(private provider: RealtimeProvider) {}
  private callId(
    response: string,
    name: string,
    callId?: string,
    index?: number,
  ) {
    if (index === undefined && callId) return callId;
    index ??= 0;
    if (!Number.isInteger(index) || index < 0 || index > 23)
      throw Error('MODEL_OUTPUT');
    const fallback = `milo-${response}-${name}-${index}`;
    if (this.provider !== 'glm') return callId || fallback;
    const indices = this.callIndices.get(response) ?? new Map<string, string>();
    const slot = `${index}:${name}`;
    const canonical = indices.get(slot) ?? (callId || fallback);
    indices.set(slot, canonical);
    this.callIndices.set(response, indices);
    if (callId) this.providerCallIds.set(canonical, callId);
    while (this.callIndices.size > 64)
      this.callIndices.delete(this.callIndices.keys().next().value!);
    while (this.providerCallIds.size > 256)
      this.providerCallIds.delete(this.providerCallIds.keys().next().value!);
    return canonical;
  }
  normalize(
    raw: Omit<RealtimeEvent, 'error'> & { error?: unknown },
  ): RealtimeEvent | null {
    if (typeof raw?.type !== 'string') return null;
    if (raw.type === 'error')
      return {
        type: 'error',
        error: realtimeFault(raw.error),
      };
    if (raw.response_id || raw.response?.id)
      this.responseId = raw.response_id ?? raw.response!.id!;
    const responseId = raw.response_id ?? raw.response?.id ?? this.responseId;
    if (raw.type === 'response.function_call_arguments.done') {
      if (
        !['checkpoint', 'record_hint', 'end_conversation'].includes(
          raw.name ?? '',
        ) ||
        typeof raw.arguments !== 'string' ||
        raw.arguments.length > 5000
      )
        throw Error('MODEL_OUTPUT');
      const calls = this.tools.get(responseId) ?? [];
      const id = this.callId(
        responseId,
        raw.name!,
        raw.call_id,
        raw.output_index,
      );
      const call = {
        type: 'function_call',
        name: raw.name!,
        call_id: id,
        arguments: raw.arguments,
      };
      // GLM does not order different event types. Tool arguments can arrive
      // after response.done, so completion must not strand the tool result.
      const terminal = this.terminal.get(responseId);
      if (this.provider === 'glm' && terminal) {
        if (terminal.status !== 'completed' || terminal.calls.has(id))
          return null;
        terminal.calls.add(id);
        return {
          type: 'response.done',
          response_id: responseId,
          response: { id: responseId, status: 'completed', output: [call] },
        };
      }
      if (!calls.some((c) => c.call_id === id)) calls.push(call);
      this.tools.set(responseId, calls);
      if (this.tools.size > 16) throw Error('MODEL_OUTPUT');
      return null;
    }
    if (raw.type === 'response.done' || raw.type === 'response.cancelled') {
      let calls = [...(this.tools.get(responseId) ?? [])];
      // Some services deliver only a subset in arguments.done before response.done.
      // Merge both carriers; preserve separate calls to the same tool by output index.
      raw.response?.output?.forEach((call, index) => {
        if (call.type !== 'function_call' || typeof call.arguments !== 'string')
          return;
        if (
          !['checkpoint', 'record_hint', 'end_conversation'].includes(
            call.name,
          ) ||
          call.arguments.length > 5000
        )
          throw Error('MODEL_OUTPUT');
        const id = this.callId(responseId, call.name, call.call_id, index);
        if (!calls.some((c) => c.call_id === id))
          calls.push({
            type: 'function_call',
            name: call.name,
            arguments: call.arguments,
            call_id: id,
          });
      });
      this.tools.delete(responseId);
      let status =
        raw.type === 'response.cancelled'
          ? 'cancelled'
          : (raw.response?.status ?? 'completed');
      if (this.provider === 'glm') {
        const previous = this.terminal.get(responseId);
        if (previous && previous.status !== 'completed')
          status = previous.status;
        const seen = previous?.calls ?? new Set<string>();
        calls =
          status === 'completed'
            ? calls.filter((call) => {
                if (seen.has(call.call_id)) return false;
                seen.add(call.call_id);
                return true;
              })
            : [];
        this.terminal.set(responseId, { status, calls: seen });
        while (this.terminal.size > 64)
          this.terminal.delete(this.terminal.keys().next().value!);
      }
      const fault = realtimeResponseFault(raw.response);
      return {
        type: 'response.done',
        response_id: responseId,
        response: {
          id: responseId,
          status,
          output: calls,
          ...(fault ? { error: fault } : {}),
          ...(raw.response?.usage
            ? {
                usage: normalizeRealtimeUsage(
                  this.provider,
                  raw.response.usage,
                ),
              }
            : {}),
        },
      };
    }
    const type = raw.type
      .replace(
        /^response\.audio_transcript\./,
        'response.output_audio_transcript.',
      )
      .replace(/^response\.audio\./, 'response.output_audio.');
    if (
      !/^(session\.(created|updated)|response\.(created|output_audio\.(delta|done)|output_audio_transcript\.(delta|done))|input_audio_buffer\.(speech_started|speech_stopped|committed)|conversation\.item\.input_audio_transcription\.(completed|failed))$/.test(
        type,
      )
    )
      return null;
    return {
      type,
      ...(type.startsWith('response.')
        ? {
            response_id: responseId,
            item_id: raw.item_id ?? `audio-${responseId}`,
          }
        : { item_id: raw.item_id }),
      ...(typeof raw.delta === 'string' ? { delta: raw.delta } : {}),
      ...(typeof raw.transcript === 'string'
        ? { transcript: raw.transcript }
        : {}),
    };
  }
  toolResult(callId: string, output: string) {
    const providerId =
      this.providerCallIds.get(callId) ??
      (this.provider === 'glm' && callId.startsWith('milo-')
        ? undefined
        : callId);
    return {
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        ...(this.provider === 'glm' ? { object: 'realtime.item' } : {}),
        ...(providerId ? { call_id: providerId } : {}),
        output,
      },
    };
  }
}
