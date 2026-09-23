import test from 'node:test';
import assert from 'node:assert/strict';
import { PCMPlayback } from '../lib/coach/pcm-realtime';

void test('PCM playback: a valid long reply keeps playing in order and interruption releases its buffers', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sources: {
    onended: (() => void) | null;
    startAt: number;
    stopped: boolean;
  }[] = [];
  const events: string[] = [];
  const context = {
    currentTime: 0,
    createBuffer(_channels: number, length: number, rate: number) {
      return { duration: length / rate, copyToChannel() {} };
    },
    createBufferSource() {
      const source = {
        onended: null as (() => void) | null,
        startAt: 0,
        stopped: false,
        connect() {},
        disconnect() {},
        start(at: number) {
          this.startAt = at;
        },
        stop() {
          this.stopped = true;
        },
      };
      sources.push(source);
      return source;
    },
  } as unknown as AudioContext;
  const player = new PCMPlayback(context, 24000, (e) => events.push(e.type));
  t.after(() => player.clear());
  // Model generation can run ahead of wall-clock playback.
  const tenSeconds = Buffer.alloc(24000 * 2 * 10).toString('base64');
  for (let i = 0; i < 5; i++)
    assert.doesNotThrow(() => player.append('reply', tenSeconds));
  assert.equal(sources.length, 5);
  assert.ok(sources[4].startAt >= 40);
  player.done('reply');
  for (const source of sources) source.onended!();
  assert.equal(
    events.filter((e) => e === 'output_audio_buffer.stopped').length,
    1,
  );
  player.append('next', tenSeconds);
  const staleEnded = sources.at(-1)!.onended!;
  player.clear();
  assert.equal(sources.at(-1)!.stopped, true);
  staleEnded();
  assert.doesNotThrow(() => player.append('after-interrupt', tenSeconds));
});

void test('PCM playback: a real memory limit stays bounded and clears for a new reply', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const context = {
    currentTime: 0,
    createBuffer(_channels: number, length: number, rate: number) {
      return { duration: length / rate, copyToChannel() {} };
    },
    createBufferSource() {
      return {
        onended: null,
        connect() {},
        disconnect() {},
        start() {},
        stop() {},
      };
    },
  } as unknown as AudioContext;
  const player = new PCMPlayback(context, 24000, () => {});
  t.after(() => player.clear());
  const halfMiBOfSamples = Buffer.alloc(256 * 1024).toString('base64');
  for (let i = 0; i < 32; i++) player.append('reply', halfMiBOfSamples);
  assert.throws(() => player.append('reply', 'AAA='), /内存上限/);
  player.clear();
  assert.doesNotThrow(() => player.append('new', halfMiBOfSamples));
});
