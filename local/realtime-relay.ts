import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { realtimeSession } from '../lib/coach/teacher';
import { quietTurnInstructions } from '../lib/coach/tutor-guidance';
import {
  RealtimeEvents,
  type RealtimeEvent,
} from '../lib/coach/realtime-providers';
import type { CoachService } from './service';
import { RealtimeContextWindow } from './realtime-context';
import { GLMInput } from './glm-input';
import { RealtimeOutput } from './realtime-output';
import { INVALID_REALTIME_TOOL_OUTPUT } from '../lib/coach/realtime-tool-arguments';
import { QwenLifecycle } from '../lib/coach/qwen-lifecycle';
import { GLMLifecycle } from '../lib/coach/glm-lifecycle';
import {
  RealtimeDiagnostics,
  type RealtimeDiagnostic,
} from '../lib/coach/realtime-diagnostics';
import {
  realtimeFault,
  type RealtimeFault,
} from '../lib/coach/realtime-errors';
type Diagnostics = {
  provider: string;
  phase: 'connecting' | 'configuring' | 'ready' | 'closed' | 'error';
  inputFrames: number;
  signalFrames: number;
  inputSeconds: number;
  speechStarts: number;
  speechStops: number;
  commits: number;
  transcripts: number;
  transcriptionFailures: number;
  responses: number;
  completedResponses: number;
  toolCalls: number;
  updates: number;
  outputChunks: number;
  localSpeechStarts: number;
  localSpeechStops: number;
  peakUpstreamBufferedBytes: number;
  peakQueuedBytes: number;
  error?: RealtimeFault;
  errorSource?:
    | 'local'
    | 'upstream_event'
    | 'upstream_socket'
    | 'upstream_close'
    | 'upstream_protocol'
    | 'handshake';
  closeCode?: number;
  localStage?:
    | 'session'
    | 'decode'
    | 'audio'
    | 'audio_budget'
    | 'control_budget'
    | 'refresh'
    | 'tool_result'
    | 'dispatch'
    | 'upstream_send';
};

type Ticket = {
  sessionId: string;
  epoch: string;
  settingsRevision: number;
  expires: number;
  origin: string;
};
export type DialRealtime = (url: string, key: string) => WebSocket;
const dial: DialRealtime = (url, key) =>
  new WebSocket(url, {
    headers: { Authorization: `Bearer ${key}` },
    handshakeTimeout: 15000,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
    followRedirects: false,
  });
function rawText(bytes: RawData) {
  return (
    Array.isArray(bytes)
      ? Buffer.concat(bytes)
      : Buffer.isBuffer(bytes)
        ? bytes
        : Buffer.from(bytes)
  ).toString('utf8');
}
/** Loopback-only, single-use tickets. No long-lived provider credential reaches the browser. */
export class RealtimeRelay {
  private diagnostics: Diagnostics | null = null;
  status() {
    return this.diagnostics ? structuredClone(this.diagnostics) : null;
  }
  private tickets = new Map<string, Ticket>();
  private disposeConnection: (() => void) | null = null;
  private wss = new WebSocketServer({
    noServer: true,
    maxPayload: 24000,
    perMessageDeflate: false,
    handleProtocols: () => 'milo-realtime',
  });
  constructor(
    private service: CoachService,
    private connect: DialRealtime = dial,
    private saveDiagnostic: (report: RealtimeDiagnostic) => void = () => {},
  ) {}
  private valid(ticket: Ticket) {
    const state = this.service.repo.read();
    return (
      ticket.epoch === state.epoch &&
      ticket.sessionId === state.data.activeSessionId &&
      ticket.settingsRevision === this.service.settings.revision &&
      this.service.settings.public().voiceMode === 'realtime'
    );
  }
  issue(sessionId: unknown, epoch: unknown, origin: string) {
    const entry: Ticket = {
      sessionId: String(sessionId),
      epoch: String(epoch),
      origin,
      expires: Date.now() + 15000,
      settingsRevision: this.service.settings.revision,
    };
    if (!this.valid(entry)) throw Error('INVALID_ACTION');
    const { config } = this.service.settings.realtimeCredentials();
    if (config.provider === 'openai') throw Error('INVALID_ACTION');
    if (this.disposeConnection) throw Error('REALTIME_ACTIVE');
    this.tickets.clear();
    const ticket = randomBytes(32).toString('hex');
    this.tickets.set(ticket, entry);
    return {
      ticket,
      inputRate: config.inputRate,
      outputRate: config.outputRate,
    };
  }
  attach(server: Server) {
    server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/api/local/realtime/socket') return;
      try {
        const port = (server.address() as { port: number }).port;
        const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
          .split(',')
          .map((s) => s.trim());
        const token = protocols[1] ?? '';
        const ticket = this.tickets.get(token);
        this.tickets.delete(token);
        if (
          ![`localhost:${port}`, `127.0.0.1:${port}`].includes(
            req.headers.host ?? '',
          ) ||
          req.headers.origin !== `http://${req.headers.host}` ||
          req.headers['sec-fetch-site'] === 'cross-site' ||
          protocols.length !== 2 ||
          protocols[0] !== 'milo-realtime' ||
          !ticket ||
          ticket.origin !== req.headers.origin ||
          ticket.expires < Date.now() ||
          !this.valid(ticket) ||
          this.disposeConnection
        )
          throw Error('LOCAL_ONLY');
        this.wss.handleUpgrade(req, socket, head, (browser) =>
          this.open(browser, ticket, req),
        );
      } catch {
        socket.end(
          'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        );
      }
    });
  }
  private open(browser: WebSocket, ticket: Ticket, _req: IncomingMessage) {
    const { config, key } = this.service.settings.realtimeCredentials();
    const url = new URL(config.endpoint);
    if (config.provider === 'qwen') url.searchParams.set('model', config.model);
    let upstream = this.connect(url.href, key);
    let events = new RealtimeEvents(config.provider);
    const contextWindow = new RealtimeContextWindow(
      config.provider as 'qwen' | 'glm',
    );
    let rotating = false;
    let lastSignal = 0;
    let lastUpstreamEvent = Date.now();
    const heldAudio: { audio: string; rms: number; ms: number }[] = [];
    let heldMs = 0;
    let deferredNudge: 1 | 2 | undefined;
    const trace = new RealtimeDiagnostics(config.provider);
    let lastTraceSave = 0;
    const saveTrace = (force = false) => {
      if (force || Date.now() - lastTraceSave >= 1000) {
        lastTraceSave = Date.now();
        this.saveDiagnostic(trace.snapshot());
      }
    };
    const diagnostics: Diagnostics = {
      provider: config.provider,
      phase: 'connecting',
      inputFrames: 0,
      signalFrames: 0,
      inputSeconds: 0,
      speechStarts: 0,
      speechStops: 0,
      commits: 0,
      transcripts: 0,
      transcriptionFailures: 0,
      responses: 0,
      completedResponses: 0,
      toolCalls: 0,
      updates: 0,
      outputChunks: 0,
      localSpeechStarts: 0,
      localSpeechStops: 0,
      peakUpstreamBufferedBytes: 0,
      peakQueuedBytes: 0,
    };
    this.diagnostics = diagnostics;
    let closed = false,
      ready = false,
      lastFrame = Date.now(),
      lastActivity = Date.now();
    // A stalled Chrome main thread can flush several seconds of valid audio
    // at once. Limit audio duration separately from control event frequency.
    let budgetAt = performance.now(),
      audioBudget = 10,
      controlBudget = 30;
    let failing = false;
    let failTimer: ReturnType<typeof setTimeout> | undefined;
    let quiescent = false;
    const issuedCalls = new Set<string>();
    let input: GLMInput | undefined;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      input?.clear();
      lifecycle.close();
      output.close();
      clearTimeout(setupTimer);
      clearTimeout(failTimer);
      clearInterval(idleTimer);
      clearInterval(contextTimer);
      heldAudio.length = 0;
      if (diagnostics.phase !== 'error') diagnostics.phase = 'closed';
      trace.close(
        diagnostics.errorSource === 'upstream_close'
          ? 'upstream_close'
          : diagnostics.errorSource === 'upstream_socket' ||
              ['REALTIME_CONNECTION', 'REALTIME_BACKPRESSURE'].includes(
                diagnostics.error?.code ?? '',
              )
            ? 'transport_error'
            : diagnostics.error
              ? 'protocol_error'
              : 'local_stop',
      );
      saveTrace(true);
      browser.terminate();
      upstream.terminate();
      this.disposeConnection = null;
    };
    const fail = (
      fault: string | RealtimeFault = 'MODEL_FAILED',
      source: NonNullable<Diagnostics['errorSource']> = 'local',
    ) => {
      if (closed || failing) return;
      failing = true;
      const error = typeof fault === 'string' ? { code: fault } : fault;
      diagnostics.phase = 'error';
      diagnostics.error = error;
      diagnostics.errorSource = source;
      trace.fault(
        error,
        error.code === 'REALTIME_CONFIG' && lifecycle.state === 'updating',
      );
      trace.state('error');
      saveTrace(true);
      output.close();
      // Flush the classified error before closing the local socket.
      failTimer = setTimeout(cleanup, 1000);
      if (browser.readyState === WebSocket.OPEN)
        browser.send(JSON.stringify({ type: 'error', error }), cleanup);
      else cleanup();
    };
    let setupTimer = setTimeout(() => fail('REALTIME_TIMEOUT'), 20000);
    this.disposeConnection = cleanup;
    const idleTimer = setInterval(() => {
      if (!this.valid(ticket) || Date.now() - lastActivity > 180000) cleanup();
      else if (ready && Date.now() - lastFrame > 20000)
        fail('REALTIME_INPUT_STALLED');
    }, 2000);
    const makeOutput = () =>
      new RealtimeOutput(
        upstream,
        (code) => {
          diagnostics.localStage = 'upstream_send';
          fail(code);
        },
        (buffered, queued) => {
          diagnostics.peakUpstreamBufferedBytes = Math.max(
            diagnostics.peakUpstreamBufferedBytes,
            buffered,
          );
          diagnostics.peakQueuedBytes = Math.max(
            diagnostics.peakQueuedBytes,
            queued,
          );
        },
        undefined,
        config.provider === 'glm' ? 25 : 0,
        (type, bytes) => {
          trace.sent(type, bytes);
          saveTrace();
        },
      );
    let output = makeOutput();
    const send = (value: unknown) => output.send(value);
    const instructions = (continuing = false, policyOnly = false) =>
      realtimeSession(this.service.repo.read().data, config.model, {
        continuing,
        policyOnly,
        ...(continuing ? { recentExchange: contextWindow.handoff } : {}),
      });
    const makeLifecycle = (continuing = false) => {
      const initial = instructions(continuing);
      return config.provider === 'qwen'
        ? new QwenLifecycle(
            config,
            initial.instructions,
            initial.tools,
            send,
            !continuing,
          )
        : new GLMLifecycle(
            config,
            initial.instructions,
            initial.tools,
            send,
            !continuing,
          );
    };
    let lifecycle = makeLifecycle();
    const update = (text: string) => lifecycle.policy(text);
    const makeInput = () => {
      if (config.provider === 'glm')
        input = new GLMInput(
          (event) => {
            if ((event as { type: string }).type === 'response.cancel')
              lifecycle.interrupt();
            else send(event);
          },
          (event) => {
            lastActivity = Date.now();
            trace.event(event);
            contextWindow.event(event);
            if (event.type === 'input_audio_buffer.speech_started')
              diagnostics.localSpeechStarts++;
            else diagnostics.localSpeechStops++;
            browser.send(JSON.stringify(event));
          },
          () => {
            if (lifecycle instanceof GLMLifecycle)
              lifecycle.requestResponse('input');
          },
        );
    };
    makeInput();
    const attachUpstream = () => {
      const socket = upstream;
      const current = () => socket === upstream && !closed;
      socket.on('open', () => {
        if (!current()) return;
        if (lifecycle instanceof QwenLifecycle) lifecycle.start();
      });
      socket.on('message', (bytes, binary) => {
        if (!current() || failing) return;
        lastUpstreamEvent = Date.now();
        try {
          if (binary || browser.bufferedAmount > 2 * 1024 * 1024)
            throw Error('MODEL_OUTPUT');
          const raw = JSON.parse(rawText(bytes)) as RealtimeEvent;
          trace.event(raw);
          // Count protocol milestones only; never retain event payloads or identifiers.
          if (raw.type === 'input_audio_buffer.speech_stopped')
            diagnostics.speechStops++;
          if (raw.type === 'input_audio_buffer.committed')
            diagnostics.commits++;
          if (raw.type === 'conversation.item.input_audio_transcription.failed')
            diagnostics.transcriptionFailures++;
          if (raw.type === 'response.created') diagnostics.responses++;
          if (raw.type === 'response.done') diagnostics.completedResponses++;
          if (raw.type === 'response.function_call_arguments.done')
            diagnostics.toolCalls++;
          if (raw.type === 'session.updated') diagnostics.updates++;
          const event = events.normalize(raw);
          if (!event) return;
          if (event.type === 'response.done' && event.response?.error) {
            fail(event.response.error, 'upstream_event');
            return;
          }
          lifecycle.accept(event);
          trace.state(lifecycle.state);
          saveTrace(event.type === 'response.done');
          if (event.type === 'session.updated') {
            diagnostics.phase = 'ready';
            if (rotating && lifecycle.ready) {
              rotating = false;
              clearTimeout(setupTimer);
              if (quiescent) {
                heldAudio.length = 0;
                heldMs = 0;
              }
              const hasSpeech = heldAudio.some((frame) => frame.rms > 0.008);
              for (const frame of heldAudio.splice(0)) {
                contextWindow.audio(frame.ms / 1000);
                if (input) input.push(frame.audio, frame.rms, frame.ms);
                else
                  send({
                    type: 'input_audio_buffer.append',
                    audio: frame.audio,
                  });
              }
              heldMs = 0;
              if (deferredNudge && !quiescent && !hasSpeech) {
                update(
                  instructions(false, true).instructions +
                    '\n' +
                    quietTurnInstructions(deferredNudge),
                );
                lifecycle.requestResponse('nudge');
              }
              deferredNudge = undefined;
            }
            if (!ready && lifecycle.ready) {
              ready = true;
              clearTimeout(setupTimer);
              browser.send(JSON.stringify({ type: 'milo.ready' }));
            }
          }
          if (
            event.type === 'input_audio_buffer.speech_started' ||
            event.type === 'response.output_audio.delta'
          )
            lastActivity = Date.now();
          if (event.type === 'input_audio_buffer.speech_started')
            diagnostics.speechStarts++;
          if (
            event.type ===
            'conversation.item.input_audio_transcription.completed'
          )
            diagnostics.transcripts++;
          if (event.type === 'response.output_audio.delta')
            diagnostics.outputChunks++;
          for (const tool of event.response?.output ?? [])
            issuedCalls.add(tool.call_id);
          if (issuedCalls.size > 24) throw Error('MODEL_OUTPUT');
          if (
            event.type === 'error' &&
            event.error?.code !== 'response_cancel_not_active'
          ) {
            fail(event.error ?? { code: 'MODEL_FAILED' }, 'upstream_event');
            return;
          }
          for (const delivered of input ? input.accept(event) : [event]) {
            contextWindow.event(delivered);
            browser.send(JSON.stringify(delivered));
          }
        } catch {
          fail('REALTIME_PROTOCOL', 'upstream_protocol');
        }
      });
      socket.on('unexpected-response', (_request, response) => {
        if (!current()) {
          response.destroy();
          return;
        }
        const code =
          response.statusCode === 401 || response.statusCode === 403
            ? 'MODEL_AUTH'
            : response.statusCode === 429
              ? 'MODEL_LIMIT'
              : response.statusCode === 400
                ? 'REALTIME_CONFIG'
                : 'MODEL_FAILED';
        const chunks: Buffer[] = [];
        let size = 0;
        const timeout = setTimeout(() => {
          response.destroy();
          fail(code, 'handshake');
        }, 1500);
        response.on('data', (bytes: Buffer) => {
          size += bytes.length;
          if (size > 16000) {
            clearTimeout(timeout);
            response.destroy();
            fail(code, 'handshake');
          } else chunks.push(bytes);
        });
        response.once('end', () => {
          clearTimeout(timeout);
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              error?: unknown;
            };
            const error = realtimeFault(body.error);
            fail(error.code === 'MODEL_FAILED' ? code : error, 'handshake');
          } catch {
            fail(code, 'handshake');
          }
        });
        response.once('error', () => {
          clearTimeout(timeout);
          fail(code, 'handshake');
        });
      });
      socket.on('error', () => {
        if (current()) fail('REALTIME_CONNECTION', 'upstream_socket');
      });
      socket.on('close', (code) => {
        if (current() && !failing) {
          diagnostics.closeCode = code;
          fail('REALTIME_CONNECTION', 'upstream_close');
        }
      });
    };
    attachUpstream();
    const contextTimer = setInterval(() => {
      if (
        closed ||
        failing ||
        quiescent ||
        rotating ||
        !ready ||
        !contextWindow.canRotate ||
        lifecycle.state !== 'idle' ||
        issuedCalls.size ||
        !output.idle ||
        Date.now() - lastSignal < 500 ||
        Date.now() - lastUpstreamEvent < 500
      )
        return;
      // Keep the browser/audio player alive. A new upstream gets only bounded text,
      // never the accumulated audio history and never another greeting.
      rotating = true;
      const old = upstream;
      lifecycle.close();
      output.close();
      input?.clear();
      try {
        upstream = this.connect(url.href, key);
        events = new RealtimeEvents(config.provider);
        output = makeOutput();
        lifecycle = makeLifecycle(true);
        contextWindow.reset();
        makeInput();
        trace.contextRotation();
        saveTrace(true);
        setupTimer = setTimeout(() => fail('REALTIME_TIMEOUT'), 10000);
        attachUpstream();
        old.terminate();
      } catch {
        old.terminate();
        fail('REALTIME_CONNECTION');
      }
    }, 250);
    browser.on('error', cleanup);
    browser.on('close', cleanup);
    browser.on('message', (bytes, binary) => {
      if (closed || failing) return;
      let stage: NonNullable<Diagnostics['localStage']> = 'session';
      try {
        if (!ready || !this.valid(ticket))
          throw Error('REALTIME_STALE_SESSION');
        stage = 'decode';
        if (binary) throw Error('INVALID_BODY');
        const event = JSON.parse(rawText(bytes));
        if (!event || typeof event !== 'object' || Array.isArray(event))
          throw Error('INVALID_BODY');
        const now = performance.now();
        const elapsed = Math.max(0, now - budgetAt) / 1000;
        budgetAt = now;
        audioBudget = Math.min(10, audioBudget + elapsed);
        controlBudget = Math.min(30, controlBudget + elapsed * 10);
        if (event.type === 'input_audio_buffer.append') {
          stage = 'audio';
          if (
            typeof event.audio !== 'string' ||
            event.audio.length < 4 ||
            event.audio.length > 14000 ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(event.audio)
          )
            throw Error('INVALID_BODY');
          const pcm = Buffer.from(event.audio, 'base64');
          if (pcm.length % 2 || pcm.length > config.inputRate * 0.25 * 2)
            throw Error('INVALID_BODY');
          stage = 'audio_budget';
          const seconds = pcm.length / (config.inputRate * 2);
          // Tiny packets must not bypass event limits; normal capture is 100 ms.
          const cost = Math.max(0.05, seconds);
          if (cost > audioBudget + 1e-6) throw Error('REALTIME_BACKPRESSURE');
          audioBudget -= cost;
          if (quiescent) return;
          lastFrame = Date.now();
          diagnostics.inputFrames++;
          diagnostics.inputSeconds =
            Math.round(
              (diagnostics.inputSeconds + pcm.length / (config.inputRate * 2)) *
                1000,
            ) / 1000;
          let power = 0;
          for (let i = 0; i < pcm.length; i += 2)
            power += (pcm.readInt16LE(i) / 32768) ** 2;
          const rms = Math.sqrt(power / (pcm.length / 2));
          if (rms > 0.008) {
            diagnostics.signalFrames++;
            lastSignal = Date.now();
          }
          if (rotating) {
            heldMs += seconds * 1000;
            if (heldMs > 10000 || heldAudio.length >= 200)
              throw Error('REALTIME_BACKPRESSURE');
            heldAudio.push({ audio: event.audio, rms, ms: seconds * 1000 });
            return;
          }
          contextWindow.audio(seconds);
          stage = 'upstream_send';
          if (input)
            input.push(
              event.audio,
              rms,
              (pcm.length / (config.inputRate * 2)) * 1000,
            );
          else send({ type: event.type, audio: event.audio });
          return;
        }
        stage = 'control_budget';
        if (controlBudget < 1) throw Error('REALTIME_EVENT_LIMIT');
        controlBudget--;
        stage = 'dispatch';
        if (event.type === 'milo.input.finish') {
          quiescent = true;
          if (rotating) {
            heldAudio.length = 0;
            heldMs = 0;
          }
          deferredNudge = undefined;
          lifecycle.finish();
          output.cancelResponses();
          input?.finish();
        } else if (event.type === 'session.update') {
          // The browser requests a refresh; only current server-owned memory enters the prompt.
          stage = 'refresh';
          update(instructions(false, true).instructions);
        } else if (event.type === 'response.create') {
          if (rotating) {
            if (event.miloNudge === 1 || event.miloNudge === 2)
              deferredNudge = event.miloNudge;
            return;
          }
          stage = 'refresh';
          if (event.miloNudge === 1 || event.miloNudge === 2)
            update(
              instructions(false, true).instructions +
                '\n' +
                quietTurnInstructions(event.miloNudge),
            );
          stage = 'upstream_send';
          lifecycle.requestResponse(
            event.miloNudge === 1 || event.miloNudge === 2 ? 'nudge' : 'tool',
          );
        } else if (event.type === 'response.cancel') {
          deferredNudge = undefined;
          stage = 'upstream_send';
          lifecycle.interrupt();
        } else if (event.type === 'conversation.item.create') {
          stage = 'tool_result';
          const item = event.item;
          if (
            item?.type !== 'function_call_output' ||
            !issuedCalls.delete(item.call_id) ||
            typeof item.output !== 'string' ||
            item.output.length > 6000
          )
            throw Error('INVALID_BODY');
          if (item.output === JSON.stringify(INVALID_REALTIME_TOOL_OUTPUT)) {
            trace.toolRejected();
            saveTrace(true);
          }
          stage = 'upstream_send';
          send(events.toolResult(item.call_id, item.output));
        } else throw Error('INVALID_BODY');
      } catch (error) {
        diagnostics.localStage = stage;
        const code = error instanceof Error ? error.message : '';
        fail(
          [
            'REALTIME_BACKPRESSURE',
            'REALTIME_EVENT_LIMIT',
            'REALTIME_STALE_SESSION',
            'REALTIME_CONNECTION',
          ].includes(code)
            ? code
            : 'REALTIME_PROTOCOL',
        );
      }
    });
  }
  invalidate() {
    this.tickets.clear();
    this.disposeConnection?.();
  }
  close() {
    this.invalidate();
    this.wss.close();
  }
}
