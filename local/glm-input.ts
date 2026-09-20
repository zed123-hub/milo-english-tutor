import type { RealtimeEvent } from '../lib/coach/realtime-providers';

type CommittedInput = {
  id: string;
  wantsResponse: boolean;
  acknowledged: boolean;
  responded: boolean;
};

/** GLM client VAD: bounded audio pre-roll, automatic commits and stable input IDs. */
export class GLMInput {
  private preRoll: { audio: string; ms: number }[] = [];
  private onset = 0;
  private quiet = 0;
  private active: { id: string; ms: number; quiet: number } | null = null;
  private pending: CommittedInput[] = [];
  private finalCandidate: CommittedInput | null = null;
  private responseCommit: CommittedInput | null = null;
  private aliases = new Map<string, string>();
  private early = new Map<string, RealtimeEvent>();
  constructor(
    private send: (event: unknown) => void,
    private emit: (event: RealtimeEvent) => void,
    private respond: () => void,
  ) {}

  push(audio: string, rms: number, ms: number) {
    this.quiet = rms >= 0.008 ? 0 : this.quiet + ms;
    if (!this.active && this.finalCandidate && this.quiet >= 1200) {
      const commit = this.finalCandidate;
      this.finalCandidate = null;
      this.requestResponse(commit);
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
      this.cancelWaitingResponse();
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
    if (this.active.quiet >= 1200 || this.active.ms >= 28000) {
      const completedTurn = this.active.quiet >= 1200;
      this.commit(completedTurn, !completedTurn);
    }
  }

  finish(respond = false) {
    if (!respond) this.cancelWaitingResponse();
    this.commit(respond, false);
  }

  private commit(respond: boolean, finalCandidate: boolean) {
    if (this.active) {
      const id = this.active.id;
      this.active = null;
      if (this.pending.length >= 16) throw Error('REALTIME_PROTOCOL');
      const commit = {
        id,
        wantsResponse: respond,
        acknowledged: false,
        responded: false,
      };
      this.pending.push(commit);
      this.send({ type: 'input_audio_buffer.commit' });
      this.emit({ type: 'input_audio_buffer.speech_stopped', item_id: id });
      if (finalCandidate) this.finalCandidate = commit;
      else if (respond) this.responseCommit = commit;
    }
  }

  private requestResponse(commit: CommittedInput) {
    commit.wantsResponse = true;
    this.responseCommit = commit;
    this.respondWhenAcknowledged(commit);
  }

  private respondWhenAcknowledged(commit: CommittedInput) {
    if (!commit.wantsResponse || !commit.acknowledged || commit.responded)
      return;
    commit.responded = true;
    if (this.responseCommit === commit) this.responseCommit = null;
    this.respond();
  }

  private cancelWaitingResponse() {
    if (this.finalCandidate) this.finalCandidate.wantsResponse = false;
    if (this.responseCommit) this.responseCommit.wantsResponse = false;
    this.finalCandidate = null;
    this.responseCommit = null;
  }

  accept(event: RealtimeEvent): RealtimeEvent[] {
    const id = event.item_id;
    if (
      event.type === 'input_audio_buffer.speech_started' ||
      event.type === 'input_audio_buffer.speech_stopped'
    )
      return [];
    if (event.type === 'input_audio_buffer.committed' && id) {
      const known = this.aliases.get(id);
      const commit = known ? undefined : this.pending.shift();
      const local = known ?? commit?.id;
      if (!local) return [event];
      this.aliases.set(id, local);
      while (this.aliases.size > 64)
        this.aliases.delete(this.aliases.keys().next().value!);
      const early = this.early.get(id);
      this.early.delete(id);
      if (commit) {
        commit.acknowledged = true;
        this.respondWhenAcknowledged(commit);
      }
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
    this.cancelWaitingResponse();
    this.pending = [];
    this.aliases.clear();
    this.early.clear();
  }
}
