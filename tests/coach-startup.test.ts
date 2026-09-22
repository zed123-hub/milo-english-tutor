import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { CoachClient } from '../lib/coach/client';
import { VoiceCoach } from '../lib/coach/voice-coach';
import { PCMRealtime } from '../lib/coach/pcm-realtime';
import { freshData } from '../lib/coach/model';
import { defaultSettings } from '../local/settings';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function startup(t: TestContext, provider: 'qwen' | 'glm' | 'openai' = 'qwen') {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const microphone = deferred<MediaStream>();
  const audioResume = deferred<void>();
  const calls = { microphone: 0, resume: 0, trackStop: 0, audioClose: 0 };
  const stream = {
    getTracks: () => [{ stop: () => calls.trackStop++ }],
  } as unknown as MediaStream;
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  };
  setGlobal('navigator', {
    mediaDevices: {
      getUserMedia() {
        calls.microphone++;
        return microphone.promise;
      },
    },
  });
  setGlobal('window', { speechSynthesis: { cancel() {} } });
  setGlobal('cancelAnimationFrame', () => {});
  setGlobal(
    'AudioContext',
    class {
      state = 'suspended';
      resume() {
        calls.resume++;
        return audioResume.promise.then(() => {
          if (this.state !== 'closed') this.state = 'running';
        });
      }
      async close() {
        calls.audioClose++;
        this.state = 'closed';
      }
    },
  );
  setGlobal(
    'Audio',
    class {
      autoplay = false;
      volume = 1;
      pause() {}
    },
  );
  setGlobal('fetch', () => {
    throw Error('Startup tests must never access the network');
  });
  const client = new CoachClient(() => {});
  client.settings = {
    ...defaultSettings,
    voiceMode: 'realtime',
    realtimeProvider: provider,
    teacherKeyConfigured: false,
    voiceKeyConfigured: true,
    realtimeKeyConfigured: true,
    evaluatorKeyConfigured: true,
    conversationReady: true,
    ready: true,
  };
  client.snapshot = {
    revision: 0,
    epoch: 'startup-fixture',
    data: freshData(),
  };
  const commands: string[] = [],
    states: string[] = [],
    errors: string[] = [];
  client.command = async (action) => {
    commands.push(action);
    return { snapshot: client.snapshot! };
  };
  client.load = async () => ({ snapshot: client.snapshot! });
  client.settled = async () => {};
  const voice = new VoiceCoach(client, {
    status: (state) => states.push(state),
    error: (error) => errors.push(error),
    message() {},
  });
  t.after(async () => {
    await voice.stop();
    microphone.resolve(stream);
    audioResume.resolve();
    await flush();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  return {
    voice,
    microphone,
    audioResume,
    stream,
    calls,
    commands,
    states,
    errors,
  };
}

void test('startup: unresolved microphone permission times out without starting a learning session', async (t) => {
  const f = startup(t);
  f.audioResume.resolve();
  let finished = false;
  void f.voice.start().then(() => {
    finished = true;
  });
  await flush();
  assert.ok(['connecting', 'microphone'].includes(f.states.at(-1)!));
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(
    finished,
    true,
    'A pending browser permission request must not keep start unresolved forever',
  );
  assert.ok(['error', 'paused'].includes(f.states.at(-1)!));
  assert.match(f.errors.join(' '), /麦克风/);
  assert.match(f.errors.join(' '), /权限|允许|浏览器|重试/);
  assert.deepEqual(f.commands, []);
  f.microphone.resolve(f.stream);
  await flush();
  assert.ok(
    f.calls.trackStop > 0,
    'A stream granted after timeout must be released',
  );
  assert.deepEqual(f.commands, []);
});

void test('startup: cancel while microphone permission is pending releases a late stream and never starts', async (t) => {
  const f = startup(t);
  f.audioResume.resolve();
  void f.voice.start();
  await f.voice.stop();
  f.microphone.resolve(f.stream);
  await flush();
  assert.ok(f.calls.trackStop > 0);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.errors, []);
  assert.equal(f.states.at(-1), 'paused');
});

for (const [name, action] of [
  ['NotAllowedError', /权限|允许/],
  ['NotFoundError', /连接|设备|插入|检测|找到/],
  ['NotReadableError', /占用|关闭|其他应用|系统/],
] as const) {
  void test(`startup: ${name} gives actionable microphone guidance`, async (t) => {
    const f = startup(t);
    f.audioResume.resolve();
    const work = f.voice.start();
    f.microphone.reject(new DOMException('Synthetic browser failure', name));
    await work;
    await flush();
    assert.match(f.errors.join(' '), /麦克风/);
    assert.match(f.errors.join(' '), action);
    assert.deepEqual(f.commands, []);
    assert.ok(['error', 'paused'].includes(f.states.at(-1)!));
  });
}

for (const provider of ['qwen', 'glm'] as const) {
  void test(`startup: ${provider} starts once after delayed permission and successful audio activation`, async (t) => {
    const f = startup(t, provider);
    const transport = t.mock.method(
      PCMRealtime.prototype,
      'start',
      async () => {},
    );
    const work = f.voice.start();
    t.mock.timers.tick(20_000);
    await flush();
    assert.deepEqual(f.commands, []);
    assert.deepEqual(f.errors, []);
    f.microphone.resolve(f.stream);
    await flush();
    t.mock.timers.tick(7_000);
    f.audioResume.resolve();
    await work;
    assert.deepEqual(f.commands, ['start']);
    assert.equal(transport.mock.callCount(), 1);
    assert.equal(transport.mock.calls[0].arguments[0], f.stream);
    assert.equal(f.states.at(-1), 'thinking');
    await f.voice.stop();
    t.mock.timers.tick(30_000);
    await flush();
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.commands, ['start']);
  });

  void test(`startup: ${provider} requests audio resume in the initial click before any await`, (t) => {
    const f = startup(t, provider);
    void f.voice.start();
    assert.equal(
      f.calls.resume,
      1,
      'Autoplay activation must be requested before waiting for microphone permission',
    );
    assert.deepEqual(f.commands, []);
  });

  void test(`startup: ${provider} audio resume timeout exits connecting and releases the microphone`, async (t) => {
    const f = startup(t, provider);
    f.microphone.resolve(f.stream);
    let finished = false;
    void f.voice.start().then(() => {
      finished = true;
    });
    await flush();
    assert.equal(f.calls.resume, 1);
    t.mock.timers.tick(8_000);
    await flush();
    assert.equal(
      finished,
      true,
      'Suspended audio must not keep startup pending indefinitely',
    );
    assert.ok(['error', 'paused'].includes(f.states.at(-1)!));
    assert.match(f.errors.join(' '), /声音|音频|播放/);
    assert.match(f.errors.join(' '), /重试|点击|浏览器|允许/);
    assert.ok(f.calls.trackStop > 0);
    assert.ok(f.calls.audioClose > 0);
    assert.deepEqual(f.commands, []);
    f.audioResume.resolve();
    await flush();
    assert.deepEqual(
      f.commands,
      [],
      'A late audio resume must not open a timed-out session',
    );
  });

  void test(`startup: ${provider} cancel during audio resume prevents late session creation`, async (t) => {
    const f = startup(t, provider);
    f.microphone.resolve(f.stream);
    void f.voice.start();
    await flush();
    assert.equal(f.calls.resume, 1);
    await f.voice.stop();
    f.audioResume.resolve();
    await flush();
    assert.deepEqual(
      f.commands,
      [],
      'Resume resolution after stop must never create a new session',
    );
    assert.ok(f.calls.trackStop > 0);
    assert.ok(f.calls.audioClose > 0);
    assert.deepEqual(f.errors, []);
    assert.equal(f.states.at(-1), 'paused');
  });
}
