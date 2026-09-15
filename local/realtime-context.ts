import type { RealtimeEvent } from '../lib/coach/realtime-providers';
import {
  safeRealtimeUsage,
  normalizeRealtimeUsage,
} from '../lib/coach/realtime-usage';

/** Per-upstream window. Only short text survives a rotation; no audio is replayed. */
export class RealtimeContextWindow {
  private turns = 0;
  private seconds = 0;
  private tokens = 0;
  private speaking = false;
  private pending = new Set<string>();
  private transcripts = new Set<string>();
  private latestResponse = '';
  private done = false;
  private audioDone = new Set<string>();
  private transcriptDone = new Set<string>();
  private recent: { id: string; role: 'user' | 'assistant'; text: string }[] =
    [];
  constructor(readonly provider: 'qwen' | 'glm') {}
  audio(seconds: number) {
    this.seconds += seconds;
  }
  event(event: RealtimeEvent) {
    const id = event.item_id;
    const response =
      event.response_id ?? event.response?.id ?? this.latestResponse;
    if (event.type === 'input_audio_buffer.speech_started') {
      this.speaking = true;
      this.done = false;
      if (id) this.pending.add(id);
    } else if (event.type === 'input_audio_buffer.speech_stopped')
      this.speaking = false;
    else if (
      event.type === 'input_audio_buffer.committed' &&
      id &&
      !this.transcripts.has(id)
    )
      this.pending.add(id);
    else if (
      event.type.startsWith('conversation.item.input_audio_transcription.') &&
      id
    ) {
      this.pending.delete(id);
      if (!this.transcripts.has(id)) {
        this.transcripts.add(id);
        if (event.type.endsWith('.completed') && event.transcript?.trim()) {
          this.turns++;
          this.remember(id, 'user', event.transcript);
        }
      }
    } else if (event.type === 'response.output_audio_transcript.done') {
      this.transcriptDone.add(response);
      if (id && event.transcript)
        this.remember(id, 'assistant', event.transcript);
    } else if (event.type === 'response.created') {
      this.latestResponse = response;
      this.done = false;
    } else if (event.type === 'response.output_audio.done') {
      this.audioDone.add(response);
    } else if (
      event.type === 'response.done' &&
      response === this.latestResponse
    ) {
      this.done =
        event.response?.status === 'completed' &&
        !event.response.output?.length;
      const usage =
        normalizeRealtimeUsage(this.provider, event.response?.usage) ??
        safeRealtimeUsage(event.response?.usage);
      this.tokens = usage?.inputTokens ?? this.tokens;
    }
    while (this.transcripts.size > 128)
      this.transcripts.delete(this.transcripts.values().next().value!);
    while (this.transcriptDone.size > 64)
      this.transcriptDone.delete(this.transcriptDone.values().next().value!);
    while (this.audioDone.size > 64)
      this.audioDone.delete(this.audioDone.values().next().value!);
  }
  private remember(id: string, role: 'user' | 'assistant', text: string) {
    if (this.recent.some((t) => t.id === id)) return;
    this.recent.push({ id, role, text: text.trim().slice(0, 240) });
    this.recent = this.recent.slice(-6);
  }
  get canRotate() {
    const limit =
      this.provider === 'qwen'
        ? { turns: 4, seconds: 60 }
        : { turns: 6, seconds: 90 };
    return (
      this.turns >= 2 &&
      (this.turns >= limit.turns ||
        this.seconds >= limit.seconds ||
        this.tokens >= 4000) &&
      !this.speaking &&
      !this.pending.size &&
      this.done &&
      this.audioDone.has(this.latestResponse) &&
      this.transcriptDone.has(this.latestResponse)
    );
  }
  get handoff() {
    return this.recent.map(({ role, text }) => ({ role, text }));
  }
  reset() {
    this.turns = 0;
    this.seconds = 0;
    this.tokens = 0;
    this.pending.clear();
    this.transcripts.clear();
    this.audioDone.clear();
    this.transcriptDone.clear();
    this.speaking = false;
    this.done = false;
    this.latestResponse = '';
  }
}
