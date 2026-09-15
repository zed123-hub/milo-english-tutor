'use client';
import { useEffect, useRef, useState } from 'react';
import {
  AudioLines,
  ArrowRight,
  Mic,
  Square,
  Volume2,
  PhoneOff,
  Keyboard,
  Headphones,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Snapshot } from '@/lib/tutor/storage';
import type { StudySession, InputMode } from '@/lib/tutor/domain';
import type { TaskTemplate } from '@/lib/tutor/inventory';
import type { ModelConfig } from '@/lib/providers';
import {
  completedTools,
  speechRecognizer,
  type Recognizer,
  type RealtimeMessage,
} from '@/lib/tutor/voice';

export default function VoiceSession({
  task,
  session,
  busy,
  act,
  evaluation,
  realtimeKey,
  realtimeModel,
  openSettings,
}: {
  task: TaskTemplate;
  session: StudySession;
  busy: boolean;
  act: (action: string, data?: Record<string, unknown>) => Promise<Snapshot>;
  evaluation: { config: ModelConfig; apiKey?: string };
  realtimeKey: string;
  realtimeModel: string;
  openSettings: () => void;
}) {
  const [text, setText] = useState('');
  const [inputMode, setInputMode] = useState<InputMode>('typed');
  const [voiceStatus, setVoiceStatus] = useState<
    'idle' | 'connecting' | 'listening' | 'speaking' | 'thinking'
  >('idle');
  const [live, setLive] = useState(false);
  const [recording, setRecording] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [voiceError, setVoiceError] = useState('');
  const [assistant, setAssistant] = useState('');
  const [keyboard, setKeyboard] = useState(false);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recognitionRef = useRef<Recognizer | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const connectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const audible = useRef(false);
  const pendingTranscripts = useRef(new Set<string>());
  const [transcribing, setTranscribing] = useState(false);
  const timing = useRef({
    promptEnd: 0,
    start: 0,
    duration: 0,
    latency: undefined as number | undefined,
  });
  const userLines = useRef(new Map<string, string>());
  const teacherLines = useRef(new Map<string, string>());
  const finished = useRef(false);
  function cleanup() {
    clearTimeout(connectTimer.current);
    connectTimer.current = undefined;
    audible.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    if (recognitionRef.current) {
      recognitionRef.current.onend = null;
      recognitionRef.current.onresult = null;
      recognitionRef.current.onerror = null;
      recognitionRef.current.abort();
    }
    recognitionRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.srcObject = null;
    }
    window.speechSynthesis?.cancel();
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cleanup();
    };
  }, []);
  function stop() {
    if (pendingTranscripts.current.size) {
      setInputMode('typed');
      setVoiceError(
        '语音转写尚未完成，留下的文字仅供参考。可以重新录音，或确认后作为文字提交。',
      );
    }
    cleanup();
    setLive(false);
    setRecording(false);
    setPlaying(false);
    setVoiceStatus('idle');
    setTranscribing(false);
  }
  function report(error: unknown) {
    if (mounted.current)
      setVoiceError(
        error instanceof Error ? error.message : '语音暂时无法使用。',
      );
  }
  async function heard() {
    if (!mounted.current || finished.current) return;
    timing.current.promptEnd = performance.now();
    await act('played');
  }
  async function submit(value: string, mode: InputMode, teacher = '') {
    if (finished.current || !value.trim()) return;
    finished.current = true;
    stop();
    try {
      await act('submit', {
        transcript: value,
        inputMode: mode,
        ...evaluation,
        assistantTranscript: teacher,
        latencyMs: timing.current.latency,
        durationMs: timing.current.duration || undefined,
      });
    } catch (error) {
      finished.current = false;
      report(error);
    }
  }
  function speak(textToSpeak = task.prompt, trackPlayback = true) {
    setVoiceError('');
    if (!('speechSynthesis' in window)) {
      setVoiceError(
        '这个浏览器不支持朗读。可以连接自然语音，或用文字继续；不会记录为听力表现。',
      );
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(textToSpeak);
    utterance.lang = 'en-US';
    utterance.rate = 0.85;
    const voice = window.speechSynthesis
      .getVoices()
      .find((v) => v.lang === 'en-US');
    if (voice) utterance.voice = voice;
    utterance.onstart = () => {
      if (mounted.current) setPlaying(true);
    };
    utterance.onend = () => {
      if (!mounted.current) return;
      setPlaying(false);
      if (trackPlayback) void heard().catch(report);
    };
    utterance.onerror = (e) => {
      if (!mounted.current) return;
      setPlaying(false);
      if (e.error !== 'interrupted' && e.error !== 'canceled')
        setVoiceError('朗读没有成功，请重试或连接自然语音。');
    };
    window.speechSynthesis.speak(utterance);
  }
  function record() {
    if (recording) {
      recognitionRef.current?.stop();
      return;
    }
    setVoiceError('');
    const recognition = speechRecognizer();
    if (!recognition) {
      setKeyboard(true);
      setVoiceError('此浏览器没有语音识别。可连接自然语音，或暂用文字回答。');
      return;
    }
    window.speechSynthesis?.cancel();
    setPlaying(false);
    recognitionRef.current = recognition;
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = true;
    timing.current.duration = 0;
    timing.current.latency = undefined;
    recognition.onspeechstart = () => {
      timing.current.start = performance.now();
      timing.current.latency = timing.current.promptEnd
        ? timing.current.start - timing.current.promptEnd
        : undefined;
    };
    recognition.onspeechend = () => {
      if (timing.current.start)
        timing.current.duration = performance.now() - timing.current.start;
    };
    let finalTranscript = '';
    recognition.onresult = (event) => {
      if (!mounted.current) return;
      const results = Array.from(event.results);
      finalTranscript = results
        .filter((r) => r.isFinal)
        .map((r) => r[0].transcript)
        .join(' ');
      setText(results.map((r) => r[0].transcript).join(' '));
      setInputMode(
        results.every((r) => r.isFinal) ? 'browser-speech' : 'typed',
      );
    };
    recognition.onerror = (e) => {
      if (!mounted.current) return;
      const errors: Record<string, string> = {
        'not-allowed': '麦克风权限未开启。请允许访问麦克风后再试。',
        'no-speech': '刚才没听到声音。准备好后，我们再试一次。',
        network: '浏览器语音识别网络不可用。可连接自然语音或用文字继续。',
        'audio-capture': '没有可用的麦克风，请检查设备。',
      };
      setVoiceError(
        (errors[e.error] ?? '语音识别暂停了，请再试一次。') +
          (!finalTranscript ? ' 临时转写未确认，仅可作为文字参考。' : ''),
      );
      if (!finalTranscript) setInputMode('typed');
      setRecording(false);
    };
    recognition.onend = () => {
      if (mounted.current) {
        setRecording(false);
        if (finalTranscript) {
          setText(finalTranscript);
          setInputMode('browser-speech');
        } else setInputMode('typed');
      }
    };
    try {
      recognition.start();
      setRecording(true);
      setText('');
      setInputMode('browser-speech');
    } catch {
      setVoiceError('麦克风暂时无法启动，请重试。');
    }
  }
  async function connect() {
    if (!realtimeKey) {
      openSettings();
      return;
    }
    setVoiceError('');
    setVoiceStatus('connecting');
    setLive(true);
    finished.current = false;
    cleanup();
    const learnerLines = new Map<string, string>();
    const tutorLines = new Map<string, string>();
    userLines.current = learnerLines;
    teacherLines.current = tutorLines;
    const pending = new Set<string>();
    pendingTranscripts.current = pending;
    setTranscribing(false);
    timing.current = {
      promptEnd: 0,
      start: 0,
      duration: 0,
      latency: undefined,
    };
    let speaking = false;
    let transcriptReady: (() => void) | undefined;
    setText('');
    setAssistant('');
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection)
        throw Error(
          '此浏览器不支持自然语音，请换用支持麦克风与 WebRTC 的浏览器。',
        );
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (abort.signal.aborted || !mounted.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      const audio = audioRef.current;
      const ownsConnection = () =>
        mounted.current && !abort.signal.aborted && pcRef.current === pc;
      pc.ontrack = (event) => {
        if (!audio || !ownsConnection()) return;
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audio
          .play()
          .then(() => {
            if (ownsConnection()) audible.current = true;
          })
          .catch(() => {
            if (ownsConnection())
              setVoiceError('声音播放被浏览器暂停，请点“播放导师声音”。');
          });
      };
      pc.onconnectionstatechange = () => {
        if (!mounted.current || pcRef.current !== pc) return;
        if (
          pc.connectionState === 'failed' ||
          pc.connectionState === 'disconnected'
        ) {
          stop();
          setVoiceError(
            '语音连接中断，刚才的转写仍在下方，可以提交或重新连接。',
          );
        }
      };
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      const dc = pc.createDataChannel('oai-events');
      const calls = new Set<string>();
      let eventQueue: Promise<unknown> = Promise.resolve();
      const send = (event: unknown) => {
        if (ownsConnection() && dc.readyState === 'open')
          dc.send(JSON.stringify(event));
      };
      const output = (callId: string, value: unknown) =>
        send({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify(value),
          },
        });
      dc.onopen = () => {
        if (!ownsConnection()) return;
        clearTimeout(connectTimer.current);
        setVoiceStatus('listening');
        send({ type: 'response.create' });
      };
      dc.onmessage = (raw) => {
        if (!ownsConnection()) return;
        let event: RealtimeMessage;
        try {
          event = JSON.parse(String(raw.data)) as RealtimeMessage;
        } catch {
          return;
        }
        if (
          event.type === 'conversation.item.input_audio_transcription.failed'
        ) {
          if (event.item_id) pending.delete(event.item_id);
          setInputMode('typed');
          stop();
          setVoiceError(
            '这次语音转写没有完成。已保留的文字仅供参考，可重新录音或用文字继续。',
          );
          return;
        }
        if (event.type === 'error') {
          stop();
          setVoiceError('语音服务返回错误，请检查模型权限与账户余额后重连。');
          return;
        }
        if (
          event.type === 'input_audio_buffer.committed' &&
          event.item_id &&
          !learnerLines.has(event.item_id)
        ) {
          pending.add(event.item_id);
          setTranscribing(true);
        }
        if (event.type === 'input_audio_buffer.speech_started') {
          speaking = true;
          if (event.item_id) pending.add(event.item_id);
          setTranscribing(true);
          setVoiceStatus('listening');
          timing.current.start = performance.now();
          timing.current.latency = timing.current.promptEnd
            ? timing.current.start - timing.current.promptEnd
            : undefined;
        }
        if (event.type === 'input_audio_buffer.speech_stopped') {
          speaking = false;
          setVoiceStatus('thinking');
          if (timing.current.start)
            timing.current.duration += performance.now() - timing.current.start;
        }
        if (event.type === 'output_audio_buffer.started')
          setVoiceStatus('speaking');
        if (event.type === 'output_audio_buffer.stopped') {
          setVoiceStatus('listening');
          if (audible.current)
            eventQueue = eventQueue
              .then(() => {
                if (ownsConnection()) return heard();
              })
              .catch((error) => {
                if (ownsConnection()) report(error);
              });
        }
        if (
          event.type ===
            'conversation.item.input_audio_transcription.completed' &&
          event.transcript &&
          event.item_id
        ) {
          learnerLines.set(event.item_id, event.transcript);
          pending.delete(event.item_id);
          setTranscribing(pending.size > 0 || speaking);
          if (!pending.size && !speaking) transcriptReady?.();
          setText([...learnerLines.values()].join(' '));
          setInputMode('realtime');
        }
        if (
          event.type === 'response.output_audio_transcript.done' &&
          event.transcript &&
          event.item_id
        ) {
          tutorLines.set(event.item_id, event.transcript);
          setAssistant(event.transcript);
        }
        for (const call of completedTools(event)) {
          if (calls.has(call.call_id)) continue;
          calls.add(call.call_id);
          eventQueue = eventQueue
            .then(async () => {
              if (!ownsConnection()) return;
              if (call.name === 'record_hint') {
                let args: { level?: number } = {};
                try {
                  args = JSON.parse(call.arguments) as { level?: number };
                } catch {
                  /* invalid call is rejected below */
                }
                if (![1, 2, 3].includes(args.level ?? 0)) {
                  output(call.call_id, {
                    ok: false,
                    reason: '帮助级别必须为 1、2 或 3。',
                  });
                } else {
                  await act('hint', { level: args.level });
                  if (!ownsConnection()) return;
                  output(call.call_id, { ok: true });
                }
                send({ type: 'response.create' });
              } else {
                if (pending.size || speaking) {
                  await new Promise<void>((resolve) => {
                    const timeout = setTimeout(() => {
                      transcriptReady = undefined;
                      resolve();
                    }, 1800);
                    transcriptReady = () => {
                      clearTimeout(timeout);
                      transcriptReady = undefined;
                      resolve();
                    };
                  });
                }
                if (!ownsConnection()) return;
                if (!learnerLines.size || pending.size || speaking) {
                  output(call.call_id, {
                    ok: false,
                    reason: '还没有收到学生回答的转写，请继续等待学生尝试。',
                  });
                  send({ type: 'response.create' });
                  return;
                }
                output(call.call_id, {
                  ok: true,
                  message: '交给后台评估，暂停交流。',
                });
                await submit(
                  [...learnerLines.values()].join(' '),
                  'realtime',
                  [...tutorLines.values()].join('\n'),
                );
              }
            })
            .catch((error) => {
              if (!ownsConnection()) return;
              report(error);
              output(call.call_id, {
                ok: false,
                reason: '记录未保存，请暂停提示，让学生重试。',
              });
              stop();
            });
        }
      };
      await pc.setLocalDescription(await pc.createOffer());
      const res = await fetch('/api/realtime', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: realtimeKey,
          model: realtimeModel,
          sdp: pc.localDescription?.sdp,
          sessionId: session.id,
          taskId: task.id,
          taskIndex: session.index,
          attempt: session.retries,
        }),
        signal: abort.signal,
      });
      const data = (await res.json()) as { sdp?: string; error?: string };
      if (!res.ok || !data.sdp)
        throw Error(data.error || '语音连接没有建立成功。');
      if (abort.signal.aborted) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      if (!ownsConnection()) return;
      connectTimer.current = setTimeout(() => {
        if (ownsConnection() && dc.readyState !== 'open') {
          stop();
          setVoiceError('语音连接超时，请检查网络后再试。');
        }
      }, 20000);
    } catch (error) {
      if (abortRef.current === abort) clearTimeout(connectTimer.current);
      if (!abort.signal.aborted) {
        stop();
        report(
          error instanceof DOMException && error.name === 'NotAllowedError'
            ? Error('请允许麦克风权限后再连接。')
            : error,
        );
      }
    }
  }
  const active = session.status === 'active';
  const statusText = {
    idle: '准备好时，开口就好',
    connecting: '正在连接你的导师…',
    listening: '我在听，你慢慢说',
    speaking: '导师正在说，可以直接打断',
    thinking: '让我想想怎么帮你…',
  }[voiceStatus];
  return (
    <>
      {/* Realtime has no static caption track; final transcripts are rendered in the conversation. */}
      {/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} autoPlay aria-label="导师声音" />
      <div className="t-conversation">
        <div className="t-speaker">
          <span className="t-avatar">
            <AudioLines />
          </span>
          <span>
            Milo<small>{live ? statusText : '我会等你，慢慢说就好'}</small>
          </span>
        </div>
        <p
          className="t-prompt"
          lang={
            task.kind === 'listen' && !session.sourceExposed ? 'zh-CN' : 'en'
          }
        >
          {task.kind === 'listen' && !session.sourceExposed
            ? '先用耳朵听，答案不用急。'
            : assistant || task.prompt}
        </p>
        {!live ? (
          <Button
            variant="outline"
            onClick={() => speak()}
            disabled={busy || recording || !active || playing}
          >
            <Volume2 />
            {playing ? '正在朗读…' : '听导师说'}
          </Button>
        ) : (
          <p className="t-live-status">
            <span className="t-dot" />
            {statusText}
          </p>
        )}
      </div>
      {session.hintLevel > 0 && (
        <div className="t-hint">
          <span>给你一点帮助 · {session.hintLevel} / 3</span>
          <p>{task.hints[session.hintLevel - 1]}</p>
          {session.hintLevel === 3 && (
            <Button
              variant="ghost"
              disabled={!active || live || recording || busy}
              onClick={() => speak(task.example, false)}
            >
              <Volume2 />
              听示范，跟着说
            </Button>
          )}
        </div>
      )}
      {session.sourceExposed && <p className="t-muted">{task.meaning}</p>}
      {voiceError && (
        <div className="t-error" role="alert">
          {voiceError}
          {live && (
            <Button
              variant="ghost"
              onClick={() => {
                void audioRef.current
                  ?.play()
                  .then(() => {
                    audible.current = true;
                    setVoiceError('');
                  })
                  .catch(() =>
                    setVoiceError('播放仍被阻止，请检查浏览器的声音权限。'),
                  );
              }}
            >
              播放导师声音
            </Button>
          )}
        </div>
      )}
      {active && (
        <>
          <div className="t-voice-area">
            <div
              className={`t-voice-mark ${recording || live ? 'is-active' : ''}`}
              aria-hidden="true"
            >
              <span />
              <span />
              <span />
              <span />
              <span />
            </div>
            <p>
              {recording
                ? '正在听你说，停下来就会结束识别'
                : live
                  ? statusText
                  : '先说一句，其余的交给我'}
            </p>
            <div className="t-actions">
              {live ? (
                <>
                  <Button
                    className="t-primary"
                    onClick={() => {
                      stop();
                    }}
                  >
                    <PhoneOff />
                    暂停对话
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || transcribing || !text.trim()}
                    onClick={() => {
                      void submit(
                        text,
                        inputMode,
                        [...teacherLines.current.values()].join('\n'),
                      );
                    }}
                  >
                    这段说完了
                    <ArrowRight />
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    className="t-primary"
                    disabled={busy || playing}
                    onClick={record}
                  >
                    {recording ? <Square /> : <Mic />}
                    {recording ? '说完了' : '点击，开口说'}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || recording || playing}
                    onClick={() => {
                      void connect();
                    }}
                  >
                    <Headphones />
                    自然语音对话
                  </Button>
                </>
              )}
            </div>
            <small>
              {live
                ? '麦克风已开启 · 可随时打断或暂停'
                : '点击后开启麦克风，语音服务可能联网处理声音。'}
            </small>
          </div>
          <div className="t-actions">
            <Button
              variant="outline"
              disabled={busy || live || recording || session.hintLevel >= 3}
              onClick={() => {
                void act('hint').catch(report);
              }}
            >
              我不会，教教我
            </Button>
            {task.kind === 'listen' && !session.sourceExposed && (
              <Button
                variant="ghost"
                disabled={busy || recording || live}
                onClick={() => {
                  void act('reveal').catch(report);
                }}
              >
                看看原文和意思
              </Button>
            )}
            <Button
              variant="ghost"
              disabled={live || recording}
              onClick={() => setKeyboard(!keyboard)}
            >
              <Keyboard />
              {keyboard ? '收起文字输入' : '暂时不方便说话'}
            </Button>
          </div>
          {(text || keyboard) && (
            <form
              className="t-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void submit(
                  text,
                  inputMode,
                  [...teacherLines.current.values()].join('\n'),
                );
              }}
            >
              <label htmlFor="answer">
                {inputMode === 'typed' ? '用文字表达也可以' : '刚才听到你说'}
              </label>
              <div>
                <Input
                  id="answer"
                  value={text}
                  maxLength={6000}
                  readOnly={live || recording}
                  onChange={(e) => {
                    setText(e.target.value);
                    setInputMode('typed');
                  }}
                  placeholder={
                    task.kind === 'listen'
                      ? '你听到了什么？也可以用中文回答。'
                      : '说说你想表达什么…'
                  }
                />
                <Button
                  type="submit"
                  disabled={
                    busy || recording || live || transcribing || !text.trim()
                  }
                  aria-label="提交这次回答"
                >
                  <ArrowRight />
                </Button>
              </div>
              <small>
                {inputMode === 'typed'
                  ? '这次记为文字练习，不作为口语能力依据。'
                  : '按原转写提交会记为语音尝试；手动修改后记为文字练习。'}
              </small>
            </form>
          )}
        </>
      )}
      {!active && (
        <div className="t-review" aria-live="polite">
          <p>{session.lastFeedback}</p>
          <small>
            {session.turns.at(-1)?.assessment === 'rules'
              ? '本次为内置检查。连接导师模型后，可获得更灵活的语义反馈。'
              : '结合本次表达、提示使用情况，更新了你的学习记录。'}
          </small>
          <Button
            className="t-primary"
            disabled={busy}
            onClick={() => {
              stop();
              void act('continue').catch(report);
            }}
          >
            继续，听你安排
            <ArrowRight />
          </Button>
        </div>
      )}
    </>
  );
}
