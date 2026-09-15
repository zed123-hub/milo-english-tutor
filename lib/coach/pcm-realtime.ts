import type { RealtimeEvent } from './realtime-providers';
import type { CoachClient } from './client';

export function decodePCM(base64: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  if (bytes.length % 2) throw Error('声音数据格式不正确。');
  const view = new DataView(bytes.buffer);
  const samples = new Float32Array(bytes.length / 2);
  for (let i = 0; i < samples.length; i++)
    samples[i] = view.getInt16(i * 2, true) / 32768;
  return samples;
}
type Playback = {
  id: string;
  sources: Set<AudioBufferSourceNode>;
  done: boolean;
  startTimer?: ReturnType<typeof setTimeout>;
};
export class PCMPlayback {
  private nextTime = 0;
  private groups = new Map<string, Playback>();
  private blocked = new Set<string>();
  constructor(
    private context: AudioContext,
    private rate: number,
    private emit: (e: RealtimeEvent) => void,
  ) {}
  append(id: string, base64: string) {
    if (!id || this.blocked.has(id)) return;
    if (this.nextTime - this.context.currentTime > 30)
      throw Error('声音播放积压，请重新连接。');
    const samples = decodePCM(base64);
    if (!samples.length) return;
    const buffer = this.context.createBuffer(1, samples.length, this.rate);
    buffer.copyToChannel(samples, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const start = Math.max(this.context.currentTime + 0.025, this.nextTime);
    this.nextTime = start + buffer.duration;
    let group = this.groups.get(id);
    if (!group) {
      group = { id, sources: new Set(), done: false };
      this.groups.set(id, group);
      group.startTimer = setTimeout(
        () => {
          if (this.groups.has(id))
            this.emit({ type: 'output_audio_buffer.started', response_id: id });
        },
        Math.max(0, (start - this.context.currentTime) * 1000),
      );
    }
    group.sources.add(source);
    source.onended = () => {
      source.disconnect();
      group.sources.delete(source);
      this.drain(group);
    };
    source.start(start);
  }
  done(id: string) {
    const group = this.groups.get(id);
    if (group) {
      group.done = true;
      this.drain(group);
    }
  }
  private drain(group: Playback) {
    if (group.done && !group.sources.size && this.groups.delete(group.id)) {
      clearTimeout(group.startTimer);
      this.emit({ type: 'output_audio_buffer.stopped', response_id: group.id });
    }
  }
  clear() {
    for (const group of this.groups.values()) {
      this.blocked.add(group.id);
      clearTimeout(group.startTimer);
      for (const source of group.sources) {
        source.onended = null;
        source.stop();
        source.disconnect();
      }
      this.emit({ type: 'output_audio_buffer.cleared', response_id: group.id });
    }
    this.groups.clear();
    this.nextTime = this.context.currentTime;
    while (this.blocked.size > 64)
      this.blocked.delete(this.blocked.values().next().value!);
  }
  block(id: string) {
    this.blocked.add(id);
    this.clear();
  }
  isBlocked(id: string) {
    return this.blocked.has(id);
  }
}

export class PCMRealtime {
  private socket: WebSocket | null = null;
  private capture: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private mute: GainNode | null = null;
  private player: PCMPlayback | null = null;
  private closed = false;
  private quiescent = false;
  private responseId = '';
  constructor(
    private client: CoachClient,
    private context: AudioContext,
    private emit: (e: RealtimeEvent) => void,
    private fail: (e: Error) => void,
  ) {}
  async start(stream: MediaStream, signal: AbortSignal) {
    const connection = await this.client.request(
      'realtime/connect',
      {
        sessionId: this.client.snapshot?.data.activeSessionId,
        epoch: this.client.snapshot?.epoch,
      },
      signal,
    );
    if (this.closed || signal.aborted) return;
    if (
      !connection.ticket ||
      ![16000, 24000].includes(connection.inputRate ?? 0) ||
      connection.outputRate !== 24000
    )
      throw Error('实时连接配置不正确。');
    await this.context.audioWorklet.addModule('/audio/milo-pcm-worklet.js');
    if (this.closed || signal.aborted) return;
    const socket = new WebSocket(
      `ws://${location.host}/api/local/realtime/socket`,
      ['milo-realtime', connection.ticket],
    );
    this.socket = socket;
    this.player = new PCMPlayback(
      this.context,
      connection.outputRate,
      this.emit,
    );
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        reject(Error('实时连接已暂停。'));
        this.close();
      };
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => {
        reject(Error('实时模型连接超时，请检查模型、地址和权限。'));
        this.close();
      }, 22000);
      const settle = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      };
      socket.onclose = () => {
        settle();
        reject(Error('实时语音连接已关闭。'));
        if (!this.closed && !this.quiescent)
          this.fail(Error('实时语音连接中断，请重新连接。'));
      };
      socket.onerror = () => {
        settle();
        reject(Error('实时语音连接失败。'));
        if (!this.closed && !this.quiescent)
          this.fail(Error('实时语音连接失败，请检查设置。'));
      };
      socket.onmessage = (event) => {
        if (this.closed) return;
        try {
          const e = JSON.parse(String(event.data)) as RealtimeEvent;
          if (this.quiescent) {
            if (
              e.type.startsWith('conversation.item.input_audio_transcription.')
            )
              this.emit(e);
            return;
          }
          if (e.type === 'milo.ready') {
            settle();
            this.capture = new AudioWorkletNode(this.context, 'milo-pcm', {
              processorOptions: { targetRate: connection.inputRate },
            });
            this.source = this.context.createMediaStreamSource(stream);
            this.mute = this.context.createGain();
            this.mute.gain.value = 0;
            this.source.connect(this.capture);
            this.capture.connect(this.mute);
            this.mute.connect(this.context.destination);
            this.capture.port.onmessage = ({
              data,
            }: MessageEvent<ArrayBuffer>) => {
              if (this.closed || socket.readyState !== WebSocket.OPEN) return;
              if (socket.bufferedAmount > 256000) {
                this.fail(Error('实时声音上传积压，请检查网络后重新连接。'));
                return;
              }
              const bytes = new Uint8Array(data);
              this.send({
                type: 'input_audio_buffer.append',
                audio: btoa(String.fromCharCode(...bytes)),
              });
            };
            resolve();
            return;
          }
          if (
            e.type === 'response.created' ||
            (!this.responseId && e.response_id)
          )
            this.responseId = e.response_id ?? '';
          if (
            e.type === 'response.output_audio.delta' &&
            this.player?.isBlocked(e.response_id ?? '')
          )
            return;
          if (e.type === 'input_audio_buffer.speech_started')
            this.player?.block(this.responseId);
          if (e.type === 'response.output_audio.delta')
            this.player?.append(e.response_id ?? '', e.delta ?? '');
          if (
            e.type === 'response.output_audio.done' ||
            e.type === 'response.done'
          )
            this.player?.done(e.response_id ?? '');
          this.emit(e);
        } catch {
          settle();
          reject(Error('实时声音数据无法读取。'));
          this.fail(Error('实时声音数据无法读取。'));
        }
      };
    });
  }
  send(event: unknown) {
    if (this.closed) return;
    const e = event as { type: string };
    if (e.type === 'output_audio_buffer.clear') {
      this.player?.block(this.responseId);
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(event));
  }
  quiesce() {
    if (!this.quiescent && !this.closed && this.capture)
      this.send({ type: 'milo.input.finish' });
    this.quiescent = true;
    this.source?.disconnect();
    if (this.capture) this.capture.port.onmessage = null;
    this.player?.clear();
  }
  close() {
    this.closed = true;
    this.quiesce();
    this.source?.disconnect();
    this.capture?.disconnect();
    if (this.capture) this.capture.port.onmessage = null;
    this.mute?.disconnect();
    this.player?.clear();
    this.socket?.close();
  }
}
