import type { RealtimeEvent } from '../lib/coach/realtime-providers';

/** GLM client VAD: bounded audio pre-roll, automatic commits and stable input IDs. */
export class GLMInput {
  private preRoll: { audio: string; ms: number }[] = [];
  private onset = 0;
  private quiet = 0;
  private unanswered = false;
  private active: { id: string; ms: number; quiet: number } | null = null;
  private pending: string[] = [];
  private aliases = new Map<string, string>();
  private early = new Map<string, RealtimeEvent>();
  constructor(
    private send: (event: unknown) => void,
    private emit: (event: RealtimeEvent) => void,
    private respond: () => void,
  ) {}

  push(audio: string, rms: number, ms: number) {
    this.quiet = rms >= 0.008 ? 0 : this.quiet + ms;
    if (!this.active && this.unanswered && this.quiet >= 1200) {
      this.unanswered = false;
      this.respond();
    }
    let frames = [audio];
    if (!this.active) {
      this.preRoll.push({ audio, ms });
      while (this.preRoll.reduce((n, frame) => n + frame.ms, 0) > 300 + ms)
        this.preRoll.shift();
      this.onset = rms >= 0.012 ? this.onset + ms : 0;
      if (this.onset < 200) return;
      frames = this.preRoll.map((frame) => frame.audio);
      this.active = {
        id: `milo-input-${crypto.randomUUID()}`,
        ms: this.preRoll.reduce((n, frame) => n + frame.ms, 0) - ms,
        quiet: 0,
      };
      this.preRoll = [];
      this.onset = 0;
      this.send({ type: 'response.cancel' });
      this.emit({
        type: 'input_audio_buffer.speech_started',
        item_id: this.active.id,
      });
    }
    for (const frame of frames)
      this.send({ type: 'input_audio_buffer.append', audio: frame });
    this.active.ms += ms;
    this.active.quiet = rms >= 0.008 ? 0 : this.active.quiet + ms;
    // Leave thinking room, but keep every buffer below GLM's 30 second limit.
    if (this.active.quiet >= 1200 || this.active.ms >= 28000)
      this.finish(this.active.quiet >= 1200);
  }

  finish(respond = false) {
    if (this.active) {
      const id = this.active.id;
      this.active = null;
      if (this.pending.length >= 16) throw Error('REALTIME_PROTOCOL');
      this.pending.push(id);
      this.send({ type: 'input_audio_buffer.commit' });
      this.emit({ type: 'input_audio_buffer.speech_stopped', item_id: id });
      this.unanswered = !respond;
      if (respond) this.respond();
    }
  }

  accept(event: RealtimeEvent): RealtimeEvent[] {
    const id = event.item_id;
    if (
      event.type === 'input_audio_buffer.speech_started' ||
      event.type === 'input_audio_buffer.speech_stopped'
    )
      return [];
    if (event.type === 'input_audio_buffer.committed' && id) {
      const local = this.aliases.get(id) ?? this.pending.shift();
      if (!local) return [event];
      this.aliases.set(id, local);
      while (this.aliases.size > 64)
        this.aliases.delete(this.aliases.keys().next().value!);
      const early = this.early.get(id);
      this.early.delete(id);
      return [
        { ...event, item_id: local },
        ...(early ? [{ ...early, item_id: local }] : []),
      ];
    }
    if (
      event.type.startsWith('conversation.item.input_audio_transcription.') &&
      id
    ) {
      const local = this.aliases.get(id);
      if (local) return [{ ...event, item_id: local }];
      if (this.pending.length) {
        if (this.early.size >= 16 || (event.transcript?.length ?? 0) > 12000)
          throw Error('REALTIME_PROTOCOL');
        this.early.set(id, event);
        return [];
      }
    }
    return [event];
  }

  clear() {
    this.preRoll = [];
    this.active = null;
    this.onset = 0;
    this.quiet = 0;
    this.unanswered = false;
    this.pending = [];
    this.aliases.clear();
    this.early.clear();
  }
}
