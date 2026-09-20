import {
  realtimeFieldPath,
  safeRealtimeFault,
  realtimeResponseFault,
  type RealtimeFault,
} from './realtime-errors';
import type { RealtimeEvent, RealtimeProvider } from './realtime-providers';
import {
  normalizeRealtimeUsage,
  realtimeUsageFields,
  safeRealtimeUsage,
  safeRealtimeUsageDiagnostic,
  type RealtimeUsageDiagnostic,
} from './realtime-usage';

const states = [
  'connecting',
  'awaiting_session_created',
  'updating_session',
  'updating',
  'ready',
  'idle',
  'requested',
  'responding',
  'active',
  'cancel_pending',
  'closed',
  'error',
] as const;
const names = [
  'connected',
  'session_update_sent',
  'session_update_accepted',
  'session_update_rejected',
  'speech_start',
  'speech_end',
  'client_commit',
  'server_commit',
  'user_transcript_completed',
  'response_requested',
  'response_created',
  'first_audio',
  'response_done',
  'response_cancel',
  'output_audio_clear',
  'tool_arguments_rejected',
  'context_rotated',
  'error',
  'closed',
] as const;
type Milestone = (typeof names)[number];
const counters = [
  'audioFramesSent',
  'audioPacketsSent',
  'audioBytesSent',
  'sessionUpdatesSent',
  'sessionUpdatesAccepted',
  'sessionUpdatesRejected',
  'speechStarts',
  'speechEnds',
  'clientCommits',
  'serverCommits',
  'userTranscriptsCompleted',
  'responsesRequested',
  'responsesCreated',
  'firstAudio',
  'responsesDone',
  'toolArgumentsRejected',
  'contextRotations',
] as const;
type Counts = Record<(typeof counters)[number], number>;
export type RealtimeDiagnostic = {
  version: 1;
  provider: RealtimeProvider;
  transport: 'webrtc' | 'websocket';
  mode: 'server_vad' | 'client_vad';
  state: (typeof states)[number];
  startedAt: number;
  stable: false;
  counts: Counts;
  milestones: { ms: number; event: Milestone; response?: number }[];
  usage?: RealtimeUsageDiagnostic;
  error?: RealtimeFault;
  rejectedFields?: string[];
  closeCategory?:
    | 'local_stop'
    | 'upstream_close'
    | 'transport_error'
    | 'protocol_error';
};
const number = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0
    ? Math.min(Math.floor(v), Number.MAX_SAFE_INTEGER)
    : 0;
/** Only a fixed diagnostic schema can be written to disk. No text/audio/event IDs. */
export function safeRealtimeDiagnostic(value: unknown): RealtimeDiagnostic {
  if (!value || typeof value !== 'object') throw Error('INVALID_BODY');
  const v = value as RealtimeDiagnostic;
  if (!['openai', 'qwen', 'glm'].includes(v.provider))
    throw Error('INVALID_BODY');
  const counts = Object.fromEntries(
    counters.map((k) => [k, number(v.counts?.[k])]),
  ) as Counts;
  const usage = safeRealtimeUsageDiagnostic(v.usage);
  return {
    version: 1,
    provider: v.provider,
    transport: v.provider === 'openai' ? 'webrtc' : 'websocket',
    mode: v.provider === 'glm' ? 'client_vad' : 'server_vad',
    state: states.includes(v.state) ? v.state : 'error',
    startedAt: number(v.startedAt),
    stable: false,
    counts,
    milestones: (Array.isArray(v.milestones) ? v.milestones : [])
      .slice(-600)
      .flatMap((m) =>
        m && names.includes(m.event)
          ? [
              {
                ms: number(m.ms),
                event: m.event,
                ...(typeof m.response === 'number'
                  ? { response: number(m.response) }
                  : {}),
              },
            ]
          : [],
      ),
    ...(usage ? { usage } : {}),
    ...(v.error ? { error: safeRealtimeFault(v.error) } : {}),
    ...(Array.isArray(v.rejectedFields)
      ? {
          rejectedFields: v.rejectedFields.slice(0, 30).flatMap((f) => {
            const p = realtimeFieldPath(f);
            return p ? [p] : [];
          }),
        }
      : {}),
    ...([
      'local_stop',
      'upstream_close',
      'transport_error',
      'protocol_error',
    ].includes(v.closeCategory ?? '')
      ? { closeCategory: v.closeCategory }
      : {}),
  };
}

export class RealtimeDiagnostics {
  private data: RealtimeDiagnostic;
  private responses = new Map<
    string,
    { number: number; audio: boolean; created: boolean; done: boolean }
  >();
  private sequence = 0;
  private latestResponse = '';
  private usageResponses = new Set<string>();
  constructor(provider: RealtimeProvider) {
    this.data = safeRealtimeDiagnostic({
      provider,
      state: 'connecting',
      startedAt: Date.now(),
    });
  }
  state(state: string) {
    if (this.data.closeCategory) return;
    if (states.includes(state as RealtimeDiagnostic['state']))
      this.data.state = state as RealtimeDiagnostic['state'];
  }
  private mark(event: Milestone, response?: number) {
    this.data.milestones.push({
      ms: Math.max(0, Date.now() - this.data.startedAt),
      event,
      ...(response ? { response } : {}),
    });
    if (this.data.milestones.length > 600) this.data.milestones.shift();
  }
  sent(type: string, bytes = 0) {
    const c = this.data.counts;
    if (type === 'input_audio_buffer.append') {
      c.audioFramesSent++;
      c.audioBytesSent += bytes;
    } else if (type === 'session.update') {
      c.sessionUpdatesSent++;
      this.mark('session_update_sent');
    } else if (type === 'input_audio_buffer.commit') {
      c.clientCommits++;
      this.mark('client_commit');
    } else if (type === 'response.create') {
      c.responsesRequested++;
      this.mark('response_requested');
    } else if (type === 'response.cancel') this.mark('response_cancel');
    else if (type === 'output_audio_buffer.clear')
      this.mark('output_audio_clear');
  }
  contextRotation() {
    this.data.counts.contextRotations++;
    this.mark('context_rotated');
  }
  rtp(packets: number, bytes: number) {
    this.data.counts.audioPacketsSent = Math.max(
      this.data.counts.audioPacketsSent,
      number(packets),
    );
    this.data.counts.audioBytesSent = Math.max(
      this.data.counts.audioBytesSent,
      number(bytes),
    );
  }
  event(event: RealtimeEvent) {
    if (this.data.closeCategory) return;
    const c = this.data.counts;
    if (event.type === 'response.done') {
      const fault = realtimeResponseFault(event.response);
      if (fault) this.fault(fault);
    }
    if (event.type === 'session.created') {
      this.mark('connected');
    } else if (event.type === 'session.updated') {
      if (
        c.sessionUpdatesAccepted + c.sessionUpdatesRejected <
        c.sessionUpdatesSent
      ) {
        c.sessionUpdatesAccepted++;
        this.mark('session_update_accepted');
      }
    } else if (event.type === 'input_audio_buffer.speech_started') {
      c.speechStarts++;
      this.mark('speech_start');
    } else if (event.type === 'input_audio_buffer.speech_stopped') {
      c.speechEnds++;
      this.mark('speech_end');
    } else if (event.type === 'input_audio_buffer.committed') {
      c.serverCommits++;
      this.mark('server_commit');
    } else if (
      event.type === 'conversation.item.input_audio_transcription.completed'
    ) {
      c.userTranscriptsCompleted++;
      this.mark('user_transcript_completed');
    }
    const id =
      event.response_id ??
      event.response?.id ??
      (event.type === 'output_audio_buffer.started' ? this.latestResponse : '');
    if (!id) return;
    let response = this.responses.get(id);
    if (!response) {
      response = {
        number: ++this.sequence,
        audio: false,
        created: false,
        done: false,
      };
      this.responses.set(id, response);
      if (this.responses.size > 64)
        this.responses.delete(this.responses.keys().next().value!);
    }
    if (event.type === 'response.done')
      this.recordUsage(id, response.number, event.response?.usage);
    if (event.type === 'response.created' && !response.created) {
      response.created = true;
      this.latestResponse = id;
      c.responsesCreated++;
      this.mark('response_created', response.number);
    } else if (
      [
        'response.audio.delta',
        'response.output_audio.delta',
        'output_audio_buffer.started',
      ].includes(event.type) &&
      !response.audio
    ) {
      response.audio = true;
      c.firstAudio++;
      this.mark('first_audio', response.number);
    } else if (event.type === 'response.done' && !response.done) {
      response.done = true;
      c.responsesDone++;
      this.mark('response_done', response.number);
    }
  }
  private recordUsage(id: string, response: number, value: unknown) {
    if (
      typeof id !== 'string' ||
      !id.length ||
      id.length > 256 ||
      this.usageResponses.has(id) ||
      // Stop collecting at the bound instead of evicting IDs and counting replays.
      this.usageResponses.size >= 4096
    )
      return;
    const usage =
      safeRealtimeUsage(value) ??
      normalizeRealtimeUsage(this.data.provider, value);
    if (!usage) return;
    this.usageResponses.add(id);
    const data = (this.data.usage ??= {
      responses: 0,
      totals: {},
      reports: {},
      samples: [],
    });
    data.responses++;
    for (const key of realtimeUsageFields) {
      const n = usage[key];
      if (n === undefined) continue;
      data.totals[key] = Math.min(
        Number.MAX_SAFE_INTEGER,
        (data.totals[key] ?? 0) + n,
      );
      data.reports[key] = (data.reports[key] ?? 0) + 1;
    }
    data.latest = {
      response,
      ms: Math.max(0, Date.now() - this.data.startedAt),
      ...usage,
    };
    data.samples.push(data.latest);
    if (data.samples.length > 64) data.samples.shift();
  }
  fault(error: RealtimeFault, rejected = false, fields?: string[]) {
    // A completed response can win a cancellation race; the session stays usable.
    if (error.code === 'response_cancel_not_active') return;
    this.data.error = safeRealtimeFault(error);
    if (rejected) {
      this.data.counts.sessionUpdatesRejected++;
      this.mark('session_update_rejected');
    } else this.mark('error');
    if (fields)
      this.data.rejectedFields = fields.flatMap((f) => {
        const path = realtimeFieldPath(f);
        return path ? [path] : [];
      });
  }
  toolRejected() {
    this.data.counts.toolArgumentsRejected++;
    this.mark('tool_arguments_rejected');
  }
  close(category: NonNullable<RealtimeDiagnostic['closeCategory']>) {
    this.data.closeCategory ??= category;
    this.data.state = ['transport_error', 'protocol_error'].includes(
      this.data.closeCategory,
    )
      ? 'error'
      : 'closed';
    this.mark('closed');
    this.responses.clear();
    this.usageResponses.clear();
  }
  snapshot() {
    return safeRealtimeDiagnostic(this.data);
  }
}
