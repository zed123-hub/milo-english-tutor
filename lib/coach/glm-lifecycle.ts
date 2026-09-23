import {
  websocketSession,
  type RealtimeConfig,
  type RealtimeEvent,
} from './realtime-providers';
type Tools = Parameters<typeof websocketSession>[2];

/** GLM client_vad: explicit audio commit precedes one response request. */
export class GLMLifecycle {
  readonly mode = 'client_vad' as const;
  private connection:
    | 'awaiting_session_created'
    | 'updating'
    | 'ready'
    | 'closed' = 'awaiting_session_created';
  private response: 'idle' | 'requested' | 'active' | 'cancel_pending' = 'idle';
  private responseId = '';
  private cancelSent = false;
  private audioStarted = false;
  private cancelErrorHandled = false;
  private lateCancelError = false;
  private terminalResponses = new Set<string>();
  private configured = false;
  private nextPolicy: string | undefined;
  private nextResponse = false;
  private finishing = false;
  private updatePending = false;
  readonly updates = { sent: 0, accepted: 0, rejected: 0 };
  constructor(
    private config: RealtimeConfig,
    private instructions: string,
    private tools: Tools,
    private send: (event: unknown) => void,
    private opening = true,
  ) {}
  get ready() {
    return this.configured && this.connection !== 'closed';
  }
  get state() {
    return this.connection === 'ready' ? this.response : this.connection;
  }
  recoverCancelError(code?: string) {
    if (code !== 'model_query_error' || this.connection !== 'ready')
      return false;
    if (
      this.response === 'cancel_pending' &&
      this.cancelSent &&
      !this.cancelErrorHandled
    ) {
      this.cancelErrorHandled = true;
      return true;
    }
    // GLM may deliver response.done before the error for that cancellation.
    // Only consume one late error before a different response is created.
    if (this.lateCancelError) {
      this.lateCancelError = false;
      return true;
    }
    return false;
  }
  private configure() {
    this.connection = 'updating';
    this.updatePending = true;
    this.updates.sent++;
    this.send(websocketSession(this.config, this.instructions, this.tools));
  }
  policy(instructions: string) {
    if (this.finishing || this.connection === 'closed') return;
    // Full GLM configuration updates are unnecessary when instructions match.
    // Preserve a return to A while submitted B is still awaiting its ACK.
    this.nextPolicy =
      instructions === this.instructions ? undefined : instructions;
    this.flush();
  }
  private flush() {
    if (
      !this.configured ||
      this.updatePending ||
      this.finishing ||
      this.response !== 'idle'
    )
      return;
    if (this.nextPolicy !== undefined) {
      this.instructions = this.nextPolicy;
      this.nextPolicy = undefined;
      this.configure();
    } else if (this.nextResponse) {
      this.nextResponse = false;
      this.response = 'requested';
      this.responseId = '';
      this.cancelSent = false;
      this.audioStarted = false;
      this.cancelErrorHandled = false;
      this.send({ type: 'response.create', event_id: crypto.randomUUID() });
    }
  }
  requestResponse(reason: 'input' | 'tool' | 'nudge') {
    if (this.finishing || this.connection === 'closed') return;
    if (reason !== 'input' && this.response !== 'idle') return;
    if (reason === 'input' && this.response === 'requested') return;
    this.nextResponse = true;
    this.flush();
  }
  interrupt() {
    this.nextResponse = false;
    if (!['requested', 'active'].includes(this.response)) return;
    this.response = 'cancel_pending';
    // GLM's reference client cancels only after actual assistant audio starts.
    // A response.created event alone may still be in model setup.
    if (this.responseId && this.audioStarted) this.cancelResponse();
  }
  accept(event: RealtimeEvent) {
    if (this.connection === 'closed') return;
    if (
      event.type === 'session.created' &&
      this.connection === 'awaiting_session_created'
    )
      this.configure();
    else if (event.type === 'session.updated' && this.updatePending) {
      const initial = !this.configured;
      this.configured = true;
      this.updatePending = false;
      this.connection = 'ready';
      this.updates.accepted++;
      // With GLM's canned greeting disabled, initiate exactly one model-written
      // opening after the first accepted session; refreshes never speak first.
      if (initial && this.opening) this.nextResponse = true;
      this.flush();
    } else if (event.type === 'response.created') {
      const id = event.response_id ?? event.response?.id ?? '';
      if (id && this.terminalResponses.has(id)) return;
      this.lateCancelError = false;
      if (id !== this.responseId) this.audioStarted = false;
      const cancelling =
        this.response === 'cancel_pending' &&
        (!this.responseId || !id || id === this.responseId);
      this.responseId = id;
      this.response = cancelling ? 'cancel_pending' : 'active';
      if (cancelling && this.audioStarted && !this.cancelSent)
        this.cancelResponse();
    } else if (event.type === 'response.output_audio.delta') {
      const id = event.response_id;
      // GLM does not order audio and response.created against each other.
      // Remember early audio so speech can cancel that same response once.
      if (
        id &&
        !this.terminalResponses.has(id) &&
        this.response !== 'idle' &&
        (!this.responseId || id === this.responseId)
      ) {
        this.lateCancelError = false;
        this.responseId = id;
        this.audioStarted = true;
        if (this.response === 'cancel_pending' && !this.cancelSent)
          this.cancelResponse();
      }
    } else if (event.type === 'response.done') {
      const id = event.response_id ?? event.response?.id;
      if (id && this.terminalResponses.has(id)) return;
      if (!id || !this.responseId || id === this.responseId) {
        this.lateCancelError =
          this.cancelSent &&
          !this.cancelErrorHandled &&
          event.response?.status === 'cancelled';
        this.rememberTerminal(id);
        this.response = 'idle';
        this.cancelSent = false;
        this.audioStarted = false;
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
        this.audioStarted = false;
        this.lateCancelError = false;
        this.flush();
      }
    } else if (event.type === 'error' && this.updatePending)
      this.updates.rejected++;
  }
  private cancelResponse() {
    this.cancelSent = true;
    this.send({
      type: 'response.cancel',
      event_id: crypto.randomUUID(),
      client_timestamp: Date.now(),
    });
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
    this.nextPolicy = undefined;
    this.nextResponse = false;
    this.interrupt();
  }
  close() {
    this.finishing = true;
    this.nextPolicy = undefined;
    this.nextResponse = false;
    this.lateCancelError = false;
    this.connection = 'closed';
  }
}
