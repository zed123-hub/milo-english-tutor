import type { RealtimeEvent } from './realtime-providers';
import type { RealtimeFault } from './realtime-errors';

type Command = {
  type: string;
  session?: { type?: string; instructions?: string };
  [key: string]: unknown;
};
/** OpenAI GA WebRTC: server VAD owns ordinary user-turn commits and responses. */
export class OpenAILifecycle {
  readonly mode = 'server_vad' as const;
  private connected = false;
  private closed = false;
  private response: 'idle' | 'requested' | 'responding' | 'cancel_pending' =
    'idle';
  private responseId = '';
  private cancelSent = false;
  private terminalResponses = new Set<string>();
  private updateId = '';
  private queuedPolicy: string | undefined;
  private submittedPolicy = '';
  private rejectedPolicy = '';
  private acceptedPolicy = '';
  private requested = new Map<string, { type: string; fields: string[] }>();
  readonly updates = { sent: 0, accepted: 0, rejected: 0 };
  lastRejected?: RealtimeFault;
  constructor(private send: (event: Command) => void) {}
  get state() {
    return this.closed
      ? 'closed'
      : !this.connected
        ? 'awaiting_session_created'
        : this.updateId
          ? 'updating_session'
          : this.response;
  }
  private write(event: Command, fields: string[] = []) {
    const id = crypto.randomUUID();
    this.requested.set(id, { type: event.type, fields });
    while (this.requested.size > 64)
      this.requested.delete(this.requested.keys().next().value!);
    this.send({ ...event, event_id: id });
    return id;
  }
  policy(instructions: string) {
    if (
      this.closed ||
      (!this.updateId && instructions === this.acceptedPolicy) ||
      instructions === this.rejectedPolicy
    )
      return;
    this.queuedPolicy = instructions;
    this.flushPolicy();
  }
  private flushPolicy() {
    if (
      !this.connected ||
      this.closed ||
      this.updateId ||
      this.queuedPolicy === undefined
    )
      return;
    this.submittedPolicy = this.queuedPolicy;
    this.queuedPolicy = undefined;
    // model, voice, speed, formats, VAD and tools never enter a TutorPolicy patch.
    this.updateId = this.write(
      {
        type: 'session.update',
        session: { type: 'realtime', instructions: this.submittedPolicy },
      },
      ['session.type', 'session.instructions'],
    );
    this.updates.sent++;
  }
  command(event: Command) {
    if (this.closed) return;
    if (event.type === 'session.update') {
      if (typeof event.session?.instructions === 'string')
        this.policy(event.session.instructions);
      return;
    }
    if (!this.connected) return;
    if (event.type === 'response.create') {
      if (this.response !== 'idle') return;
      this.response = 'requested';
      this.responseId = '';
      this.cancelSent = false;
      this.write(event);
    } else if (event.type === 'response.cancel') {
      if (!['requested', 'responding'].includes(this.response)) return;
      this.response = 'cancel_pending';
      if (this.responseId) this.cancelResponse();
    } else if (
      ['output_audio_buffer.clear', 'conversation.item.create'].includes(
        event.type,
      )
    )
      this.write(event);
    // No input_audio_buffer.commit in OpenAI's automatic server-VAD mode.
  }
  accept(event: RealtimeEvent, errorEventId?: string): RealtimeEvent | null {
    if (this.closed) return null;
    const id = event.response_id ?? event.response?.id;
    const normalized = id ? { ...event, response_id: id } : event;
    if (event.type === 'session.created' && !this.connected) {
      this.connected = true;
      this.command({ type: 'response.create' });
      this.flushPolicy();
    } else if (event.type === 'session.updated' && this.updateId) {
      this.updateId = '';
      this.acceptedPolicy = this.submittedPolicy;
      this.updates.accepted++;
      this.flushPolicy();
    } else if (event.type === 'response.created') {
      if (id && this.terminalResponses.has(id)) return null;
      const cancelling =
        this.response === 'cancel_pending' &&
        (!this.responseId || !id || id === this.responseId);
      this.responseId = id ?? '';
      this.response = cancelling ? 'cancel_pending' : 'responding';
      if (cancelling && !this.cancelSent) this.cancelResponse();
    } else if (
      event.type === 'response.done' &&
      !(id && this.terminalResponses.has(id)) &&
      (!id || !this.responseId || id === this.responseId)
    ) {
      this.rememberTerminal(id);
      this.response = 'idle';
      this.cancelSent = false;
    } else if (
      event.type === 'error' &&
      event.error?.code === 'response_cancel_not_active'
    ) {
      if (this.response === 'cancel_pending' && this.cancelSent) {
        this.rememberTerminal(this.responseId);
        this.response = 'idle';
        this.cancelSent = false;
      }
    } else if (
      event.type === 'error' &&
      this.updateId &&
      errorEventId === this.updateId
    ) {
      this.lastRejected = event.error;
      this.rejectedPolicy = this.submittedPolicy;
      this.updateId = '';
      this.updates.rejected++;
      this.flushPolicy();
      return null;
    }
    return normalized;
  }
  private cancelResponse() {
    this.cancelSent = true;
    this.write({ type: 'response.cancel' });
  }
  private rememberTerminal(id?: string) {
    if (id) this.terminalResponses.add(id);
    if (this.terminalResponses.size > 64)
      this.terminalResponses.delete(
        this.terminalResponses.values().next().value!,
      );
  }
  errorContext(eventId?: string) {
    return eventId ? this.requested.get(eventId) : undefined;
  }
  close() {
    this.closed = true;
    this.queuedPolicy = undefined;
    this.requested.clear();
  }
}
