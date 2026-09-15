import {
  websocketSession,
  type RealtimeConfig,
  type RealtimeEvent,
} from './realtime-providers';
type Tools = Parameters<typeof websocketSession>[2];

/** Qwen server_vad: the server commits speech and creates its ordinary response. */
export class QwenLifecycle {
  readonly mode = 'server_vad' as const;
  private connection: 'connecting' | 'updating' | 'ready' | 'closed' =
    'connecting';
  private response: 'idle' | 'requested' | 'active' | 'cancel_pending' = 'idle';
  private responseId = '';
  private cancelSent = false;
  private terminalResponses = new Set<string>();
  private opened = false;
  private pendingPolicy: string | undefined;
  private updatePending = false;
  private responsePending: 'opening' | 'tool' | 'nudge' | undefined;
  private inputPending = false;
  private finishing = false;
  readonly updates = { sent: 0, accepted: 0, rejected: 0 };
  constructor(
    private config: RealtimeConfig,
    private instructions: string,
    private tools: Tools,
    private send: (event: unknown) => void,
    private opening = true,
  ) {}
  get ready() {
    return this.opened && this.connection !== 'closed';
  }
  get state() {
    return this.connection === 'closed'
      ? 'closed'
      : this.updatePending
        ? 'updating'
        : this.connection === 'ready'
          ? this.response
          : this.connection;
  }
  start() {
    if (this.connection !== 'connecting') return;
    this.connection = 'updating';
    this.updatePending = true;
    this.updates.sent++;
    this.send(websocketSession(this.config, this.instructions, this.tools));
  }
  policy(instructions: string) {
    if (this.connection === 'closed' || this.finishing) return;
    // Compare with the last submitted policy, including an update awaiting ACK.
    // A newest A must also remove an unsent B while the response is active.
    this.pendingPolicy =
      instructions === this.instructions ? undefined : instructions;
    this.flush();
  }
  private flush() {
    if (
      !this.ready ||
      this.updatePending ||
      this.finishing ||
      this.response !== 'idle'
    )
      return;
    if (this.pendingPolicy !== undefined) {
      this.instructions = this.pendingPolicy;
      this.pendingPolicy = undefined;
      this.updatePending = true;
      this.updates.sent++;
      this.send({
        type: 'session.update',
        event_id: crypto.randomUUID(),
        session: { instructions: this.instructions },
      });
    } else if (this.responsePending && !this.inputPending) {
      this.responsePending = undefined;
      this.response = 'requested';
      this.responseId = '';
      this.cancelSent = false;
      this.send({ type: 'response.create', event_id: crypto.randomUUID() });
    }
  }
  requestResponse(reason: 'opening' | 'tool' | 'nudge') {
    if (this.finishing || this.connection === 'closed') return;
    if (this.response !== 'idle') return;
    if (this.inputPending && reason !== 'tool') return;
    this.responsePending = reason;
    this.flush();
  }
  interrupt() {
    this.responsePending = undefined;
    if (!['requested', 'active'].includes(this.response)) return;
    this.response = 'cancel_pending';
    if (this.responseId) this.cancelResponse();
  }
  accept(event: RealtimeEvent) {
    if (this.connection === 'closed') return;
    if (event.type === 'session.updated' && this.updatePending) {
      this.updatePending = false;
      this.connection = 'ready';
      this.updates.accepted++;
      if (!this.opened) {
        this.opened = true;
        if (this.opening) this.requestResponse('opening');
      }
      this.flush();
    } else if (
      event.type === 'input_audio_buffer.speech_started' ||
      event.type === 'input_audio_buffer.committed'
    ) {
      this.inputPending = true;
      if (this.responsePending !== 'tool') this.responsePending = undefined;
    } else if (event.type === 'response.created') {
      const id = event.response_id ?? event.response?.id ?? '';
      if (id && this.terminalResponses.has(id)) return;
      // An automatic response already consumes the current conversation and tool output.
      // Do not replay a response request that was waiting for a configuration ACK.
      this.responsePending = undefined;
      this.inputPending = false;
      const cancelling =
        this.response === 'cancel_pending' &&
        (!this.responseId || !id || id === this.responseId);
      this.responseId = id;
      this.response = cancelling ? 'cancel_pending' : 'active';
      if (cancelling && !this.cancelSent) this.cancelResponse();
    } else if (event.type === 'response.done') {
      const id = event.response_id ?? event.response?.id;
      if (id && this.terminalResponses.has(id)) return;
      if (!id || !this.responseId || id === this.responseId) {
        this.rememberTerminal(id);
        this.response = 'idle';
        this.cancelSent = false;
        this.flush();
      }
    } else if (
      event.type === 'error' &&
      event.error?.code === 'response_cancel_not_active'
    ) {
      if (this.response === 'cancel_pending' && this.cancelSent) {
        this.rememberTerminal(this.responseId);
        this.response = 'idle';
        this.cancelSent = false;
        this.flush();
      }
    } else if (event.type === 'error' && this.updatePending) {
      this.updates.rejected++;
    }
  }
  private cancelResponse() {
    this.cancelSent = true;
    this.send({ type: 'response.cancel', event_id: crypto.randomUUID() });
  }
  private rememberTerminal(id?: string) {
    if (id) this.terminalResponses.add(id);
    if (this.terminalResponses.size > 64)
      this.terminalResponses.delete(
        this.terminalResponses.values().next().value!,
      );
  }
  finish() {
    this.finishing = true;
    this.pendingPolicy = undefined;
    this.responsePending = undefined;
    this.interrupt();
  }
  close() {
    this.finishing = true;
    this.pendingPolicy = undefined;
    this.responsePending = undefined;
    this.connection = 'closed';
  }
}
