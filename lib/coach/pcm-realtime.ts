import type { RealtimeEvent } from './realtime-providers';
import type { CoachClient } from './client';
import { RealtimeOutput } from './realtime-output';

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
class PlaybackCapacityError extends Error {
  constructor() {
    super('声音播放缓冲已达到内存上限，请暂停后重新连接。');
  }
}

/** Keep GLM's client VAD from hearing quiet speaker bleed during playback. */
class GLMPlaybackInputGate {
  private responseId = '';
  private confirming: Uint8Array[] = [];
  private strongFrames = 0;
  private moderateFrames = 0;
  private bargeIn = false;
  private cooldownFrames = 0;

  begin(responseId: string) {
    if (!responseId || this.responseId === responseId) return;
    this.responseId = responseId;
    this.confirming = [];
    this.strongFrames = 0;
    this.moderateFrames = 0;
    this.bargeIn = false;
    this.cooldownFrames = 0;
  }

  end(responseId: string) {
    if (!responseId || responseId !== this.responseId) return;
    this.responseId = '';
    this.cooldownFrames = this.bargeIn ? 0 : 3;
    this.confirming = [];
    this.strongFrames = 0;
    this.moderateFrames = 0;
    this.bargeIn = false;
  }

  accept(frame: Uint8Array): Uint8Array[] {
    if (!this.responseId && this.cooldownFrames === 0) return [frame];
    if (this.bargeIn) return [frame];
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    let power = 0;
    for (let i = 0; i < frame.byteLength; i += 2)
      power += (view.getInt16(i, true) / 32768) ** 2;
    const rms = Math.sqrt(power / (frame.byteLength / 2));
    this.confirming.push(frame);
    if (this.confirming.length > 5) this.confirming.shift();
    this.strongFrames = rms >= 0.032 ? this.strongFrames + 1 : 0;
    this.moderateFrames = rms >= 0.022 ? this.moderateFrames + 1 : 0;
    if (this.strongFrames >= 3 || this.moderateFrames >= 5) {
      this.bargeIn = true;
      this.cooldownFrames = 0;
      const preRoll = this.confirming;
      this.confirming = [];
      return preRoll;
    }
    if (this.cooldownFrames > 0) {
      this.cooldownFrames--;
      if (this.cooldownFrames === 0) this.confirming = [];
    }
    return [];
  }
}
export class PCMPlayback {
  private nextTime = 0;
  private queuedBytes = 0;
  private groups = new Map<string, Playback>();
  private blocked = new Set<string>();
  constructor(
    private context: AudioContext,
    private rate: number,
    private emit: (e: RealtimeEvent) => void,
  ) {}
  append(id: string, base64: string) {
    if (!id || this.blocked.has(id)) return;
    const samples = decodePCM(base64);
    if (!samples.length) return;
    // Fast generation may legitimately run ahead of playback. Bound the actual
    // audio buffers instead of treating a long reply as a broken connection.
    const audioBytes = samples.byteLength;
    if (this.queuedBytes + audioBytes > 16 * 1024 * 1024)
      throw new PlaybackCapacityError();
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
    this.queuedBytes += audioBytes;
    source.onended = () => {
      source.disconnect();
      if (group.sources.delete(source)) this.queuedBytes -= audioBytes;
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
      group.sources.clear();
      this.emit({ type: 'output_audio_buffer.cleared', response_id: group.id });
    }
    this.groups.clear();
    this.queuedBytes = 0;
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
  private output: RealtimeOutput | null = null;
  private capture: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private mute: GainNode | null = null;
  private player: PCMPlayback | null = null;
  private closed = false;
  private quiescent = false;
  private responseId = '';
  private glmInputGate: GLMPlaybackInputGate | null = null;
  constructor(
    private client: CoachClient,
    private context: AudioContext,
    private emit: (e: RealtimeEvent) => void,
    private fail: (e: Error) => void,
  ) {}
  async start(stream: MediaStream, signal: AbortSignal) {
    if (this.client.settings?.realtimeProvider === 'glm')
      this.glmInputGate = new GLMPlaybackInputGate();
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
    this.output = new RealtimeOutput(
      {
        get readyState() {
          return socket.readyState;
        },
        get bufferedAmount() {
          return socket.bufferedAmount;
        },
        send(text, callback) {
          socket.send(text);
          callback();
        },
      },
      (code) => this.uploadFailed(code),
      () => {},
    );
    this.player = new PCMPlayback(
      this.context,
      connection.outputRate,
      (event) => {
        if (
          event.type === 'output_audio_buffer.stopped' ||
          event.type === 'output_audio_buffer.cleared'
        )
          this.glmInputGate?.end(event.response_id ?? '');
        this.emit(event);
      },
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
              const bytes = new Uint8Array(data);
              for (const frame of this.glmInputGate?.accept(bytes) ?? [bytes])
                this.send({
                  type: 'input_audio_buffer.append',
                  audio: btoa(String.fromCharCode(...frame)),
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
            this.glmInputGate?.begin(e.response_id ?? '');
          if (e.type === 'response.output_audio.delta')
            this.player?.append(e.response_id ?? '', e.delta ?? '');
          if (
            e.type === 'response.output_audio.done' ||
            e.type === 'response.done'
          )
            this.player?.done(e.response_id ?? '');
          this.emit(e);
        } catch (error) {
          settle();
          const failure =
            error instanceof PlaybackCapacityError
              ? error
              : Error('实时声音数据无法读取。');
          reject(failure);
          this.fail(failure);
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
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.output?.send(event);
      } catch (error) {
        this.uploadFailed(
          error instanceof Error ? error.message : 'REALTIME_CONNECTION',
        );
      }
    }
  }
  private uploadFailed(code: string) {
    if (this.closed) return;
    this.close();
    this.fail(
      Error(
        code === 'REALTIME_BACKPRESSURE'
          ? '实时声音缓冲已达到内存上限，连接已暂停以避免继续积压。'
          : '实时声音传输连接已断开，请重新连接。',
      ),
    );
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
    this.output?.close();
    this.quiesce();
    this.source?.disconnect();
    this.capture?.disconnect();
    if (this.capture) this.capture.port.onmessage = null;
    this.mute?.disconnect();
    this.player?.clear();
    this.socket?.close();
  }
}
