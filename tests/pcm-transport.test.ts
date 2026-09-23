import test from 'node:test';
import assert from 'node:assert/strict';
import { CoachClient } from '../lib/coach/client';
import { PCMRealtime } from '../lib/coach/pcm-realtime';

void test('PCM capture: transient upload congestion queues speech and finish in order without ending the call', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  };
  const writes: { type: string; audio?: string }[] = [];
  const failures: string[] = [];
  class Socket {
    static OPEN = 1;
    static instances: Socket[] = [];
    readyState = 1;
    bufferedAmount = 0;
    onmessage?: (event: { data: string }) => void;
    constructor() {
      Socket.instances.push(this);
    }
    send(text: string) {
      writes.push(JSON.parse(text));
    }
    close() {
      this.readyState = 3;
    }
  }
  const node = { connect() {}, disconnect() {} };
  class Worklet {
    static instances: Worklet[] = [];
    port = {
      onmessage: null as ((event: { data: ArrayBuffer }) => void) | null,
    };
    constructor() {
      Worklet.instances.push(this);
    }
    connect() {}
    disconnect() {}
  }
  install('WebSocket', Socket);
  install('AudioWorkletNode', Worklet);
  install('location', { host: 'localhost:39999' });
  install('fetch', () => {
    throw Error('Network forbidden in transport regression');
  });
  const client = new CoachClient(() => {});
  client.request = async () => ({
    ticket: 'offline-ticket',
    inputRate: 16000,
    outputRate: 24000,
  });
  const context = {
    audioWorklet: { async addModule() {} },
    createMediaStreamSource: () => node,
    createGain: () => ({ ...node, gain: { value: 1 } }),
  } as unknown as AudioContext;
  const transport = new PCMRealtime(
    client,
    context,
    () => {},
    (error) => failures.push(error.message),
  );
  t.after(() => {
    transport.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  const opening = transport.start(
    {} as MediaStream,
    new AbortController().signal,
  );
  for (let i = 0; i < 8; i++) await Promise.resolve();
  const socket = Socket.instances[0];
  socket.onmessage!({ data: JSON.stringify({ type: 'milo.ready' }) });
  await opening;
  const capture = Worklet.instances[0];
  socket.bufferedAmount = 300000;
  capture.port.onmessage!({ data: new Uint8Array([1, 0, 2, 0]).buffer });
  capture.port.onmessage!({ data: new Uint8Array([3, 0, 4, 0]).buffer });
  transport.quiesce();
  assert.deepEqual(
    failures,
    [],
    'A temporary browser upload buffer must not end the session',
  );
  assert.deepEqual(
    [...writes],
    [],
    'Speech and finish must wait together, without reordering',
  );
  socket.bufferedAmount = 0;
  t.mock.timers.tick(25);
  assert.deepEqual(
    writes.map((event) => event.type),
    [
      'input_audio_buffer.append',
      'input_audio_buffer.append',
      'milo.input.finish',
    ],
  );
  assert.deepEqual(
    writes.slice(0, 2).map((event) => event.audio),
    ['AQACAA==', 'AwAEAA=='],
  );
  assert.deepEqual(failures, []);
  transport.close();
  t.mock.timers.tick(30000);
  assert.equal(writes.length, 3);
});
