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
  private configure(opening: boolean) {
    this.connection = 'updating';
    this.updatePending = true;
    this.updates.sent++;
    this.send(
      websocketSession(
        this.config,
        this.instructions,
        this.tools,
        opening ? 'opening' : 'refresh',
      ),
    );
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
      this.configure(false);
    } else if (this.nextResponse) {
      this.nextResponse = false;
      this.response = 'requested';
      this.responseId = '';
      this.cancelSent = false;
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
    if (this.responseId) this.cancelResponse();
  }
  accept(event: RealtimeEvent) {
    if (this.connection === 'closed') return;
    if (
      event.type === 'session.created' &&
      this.connection === 'awaiting_session_created'
    )
      this.configure(this.opening);
    else if (event.type === 'session.updated' && this.updatePending) {
      this.configured = true;
      this.updatePending = false;
      this.connection = 'ready';
      this.updates.accepted++;
      this.flush();
    } else if (event.type === 'response.created') {
      const id = event.response_id ?? event.response?.id ?? '';
      if (id && this.terminalResponses.has(id)) return;
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
    } else if (event.type === 'error' && this.updatePending)
      this.updates.rejected++;
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
    this.nextPolicy = undefined;
    this.nextResponse = false;
    this.interrupt();
  }
  close() {
    this.finishing = true;
    this.nextPolicy = undefined;
    this.nextResponse = false;
    this.connection = 'closed';
  }
}
