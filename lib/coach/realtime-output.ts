type Socket = {
  readyState: number;
  bufferedAmount: number;
  send: (data: string, callback: (error?: Error) => void) => void;
};
export const REALTIME_OUTPUT_MAX_BYTES = 1024 * 1024;

/** Ordered, bounded output for temporary upstream congestion. No payload logging. */
export class RealtimeOutput {
  private queue: {
    type?: string;
    text: string;
    bytes: number;
    audioBytes: number;
  }[] = [];
  private bytes = 0;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastSentAt = -Infinity;
  constructor(
    private socket: Socket,
    private fail: (code: string) => void,
    private measure: (buffered: number, queued: number) => void,
    private now = () => performance.now(),
    private minimumIntervalMs = 0,
    private onSent: (type: string, audioBytes: number) => void = () => {},
  ) {}
  send(value: unknown) {
    if (this.closed) return;
    if (this.socket.readyState !== 1) throw Error('REALTIME_CONNECTION');
    const text = JSON.stringify(value);
    const type = (value as { type?: string } | null)?.type;
    if (type === 'response.cancel') this.cancelResponses();
    const bytes = new TextEncoder().encode(text).byteLength;
    if (
      this.bytes + bytes + this.socket.bufferedAmount >
      REALTIME_OUTPUT_MAX_BYTES
    )
      throw Error('REALTIME_BACKPRESSURE');
    const audio = (value as { audio?: unknown } | null)?.audio;
    const audioBytes =
      type === 'input_audio_buffer.append' && typeof audio === 'string'
        ? Math.floor((audio.replace(/=+$/, '').length * 3) / 4)
        : 0;
    this.queue.push({ type, text, bytes, audioBytes });
    this.bytes += bytes;
    this.flush();
  }
  get idle() {
    return (
      !this.closed && !this.queue.length && this.socket.bufferedAmount === 0
    );
  }
  cancelResponses() {
    this.queue = this.queue.filter((item) => {
      if (item.type !== 'response.create') return true;
      this.bytes -= item.bytes;
      return false;
    });
  }
  private flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed) return;
    this.measure(this.socket.bufferedAmount, this.bytes);
    if (this.socket.readyState !== 1) {
      this.reject('REALTIME_CONNECTION');
      return;
    }
    // Queue age is not evidence of a disconnected socket. Keep order through
    // temporary congestion; the combined queue/socket byte cap bounds memory.
    while (
      this.queue.length &&
      this.socket.bufferedAmount < 64 * 1024 &&
      this.now() - this.lastSentAt >= this.minimumIntervalMs
    ) {
      const item = this.queue.shift()!;
      this.bytes -= item.bytes;
      try {
        this.lastSentAt = this.now();
        this.socket.send(item.text, (error) => {
          if (error) this.reject('REALTIME_CONNECTION');
        });
        this.onSent(item.type ?? '', item.audioBytes);
      } catch {
        this.reject('REALTIME_CONNECTION');
      }
      if (this.closed) return;
    }
    this.measure(this.socket.bufferedAmount, this.bytes);
    if (this.queue.length) this.timer = setTimeout(() => this.flush(), 25);
  }
  private reject(code: string) {
    if (this.closed) return;
    this.close();
    this.fail(code);
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.queue = [];
    this.bytes = 0;
  }
}
