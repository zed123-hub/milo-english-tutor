import { effectiveDifficulty } from './learning-engine';
import { quietTurnInstructions } from './tutor-guidance';
import { PCMRealtime } from './pcm-realtime';
import { OpenAILifecycle } from './openai-lifecycle';
import { RealtimeDiagnostics } from './realtime-diagnostics';
import {
  decodeRealtimeToolArguments,
  INVALID_REALTIME_TOOL_OUTPUT,
} from './realtime-tool-arguments';
import type { RealtimeEvent } from './realtime-providers';
import {
  realtimeErrorMessage,
  realtimeFault,
  realtimeResponseFault,
} from './realtime-errors';
import {
  assertEnglishSpeech,
  isEnglishSpeech,
  estimatedWords,
  wordsAtBoundary,
  type CaptionEvent,
  type SubtitlePair,
} from './captions';
import { wantsToStop, type LearningData } from './model';

// Only changes in teaching behavior justify a live policy update, not timestamps/IDs.
const difficultyPolicy = (data: LearningData) =>
  JSON.stringify(effectiveDifficulty(data), [
    'vocabulary',
    'grammar',
    'sentenceWords',
    'speakingRate',
    'answerWords',
    'topicDepth',
    'scaffolding',
    'independence',
  ]);
import { CoachClient, type ApiResult } from './client';
import {
  speechRecognizer,
  type Recognizer,
  type RealtimeMessage,
} from '../tutor/voice';

type Callbacks = {
  status: (s: string) => void;
  caption?: (event: CaptionEvent) => void;
  error: (s: string) => void;
  message: (s: string) => void;
};

// Browser media promises may never settle. Cancellation must also release a
// microphone that arrives after the caller has already stopped or timed out.
function waitForMedia<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  timeoutMessage: string,
  releaseLate?: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const cancel = () => fail(new Error('语音启动已取消。'));
    const timer = setTimeout(() => fail(new Error(timeoutMessage)), timeoutMs);
    pending.then((value) => {
      if (settled) {
        releaseLate?.(value);
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    }, fail);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

function microphoneError(error: unknown): Error {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return Error(
      '麦克风权限被拒绝。请在浏览器地址栏和系统设置中允许麦克风，再点击开始。',
    );
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return Error(
      '未检测到可用麦克风。请连接麦克风，并在浏览器中选择正确的输入设备后重试。',
    );
  if (name === 'NotReadableError' || name === 'AbortError')
    return Error(
      '无法读取麦克风。请关闭可能占用麦克风的其他应用，检查系统输入设备后重试。',
    );
  return Error(
    '麦克风启动失败。请检查浏览器和系统的麦克风权限，刷新页面后重试。',
  );
}

/** One connection owns its media and callbacks. A stopped connection can never restart itself. */
export class VoiceCoach {
  private alive = false;
  private stopping = false;
  private stopTask: Promise<void> | null = null;
  private starting: Promise<ApiResult> | null = null;
  private ownedSession: string | null = null;
  private ownedEpoch: string | null = null;
  private stream: MediaStream | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private pcm: PCMRealtime | null = null;
  private openai: OpenAILifecycle | null = null;
  private diagnostic: RealtimeDiagnostics | null = null;
  private diagnosticTimer: ReturnType<typeof setInterval> | undefined;
  private responseTimer: ReturnType<typeof setTimeout> | undefined;
  private responseNotice: ReturnType<typeof setTimeout> | undefined;
  private responseId = '';
  private interruptedResponses = new Set<string>();
  private userSpeaking = false;
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private difficultySignature = '';
  private audio: HTMLAudioElement | null = null;
  private objectUrl = '';
  private context: AudioContext | null = null;
  private recorder: MediaRecorder | null = null;
  private recognition: Recognizer | null = null;
  private frame = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private idleCount = 0;
  private waitingSince = 0;
  private playGeneration = 0;
  private controller = new AbortController();
  private nativeQueue: Promise<void> = Promise.resolve();
  private pending = new Set<string>();
  private received = new Set<string>();
  private eventTimes = new Map<string, string>();
  private calls = new Set<string>();
  private toolQueue: Promise<void> = Promise.resolve();
  private toolRecoveryUsed = false;
  private nextHint = 0;
  private hints = new Map<string, number>();
  private starts = new Map<string, number>();
  private outputAudible = false;
  private nativePlayback = new Map<
    string,
    {
      started: boolean;
      complete: boolean;
      interrupted: boolean;
      turnId?: string;
    }
  >();
  private requestedStop = false;
  private durations = new Map<string, number>();
  private captionTimer: ReturnType<typeof setInterval> | undefined;
  private captionActive: string | null = null;
  private captionElapsed = 0;
  private nativeTexts = new Map<string, string>();
  private blockedNative = new Set<string>();
  private finishedCaptions = new Set<string>();
  private englishVoice: SpeechSynthesisVoice | null = null;
  constructor(
    private client: CoachClient,
    private cb: Callbacks,
  ) {}
  private status(s: string) {
    if (this.alive) this.cb.status(s);
  }
  private fail(error: unknown, diagnosticCode = 'REALTIME_CONNECTION') {
    if (!this.alive || this.stopping) return;
    if (this.diagnostic) {
      if (this.diagnostic.snapshot().error?.code !== diagnosticCode)
        this.diagnostic.fault({ code: diagnosticCode });
      this.diagnostic.close(
        diagnosticCode === 'REALTIME_CONNECTION'
          ? 'transport_error'
          : 'protocol_error',
      );
      this.saveDiagnostic();
    }
    this.cb.error(
      error instanceof Error ? error.message : '语音连接暂时中断，请重新连接。',
    );
    void this.stop().then(() => this.cb.status('error'));
  }
  async start() {
    if (this.alive || this.stopping) return;
    this.alive = true;
    this.status('connecting');
    try {
      const mode = this.client.settings?.voiceMode;
      if (!navigator.mediaDevices?.getUserMedia)
        throw Error('请在本机 localhost 或 HTTPS 浏览器中打开，以使用麦克风。');
      if (
        mode === 'browser' &&
        (!speechRecognizer() || !window.speechSynthesis)
      )
        throw Error(
          '当前浏览器不支持内置语音，请使用 Chrome，或在模型设置里切换到语音 API。',
        );
      if (mode === 'audio' && !window.MediaRecorder)
        throw Error('当前浏览器不支持录音，请使用新版 Chrome。');
      // Request audio playback synchronously inside the user's click, before
      // microphone permission can consume the browser's user activation.
      let audioReady: Promise<boolean> | undefined;
      if (
        mode === 'audio' ||
        (mode === 'realtime' &&
          (this.client.settings?.realtimeProvider ?? 'openai') !== 'openai')
      ) {
        if (typeof AudioContext === 'undefined')
          throw Error('当前浏览器不支持实时声音播放，请使用新版 Chrome。');
        this.context = new AudioContext();
        // Handle rejection immediately, even while microphone permission is pending.
        audioReady = this.context.resume().then(
          () => true,
          () => false,
        );
      }
      this.status('microphone');
      const stream = await waitForMedia(
        navigator.mediaDevices
          .getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          })
          .catch((error: unknown) => {
            throw microphoneError(error);
          }),
        this.controller.signal,
        30000,
        '麦克风授权一直没有返回。请在浏览器地址栏允许麦克风，并检查系统麦克风权限；内嵌预览没有弹窗时，请用 Chrome 打开当前地址后重试。',
        (lateStream) => lateStream.getTracks().forEach((track) => track.stop()),
      );
      if (!this.alive || this.stopping) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      if (audioReady) {
        this.status('audio');
        const audioError =
          '浏览器未能启动声音播放。请保持页面在前台，检查声音播放权限，再点击开始；内嵌预览中可改用 Chrome 打开当前地址。';
        // Give playback its own timeout after microphone permission returns.
        if (
          !(await waitForMedia(
            audioReady,
            this.controller.signal,
            8000,
            audioError,
          ))
        )
          throw Error(audioError);
      }
      if (!this.alive || this.stopping) return;
      this.status('connecting');
      this.audio = new Audio();
      this.audio.autoplay = true;
      this.audio.volume = 1;
      this.ownedEpoch = this.client.snapshot?.epoch ?? null;
      this.starting = this.client.command('start').then((result) => {
        this.ownedSession = result.snapshot?.data.activeSessionId ?? null;
        return result;
      });
      const opening = await this.starting;
      if (!this.alive) return;
      if (mode === 'realtime') {
        if (opening.snapshot)
          this.difficultySignature = difficultyPolicy(opening.snapshot.data);
        await this.native();
      } else await this.speak(opening);
    } catch (error) {
      this.fail(error);
    }
  }
  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    if (!this.alive) return Promise.resolve();
    this.stopTask = this.finish();
    return this.stopTask;
  }
  private async finish() {
    if (this.dc || this.pcm) {
      this.send({ type: 'response.cancel' });
      this.send({ type: 'output_audio_buffer.clear' });
    }
    this.stopping = true;
    this.pcm?.quiesce();
    this.clearResponseWait();
    this.cancelPlayback();
    clearTimeout(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    // Let already committed audio finish transcription, without producing another response.
    if (this.pending.size && (this.dc || this.pcm)) {
      await new Promise<void>((resolve) => {
        const started = Date.now();
        const check = setInterval(() => {
          if (!this.pending.size || Date.now() - started >= 1800) {
            clearInterval(check);
            resolve();
          }
        }, 50);
      });
      if (this.pending.size)
        this.cb.message(
          '最后一段声音还未返回转写；已收到的对话已保留，这一段不会计入学习成果。',
        );
    }
    this.alive = false;
    this.controller.abort();
    for (const timer of this.pendingTimers.values()) clearTimeout(timer);
    this.pendingTimers.clear();
    cancelAnimationFrame(this.frame);
    if (this.recognition) {
      this.recognition.onend = null;
      this.recognition.onerror = null;
      this.recognition.onresult = null;
      this.recognition.abort();
    }
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    clearInterval(this.diagnosticTimer);
    this.diagnostic?.close('local_stop');
    this.saveDiagnostic();
    this.openai?.close();
    this.dc?.close();
    this.pcm?.close();
    this.pc?.close();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.context && this.context.state !== 'closed')
      await this.context.close().catch(() => {});
    this.cb.status('saving');
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await this.starting?.catch(() => {});
          await this.nativeQueue;
          await this.client.settled();
          await this.client.load();
          const state = this.client.snapshot;
          if (
            this.ownedSession &&
            state?.epoch === this.ownedEpoch &&
            state.data.activeSessionId === this.ownedSession
          )
            await this.client.command('end');
        })(),
        new Promise<never>((_, reject) => {
          saveTimer = setTimeout(() => reject(Error('SAVE_TIMEOUT')), 8000);
        }),
      ]);
    } catch {
      this.cb.message(
        '语音已暂停；部分记录的保存暂未确认，请恢复本机服务后查看历史。',
      );
    } finally {
      clearTimeout(saveTimer);
    }
    this.cb.status('paused');
  }
  private cancelPlayback() {
    this.playGeneration++;
    this.endCaption(true);
    window.speechSynthesis?.cancel();
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = '';
    }
  }
  interrupt() {
    if (!this.alive) return;
    if (this.dc?.readyState === 'open' || this.pcm) {
      this.ignoreCurrentResponse();
      this.clearResponseWait();
      this.endCaption(true);
      this.send({ type: 'response.cancel' });
      this.send({ type: 'output_audio_buffer.clear' });
      clearTimeout(this.timer);
      this.idleCount = 0;
      this.outputAudible = false;
      this.status('listening');
      this.armNativeNudge();
    } else {
      this.cancelPlayback();
      this.listen();
    }
  }
  private async played(turnId: string) {
    if (this.alive) await this.client.command('played', { turnId });
  }
  private beginCaption(
    id: string,
    text: string,
    pairs?: SubtitlePair[],
    turnId?: string,
  ) {
    this.endCaption(true);
    this.captionActive = id;
    this.cb.caption?.({ type: 'text', id, text, pairs, turnId });
    this.cb.caption?.({ type: 'progress', id, words: 0 });
  }
  private captionProgress(id: string, words: number, approximate: boolean) {
    if (this.alive && this.captionActive === id)
      this.cb.caption?.({ type: 'progress', id, words, approximate });
  }
  private endCaption(interrupted: boolean) {
    clearInterval(this.captionTimer);
    this.captionTimer = undefined;
    if (this.captionActive) {
      const playback = this.nativePlayback.get(this.captionActive);
      if (playback && interrupted && !playback.complete)
        playback.interrupted = true;
      this.finishedCaptions.add(this.captionActive);
      if (this.finishedCaptions.size > 32)
        this.finishedCaptions.delete(
          this.finishedCaptions.values().next().value!,
        );
    }
    if (this.captionActive)
      this.cb.caption?.({ type: 'end', id: this.captionActive, interrupted });
    this.captionActive = null;
  }
  private async speak(result: ApiResult) {
    if (!this.alive || !result.speech || !result.turnId) return;
    assertEnglishSpeech(result.speech);
    const text = result.speech,
      id = result.turnId,
      generation = ++this.playGeneration;
    this.status('speaking');
    const done = async () => {
      if (!this.alive || generation !== this.playGeneration) return;
      this.endCaption(false);
      await this.played(id);
      if (this.alive && generation === this.playGeneration) {
        if (this.requestedStop) await this.stop();
        else this.listen();
      }
    };
    if (this.client.settings?.voiceMode === 'browser') {
      // One English utterance and one selected voice: subtitles never enter this queue.
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en-US';
      utterance.rate = this.client.snapshot
        ? effectiveDifficulty(this.client.snapshot.data).speakingRate
        : 0.86;
      utterance.volume = 1;
      utterance.pitch = 1;
      const voices = window.speechSynthesis.getVoices();
      this.englishVoice ??=
        voices.find((v) => /^en-US$/i.test(v.lang) && v.localService) ??
        voices.find((v) => /^en-US$/i.test(v.lang)) ??
        voices.find((v) => /^en[-_]/i.test(v.lang)) ??
        null;
      if (this.englishVoice) {
        utterance.voice = this.englishVoice;
        utterance.lang = this.englishVoice.lang;
      }
      let boundary = false,
        started = 0,
        pausedAt = 0;
      utterance.onstart = () => {
        if (!this.alive || generation !== this.playGeneration) return;
        this.beginCaption(id, text, result.subtitles, id);
        started = performance.now();
        this.captionTimer = setInterval(() => {
          if (!boundary && !pausedAt)
            this.captionProgress(
              id,
              estimatedWords(text, (performance.now() - started) / 1000),
              true,
            );
        }, 80);
      };
      utterance.onboundary = (event) => {
        if (
          event.name !== 'word' ||
          !this.alive ||
          generation !== this.playGeneration
        )
          return;
        boundary = true;
        this.captionProgress(id, wordsAtBoundary(text, event.charIndex), false);
      };
      utterance.onpause = () => {
        pausedAt = performance.now();
      };
      utterance.onresume = () => {
        if (pausedAt) started += performance.now() - pausedAt;
        pausedAt = 0;
      };
      utterance.onend = () => {
        void done().catch((e) => this.fail(e));
      };
      utterance.onerror = (event) => {
        if (generation !== this.playGeneration) return;
        if (event.error !== 'interrupted' && event.error !== 'canceled')
          this.fail(
            Error('浏览器未能播放英文声音，请检查系统英语语音或切换语音 API。'),
          );
      };
      window.speechSynthesis.speak(utterance);
      return;
    }
    const res = await fetch('/api/local/speech', {
      method: 'POST',
      headers: { 'X-Milo-Local': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: id, epoch: this.client.snapshot?.epoch }),
      signal: this.controller.signal,
    });
    if (!res.ok) {
      const error = (await res.json()) as { error?: string };
      throw Error(error.error ?? '老师的语音生成失败，请检查语音 API 设置。');
    }
    const blob = await res.blob();
    if (!this.alive || generation !== this.playGeneration) return;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(blob);
    const audio = this.audio!;
    audio.src = this.objectUrl;
    audio.volume = 1;
    audio.onplaying = () => {
      if (!this.alive || generation !== this.playGeneration) return;
      if (this.captionActive !== id)
        this.beginCaption(id, text, result.subtitles, id);
      clearInterval(this.captionTimer);
      this.captionTimer = setInterval(() => {
        if (!audio.paused && !audio.ended)
          this.captionProgress(
            id,
            estimatedWords(text, audio.currentTime, audio.duration),
            true,
          );
      }, 70);
    };
    audio.onended = () => {
      void done().catch((e) => this.fail(e));
    };
    audio.onerror = () => this.fail(Error('无法播放语音，请重新连接。'));
    await audio.play();
  }
  private listen() {
    if (!this.alive) return;
    this.waitingSince = performance.now();
    this.status('listening');
    if (this.client.settings?.voiceMode === 'browser') this.listenBrowser();
    else this.listenAudio();
  }
  private async heard(text: string, seconds: number) {
    if (!this.alive) return;
    if (!text.trim()) {
      this.silent();
      return;
    }
    this.idleCount = 0;
    this.requestedStop = wantsToStop(text);
    this.status('thinking');
    const reply = await this.client.command('turn', {
      role: 'user',
      source:
        this.client.settings?.voiceMode === 'browser'
          ? 'browser-speech'
          : 'asr',
      text,
      seconds,
    });
    if (this.alive) await this.speak(reply);
  }
  private silent() {
    if (!this.alive) return;
    if (performance.now() - this.waitingSince < 20000) {
      this.timer = setTimeout(() => {
        if (this.alive) this.listenBrowser();
      }, 250);
      return;
    }
    if (++this.idleCount >= 3) {
      this.cb.message(
        '暂时没有听到声音，已暂停麦克风。准备好时再和 Milo 继续。',
      );
      void this.stop();
      return;
    }
    this.status('thinking');
    void this.client
      .command('nudge', { level: this.idleCount })
      .then((r) => this.speak(r))
      .catch((e) => this.fail(e));
  }
  private listenBrowser() {
    const recognizer = speechRecognizer();
    if (!recognizer) {
      this.fail(Error('浏览器语音识别不可用，请切换语音 API。'));
      return;
    }
    this.recognition = recognizer;
    recognizer.lang = 'zh-CN';
    recognizer.continuous = false;
    recognizer.interimResults = false;
    let text = '',
      started = 0,
      duration = 0,
      failed = false;
    recognizer.onspeechstart = () => {
      started = performance.now();
    };
    recognizer.onspeechend = () => {
      if (started) duration += (performance.now() - started) / 1000;
      started = 0;
    };
    recognizer.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++)
        if (event.results[i].isFinal)
          text += event.results[i][0].transcript + ' ';
    };
    recognizer.onerror = (event) => {
      if (
        !this.alive ||
        event.error === 'aborted' ||
        event.error === 'no-speech'
      )
        return;
      failed = true;
      this.fail(
        Error(
          event.error === 'not-allowed'
            ? '麦克风权限没有开启，请在浏览器中允许麦克风。'
            : '浏览器语音识别不可用或连接失败，请切换语音 API。',
        ),
      );
    };
    recognizer.onend = () => {
      clearTimeout(this.timer);
      if (!this.alive || failed) return;
      if (started) duration += (performance.now() - started) / 1000;
      void this.heard(text.trim(), duration).catch((e) => this.fail(e));
    };
    recognizer.start();
    this.timer = setTimeout(() => {
      if (this.alive && this.recognition === recognizer) recognizer.stop();
    }, 22000);
  }
  private listenAudio() {
    if (!this.stream || !this.context) return;
    const mime = [
      'audio/webm;codecs=opus',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ].find((t) => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(
      this.stream,
      mime ? { mimeType: mime } : undefined,
    );
    this.recorder = recorder;
    const chunks: BlobPart[] = [];
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 1024;
    const source = this.context.createMediaStreamSource(this.stream);
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const start = performance.now();
    let lastVoice = start,
      voiced = 0,
      previous = start;
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () => {
      cancelAnimationFrame(this.frame);
      source.disconnect();
      analyser.disconnect();
      if (!this.alive) return;
      if (voiced < 0.25) {
        this.silent();
        return;
      }
      this.status('thinking');
      const blob = new Blob(chunks, { type: recorder.mimeType });
      void (async () => {
        const res = await fetch('/api/local/transcribe', {
          method: 'POST',
          headers: { 'X-Milo-Local': '1', 'Content-Type': blob.type },
          body: blob,
          signal: this.controller.signal,
        });
        const result = (await res.json()) as { text?: string; error?: string };
        if (res.status === 422) {
          this.cb.message('刚才没听清，我们再说一次。');
          this.listen();
          return;
        }
        if (!res.ok || !result.text)
          throw Error(result.error ?? '没有收到有效语音转写。');
        await this.heard(result.text, voiced);
      })().catch((e) => this.fail(e));
    };
    recorder.onerror = () =>
      this.fail(Error('录音设备中断，请重新连接麦克风。'));
    recorder.start(250);
    const sample = () => {
      if (!this.alive || recorder.state !== 'recording') return;
      const now = performance.now();
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(
        samples.reduce((sum, value) => sum + value * value, 0) / samples.length,
      );
      if (rms > 0.018) {
        lastVoice = now;
        voiced += Math.min(0.1, (now - previous) / 1000);
      }
      previous = now;
      if (
        (voiced > 0.25 && now - lastVoice > 1400) ||
        now - start > 22000 ||
        (voiced < 0.25 && now - start > 20000)
      ) {
        recorder.stop();
        return;
      }
      this.frame = requestAnimationFrame(sample);
    };
    sample();
  }
  private armNativeNudge() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.alive || this.stopping) return;
      if (this.userSpeaking) {
        this.armNativeNudge();
        return;
      }
      if (++this.idleCount >= 3) {
        this.cb.message('暂时没有听到声音，已暂停麦克风。准备好了我们再继续。');
        void this.stop();
        return;
      }
      this.send({
        type: 'response.create',
        ...(this.pcm ? { miloNudge: this.idleCount } : {}),
        response: {
          instructions: quietTurnInstructions(this.idleCount),
        },
      });
      this.status('thinking');
    }, 22000);
  }
  private send(event: unknown) {
    if (!this.alive || this.stopping) return;
    if (this.openai) {
      this.openai.command(event as Parameters<OpenAILifecycle['command']>[0]);
      return;
    }
    if ((event as { type?: string }).type === 'response.create')
      this.waitForResponse();
    if (this.pcm) this.pcm.send(event);
    else if (this.dc?.readyState === 'open')
      this.dc.send(JSON.stringify(event));
  }
  private clearResponseWait() {
    clearTimeout(this.responseTimer);
    clearTimeout(this.responseNotice);
    this.responseTimer = undefined;
    this.responseNotice = undefined;
  }
  private waitForResponse(playing = false) {
    this.clearResponseWait();
    if (!this.alive || this.stopping) return;
    if (!playing)
      this.responseNotice = setTimeout(() => {
        if (this.alive && !this.stopping)
          this.cb.message('模型回应较慢，仍在等待声音。你可以暂停后重新连接。');
      }, 9000);
    this.responseTimer = setTimeout(
      () => {
        if (this.alive && !this.stopping)
          this.fail(
            Error(
              '实时语音回应超时，已暂停连接并保留收到的对话。请检查网络或切换实时模型后重连。',
            ),
            'REALTIME_TIMEOUT',
          );
      },
      playing ? 45000 : 25000,
    );
  }
  private trackPending(id: string) {
    this.pending.add(id);
    if (this.pendingTimers.has(id)) return;
    this.pendingTimers.set(
      id,
      setTimeout(() => {
        this.pending.delete(id);
        this.pendingTimers.delete(id);
        if (this.alive && !this.stopping)
          this.cb.message('有一段语音转写较慢；交流继续，收到原文后再保存。');
      }, 15000),
    );
  }
  private async native() {
    this.waitForResponse();
    if ((this.client.settings?.realtimeProvider ?? 'openai') !== 'openai') {
      this.pcm = new PCMRealtime(
        this.client,
        this.context!,
        (e) => {
          if (this.alive) this.event(e);
        },
        (e) => this.fail(e),
      );
      await this.pcm.start(this.stream!, this.controller.signal);
      if (this.alive && !this.stopping && !this.outputAudible) {
        this.status('thinking');
        this.waitForResponse();
      }
      return;
    }
    const pc = new RTCPeerConnection();
    this.pc = pc;
    this.diagnostic = new RealtimeDiagnostics('openai');
    const diagnostic = this.diagnostic;
    this.diagnosticTimer = setInterval(() => {
      if (this.pc !== pc || !this.alive) return;
      void pc
        .getStats()
        .then((stats) => {
          let packets = 0,
            bytes = 0;
          stats.forEach((stat) => {
            if (
              stat.type === 'outbound-rtp' &&
              (stat.kind === 'audio' || stat.mediaType === 'audio')
            ) {
              packets +=
                typeof stat.packetsSent === 'number' ? stat.packetsSent : 0;
              bytes += typeof stat.bytesSent === 'number' ? stat.bytesSent : 0;
            }
          });
          diagnostic.rtp(packets, bytes);
          this.saveDiagnostic();
        })
        .catch(() => {});
    }, 2000);
    this.stream!.getTracks().forEach((t) => pc.addTrack(t, this.stream!));
    pc.ontrack = (event) => {
      if (!this.alive || this.pc !== pc) return;
      this.audio!.srcObject = event.streams[0];
      void this.audio!.play().catch(() =>
        this.fail(Error('浏览器阻止了语音播放，请重新连接并允许播放。')),
      );
    };
    pc.onconnectionstatechange = () => {
      diagnostic.state(
        pc.connectionState === 'connected'
          ? 'ready'
          : pc.connectionState === 'connecting'
            ? 'connecting'
            : 'closed',
      );
      if (
        this.alive &&
        this.pc === pc &&
        ['failed', 'disconnected'].includes(pc.connectionState)
      ) {
        diagnostic.fault({ code: 'REALTIME_CONNECTION' });
        diagnostic.close('transport_error');
        this.saveDiagnostic();
        this.fail(Error('实时语音连接中断，已保留对话，请重新连接。'));
      }
    };
    const dc = pc.createDataChannel('oai-events');
    this.dc = dc;
    this.openai = new OpenAILifecycle((event) => {
      if (!this.alive || dc.readyState !== 'open') return;
      if (event.type === 'response.create') this.waitForResponse();
      dc.send(JSON.stringify(event));
      diagnostic.sent(event.type);
    });
    dc.onopen = () => {
      if (!this.alive) return;
      this.status('thinking');
    };
    dc.onmessage = (event) => {
      if (!this.alive) return;
      try {
        const message = JSON.parse(String(event.data)) as RealtimeMessage & {
          error?: unknown;
        };
        const errorEventId =
          message.error && typeof message.error === 'object'
            ? (message.error as { event_id?: unknown }).event_id
            : undefined;
        const normalized = this.openai!.accept(
          message.type === 'error'
            ? { type: 'error', error: realtimeFault(message.error) }
            : (message as RealtimeEvent),
          typeof errorEventId === 'string' ? errorEventId : undefined,
        );
        diagnostic.event(message as RealtimeEvent);
        diagnostic.state(this.openai!.state);
        if (message.type === 'error') {
          const context = this.openai!.errorContext(
            typeof errorEventId === 'string' ? errorEventId : undefined,
          );
          diagnostic.fault(
            {
              ...realtimeFault(message.error),
              requestStatus:
                typeof errorEventId !== 'string'
                  ? 'absent'
                  : context
                    ? 'matched'
                    : 'unmatched',
              ...(context ? { requestType: context.type } : {}),
            },
            normalized === null,
            context?.fields,
          );
          this.saveDiagnostic();
        } else if (message.type === 'response.done') this.saveDiagnostic();
        if (normalized) this.event(normalized);
        else if (this.openai?.lastRejected)
          this.cb.message(
            '导师策略更新未被接受，继续使用上一份策略。' +
              realtimeErrorMessage(this.openai.lastRejected),
          );
      } catch {
        this.fail(Error('实时语音返回了无法读取的数据。'), 'REALTIME_PROTOCOL');
      }
    };
    dc.onerror = () => this.fail(Error('实时语音通道连接失败。'));
    dc.onclose = () => {
      if (this.alive && !this.stopping)
        this.fail(Error('实时语音通道已断开，请重新连接。'));
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const answer = await this.client.request(
      'realtime',
      {
        sdp: offer.sdp,
        sessionId: this.client.snapshot?.data.activeSessionId,
        epoch: this.client.snapshot?.epoch,
      },
      this.controller.signal,
    );
    if (this.alive && this.pc === pc)
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  }
  private saveDiagnostic() {
    if (!this.diagnostic) return;
    // Diagnostic persistence is independent of learning actions and never sends their snapshot.
    void fetch('/api/local/realtime/diagnostics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Milo-Local': '1' },
      body: JSON.stringify(this.diagnostic.snapshot()),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  }
  private enqueue(work: () => Promise<void>) {
    this.nativeQueue = this.nativeQueue
      .then(async () => {
        if (
          this.client.snapshot?.epoch === this.ownedEpoch &&
          this.client.snapshot?.data.activeSessionId === this.ownedSession
        )
          await work();
      })
      .catch((e) => this.fail(e));
  }
  private event(event: RealtimeEvent) {
    if (
      this.stopping &&
      !event.type.startsWith('conversation.item.input_audio_transcription.')
    )
      return;
    if (
      event.type === 'response.done' &&
      this.interruptedResponses.has(
        event.response_id ?? event.response?.id ?? '',
      )
    )
      return;
    // Late terminal events from an interrupted response cannot clear a newer wait.
    if (
      event.type === 'response.done' &&
      event.response_id &&
      this.responseId &&
      event.response_id !== this.responseId
    )
      return;
    if (event.type === 'response.created') {
      this.responseId = event.response_id ?? event.response?.id ?? '';
      if (!this.responseTimer) this.waitForResponse();
    }
    if (event.type === 'response.output_audio.delta')
      this.waitForResponse(true);
    const cueId = event.response_id ?? event.item_id;
    if (
      event.item_id &&
      !this.eventTimes.has(event.item_id) &&
      [
        'input_audio_buffer.speech_started',
        'input_audio_buffer.committed',
        'response.output_audio_transcript.delta',
        'response.output_audio_transcript.done',
      ].includes(event.type)
    )
      this.eventTimes.set(event.item_id, new Date().toISOString());
    if (
      cueId &&
      (event.type === 'output_audio_buffer.stopped' ||
        event.type === 'output_audio_buffer.cleared') &&
      this.captionActive &&
      cueId !== this.captionActive
    )
      return;
    if (
      cueId &&
      event.type === 'output_audio_buffer.started' &&
      this.finishedCaptions.has(cueId)
    )
      return;
    if (
      cueId &&
      (event.type === 'response.output_audio_transcript.delta' ||
        event.type === 'response.output_audio_transcript.done')
    ) {
      const text = event.type.endsWith('.delta')
        ? (this.nativeTexts.get(cueId) ?? '') + (event.delta ?? '')
        : (event.transcript ?? '');
      this.nativeTexts.set(cueId, text);
      if (this.nativeTexts.size > 12)
        this.nativeTexts.delete(this.nativeTexts.keys().next().value!);
      if (/\p{L}/u.test(text) && !isEnglishSpeech(text)) {
        if (!this.blockedNative.has(cueId)) {
          this.blockedNative.add(cueId);
          if (
            !this.responseId ||
            cueId === this.responseId ||
            cueId === this.captionActive
          ) {
            this.endCaption(true);
            this.send({ type: 'response.cancel' });
            this.send({ type: 'output_audio_buffer.clear' });
            if (this.audio) this.audio.muted = true;
            this.cb.message(
              '检测到非英文输出，已停止这段语音。可以重新连接继续。',
            );
          }
        }
        return;
      }
      if (!this.blockedNative.has(cueId))
        this.cb.caption?.({ type: 'text', id: cueId, text });
    }

    const id = event.item_id;
    if (event.type === 'input_audio_buffer.speech_started') {
      this.ignoreCurrentResponse();
      this.clearResponseWait();
      this.userSpeaking = true;
      clearTimeout(this.timer);
      this.idleCount = 0;
      this.endCaption(true);
      if (id) {
        this.trackPending(id);
        this.starts.set(id, performance.now());
        this.hints.set(id, this.nextHint);
        this.nextHint = 0;
      }
      this.outputAudible = false;
      this.status('listening');
    }
    if (event.type === 'input_audio_buffer.committed' && id)
      this.trackPending(id);
    if (event.type === 'input_audio_buffer.speech_stopped') {
      this.userSpeaking = false;
      this.waitForResponse();
      if (id && this.starts.has(id))
        this.durations.set(
          id,
          Math.min(120, (performance.now() - this.starts.get(id)!) / 1000),
        );
      this.status('thinking');
    }
    if (event.type === 'conversation.item.input_audio_transcription.failed') {
      if (id) this.pending.delete(id);
      if (id) {
        clearTimeout(this.pendingTimers.get(id));
        this.pendingTimers.delete(id);
      }
      this.cb.message('有一句语音没有成功转写，已跳过该句的成果记录。');
    }
    if (
      event.type === 'conversation.item.input_audio_transcription.completed' &&
      id
    ) {
      this.pending.delete(id);
      clearTimeout(this.pendingTimers.get(id));
      this.pendingTimers.delete(id);
      if (!this.received.has(id) && event.transcript?.trim()) {
        this.received.add(id);
        this.toolRecoveryUsed = false;
        const text = event.transcript;
        const seconds = this.durations.get(id) ?? 0;
        const hint = this.hints.get(id) ?? this.nextHint;
        this.enqueue(async () => {
          const saved = await this.client.command('turn', {
            role: 'user',
            occurredAt: this.eventTimes.get(id),
            source: 'realtime',
            text,
            seconds,
            hint,
          });
          const signature = saved.snapshot
            ? difficultyPolicy(saved.snapshot.data)
            : this.difficultySignature;
          if (
            this.alive &&
            !this.stopping &&
            saved.instructions &&
            signature !== this.difficultySignature
          ) {
            this.difficultySignature = signature;
            this.send({
              type: 'session.update',
              session: { type: 'realtime', instructions: saved.instructions },
            });
          }
        });
      }
    }
    if (
      event.type === 'response.output_audio_transcript.done' &&
      id &&
      event.transcript?.trim() &&
      !this.received.has(id)
    ) {
      this.received.add(id);
      const text = event.transcript;
      this.enqueue(async () => {
        const result = await this.client.command('turn', {
          role: 'assistant',
          occurredAt: this.eventTimes.get(id),
          source: 'realtime',
          text,
          seconds: 0,
        });
        if (cueId)
          this.cb.caption?.({
            type: 'text',
            id: cueId,
            text,
            turnId: result.turnId,
          });
        if (cueId) {
          const playback = this.playbackFor(cueId);
          playback.turnId = result.turnId;
          if (
            playback.started &&
            playback.complete &&
            !playback.interrupted &&
            result.turnId
          )
            await this.played(result.turnId);
        }
      });
    }
    if (event.type === 'output_audio_buffer.started') {
      this.waitForResponse(true);
      if (cueId && !this.blockedNative.has(cueId)) {
        if (this.audio) this.audio.muted = false;
        this.beginCaption(cueId, this.nativeTexts.get(cueId) ?? '');
        this.playbackFor(cueId).started = true;
        this.captionElapsed = performance.now();
        this.captionTimer = setInterval(() => {
          this.captionProgress(
            cueId,
            estimatedWords(
              this.nativeTexts.get(cueId) ?? '',
              (performance.now() - this.captionElapsed) / 1000,
            ),
            true,
          );
        }, 80);
      }
      clearTimeout(this.timer);
      this.outputAudible = true;
      this.status('speaking');
    }
    if (event.type === 'output_audio_buffer.cleared') {
      this.clearResponseWait();
      this.endCaption(true);
      this.outputAudible = false;
      this.status('listening');
    }
    if (event.type === 'output_audio_buffer.stopped') {
      this.clearResponseWait();
      const playback = this.nativePlayback.get(
        cueId ?? this.captionActive ?? '',
      );
      if (playback) playback.complete = true;
      if (!cueId || cueId === this.captionActive) this.endCaption(false);
      this.status('listening');
      this.armNativeNudge();
      this.enqueue(async () => {
        if (playback?.started && !playback.interrupted && playback.turnId)
          await this.played(playback.turnId);
      });
    }
    if (
      event.type === 'response.done' &&
      event.response?.status === 'completed'
    ) {
      const items = (event.response.output ?? []).filter(
        (item) =>
          item.type === 'function_call' && !this.calls.has(item.call_id),
      );
      for (const item of items) this.calls.add(item.call_id);
      if (items.length)
        this.toolQueue = this.toolQueue
          .then(async () => {
            let invalid = false;
            for (const item of items) {
              if (!this.alive) return;
              invalid = !(await this.tool(item)) || invalid;
            }
            if (!this.alive) return;
            if (invalid && this.toolRecoveryUsed) {
              this.clearResponseWait();
              this.status('listening');
              return;
            }
            if (invalid) this.toolRecoveryUsed = true;
            this.send({ type: 'response.create' });
          })
          .catch((e) => this.fail(e));
      else if (!this.outputAudible && !this.userSpeaking) {
        // A completed text-only/empty turn must not leave the voice UI waiting forever.
        this.waitForResponse();
      }
    }
    if (
      event.type === 'response.done' &&
      (!event.response_id ||
        !this.responseId ||
        event.response_id === this.responseId)
    ) {
      const fault = realtimeResponseFault(event.response);
      if (fault) {
        this.diagnostic?.fault(fault);
        this.fail(
          Error('实时模型没有完成这次语音回答。已保留对话，请重新连接。'),
          fault.code,
        );
      } else if (event.response?.status === 'cancelled') {
        this.clearResponseWait();
        if (!this.userSpeaking) {
          this.status('listening');
          this.armNativeNudge();
        }
      }
    }
    // Realtime may emit response_cancel_not_active during an interrupt; it is harmless.
    if (event.type === 'error') {
      if (event.error?.code !== 'response_cancel_not_active')
        this.fail(Error(realtimeErrorMessage(event.error)), event.error?.code);
    }
  }
  private playbackFor(id: string) {
    let playback = this.nativePlayback.get(id);
    if (!playback) {
      playback = { started: false, complete: false, interrupted: false };
      this.nativePlayback.set(id, playback);
      if (this.nativePlayback.size > 64)
        this.nativePlayback.delete(this.nativePlayback.keys().next().value!);
    }
    return playback;
  }
  private ignoreCurrentResponse() {
    if (this.responseId) this.interruptedResponses.add(this.responseId);
    if (this.interruptedResponses.size > 64)
      this.interruptedResponses.delete(
        this.interruptedResponses.values().next().value!,
      );
  }
  private async tool(item: {
    name: string;
    call_id: string;
    arguments: string;
  }) {
    const decoded = decodeRealtimeToolArguments(
      item.name,
      item.arguments,
      this.client.settings?.realtimeProvider,
    );
    let output: unknown = { ok: false };
    if (!decoded.ok) {
      output = INVALID_REALTIME_TOOL_OUTPUT;
      this.diagnostic?.toolRejected();
    } else if (item.name === 'record_hint') {
      const args = decoded.args as { level: number };
      await this.client.command('hint', { level: args.level });
      this.nextHint = Math.max(this.nextHint, args.level);
      output = { ok: true };
    } else if (item.name === 'checkpoint') {
      // This only records public teaching intent, so late ASR must not gate speech.
      if (!this.alive) return true;
      this.enqueue(async () => {
        await this.client.command('checkpoint', decoded.args);
      });
      output = { ok: true, recorded: 'queued', continueSpeaking: true };
    } else if (item.name === 'end_conversation') {
      await this.nativeQueue;
      const last =
        this.client.snapshot?.data.turns.filter((t) => t.role === 'user').at(-1)
          ?.text ?? '';
      if (wantsToStop(last)) {
        await this.stop();
        return true;
      }
      output = {
        ok: false,
        reason:
          'The learner has not clearly asked to stop. Continue the conversation naturally.',
      };
    }
    if (!this.alive) return true;
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: item.call_id,
        output: JSON.stringify(output),
      },
    });
    return decoded.ok;
  }
}
