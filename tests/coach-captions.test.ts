import test from 'node:test';
import assert from 'node:assert/strict';
import { CoachClient } from '../lib/coach/client';
import { VoiceCoach } from '../lib/coach/voice-coach';
import { defaultSettings } from '../local/settings';

void test('voice: mixed-language output never reaches the speech synthesizer', async (t) => {
  const originals = ['window', 'SpeechSynthesisUtterance'].map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const spoken: { text: string; lang: string; volume: number }[] = [];
  class Utterance {
    lang = '';
    rate = 1;
    volume = 1;
    constructor(public text: string) {}
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      speechSynthesis: {
        speak(u: Utterance) {
          spoken.push(u);
        },
        getVoices() {
          return [];
        },
      },
    },
  });
  Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
    configurable: true,
    value: Utterance,
  });
  t.after(() => {
    for (const [name, value] of originals) {
      if (value) Object.defineProperty(globalThis, name, value);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  const client = new CoachClient(() => {});
  client.settings = {
    ...defaultSettings,
    teacherKeyConfigured: true,
    voiceKeyConfigured: false,
    ready: true,
  };
  const voice = new VoiceCoach(client, {
    status() {},
    error() {},
    message() {},
  });
  Object.assign(voice, { alive: true });
  const inner = voice as unknown as {
    speak: (result: unknown) => Promise<void>;
  };
  try {
    await inner.speak({ turnId: 'teacher-one', speech: 'Hello, 你好。' });
  } catch {
    /* Rejecting invalid speech before playback is valid. */
  }
  assert.ok(
    spoken.every((u) => !/[\u3400-\u9fff]/.test(u.text)),
    'Chinese must never be submitted to TTS',
  );
});

import {
  captionReducer,
  nextCaptionMode,
  wordsAtBoundary,
  estimatedWords,
  validateSubtitlePairs,
  translatedSubtitlePairs,
  subtitleRequests,
  SubtitleRequestScheduler,
  visiblePairs,
  type CaptionEvent,
  type CaptionCue,
} from '../lib/coach/captions';
import { freshData } from '../lib/coach/model';
import { propose, realtimeSession } from '../lib/coach/teacher';
import { defaultConfig } from '../lib/providers';
import { CoachCaptions } from '../components/coach-captions';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

void test('captions: three-state toggle; unspoken text is hidden; interruption freezes progress', () => {
  assert.equal(nextCaptionMode('off'), 'english');
  assert.equal(nextCaptionMode('english'), 'bilingual');
  assert.equal(nextCaptionMode('bilingual'), 'off');
  let cues: CaptionCue[] = [];
  cues = captionReducer(cues, {
    type: 'text',
    id: 'teacher',
    text: 'Hello there. How are you?',
  });
  assert.equal(cues[0].started, false);
  cues = captionReducer(cues, { type: 'progress', id: 'teacher', words: 2 });
  cues = captionReducer(cues, {
    type: 'end',
    id: 'teacher',
    interrupted: true,
  });
  cues = captionReducer(cues, { type: 'progress', id: 'teacher', words: 5 });
  cues = captionReducer(cues, {
    type: 'text',
    id: 'teacher',
    text: 'Hello there. How are you today?',
    turnId: 'saved-turn',
  });
  assert.equal(cues[0].words, 2);
  assert.equal(cues[0].interrupted, true);
  assert.equal(cues[0].turnId, 'saved-turn');
  assert.deepEqual(captionReducer(cues, { type: 'clear' }), []);
});
void test('captions: an interrupted audible reply without a final turn still requests one screen-only translation', () => {
  const cues: CaptionCue[] = [
    {
      id: 'response-one',
      text: 'We could visit the market together tonight.',
      words: 5,
      started: true,
      done: true,
      interrupted: true,
      approximate: true,
    },
  ];
  assert.deepEqual(subtitleRequests(cues), [
    { id: 'response-one', text: 'We could visit the market' },
  ]);
  assert.deepEqual(
    subtitleRequests([
      {
        ...cues[0],
        text: 'Hello there.',
        words: 2,
        done: true,
        interrupted: false,
      },
    ]),
    [{ id: 'response-one', text: 'Hello there.' }],
  );
  assert.deepEqual(
    subtitleRequests([
      { ...cues[0], turnId: 'saved-one' },
      ...['two', 'three', 'four'].map((id) => ({
        ...cues[0],
        id,
        done: false,
      })),
    ]),
    [{ id: 'response-one', turnId: 'saved-one' }],
  );
});
void test('captions: cue changes neither drop a valid translation nor start duplicate paid requests', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: { id: string; turnId?: string; text?: string }[] = [];
  const scheduler = new SubtitleRequestScheduler((request) =>
    sent.push(request),
  );
  const first: CaptionCue = {
    id: 'response-one',
    text: 'Hello there.',
    words: 2,
    started: true,
    done: false,
    interrupted: false,
    approximate: true,
    turnId: 'saved-one',
  };
  scheduler.update([first], 'epoch-one', true);
  scheduler.update(
    [
      first,
      {
        ...first,
        id: 'response-two',
        turnId: undefined,
        text: 'We could visit the market together tonight.',
        words: 5,
        done: true,
        interrupted: true,
      },
    ],
    'epoch-one',
    true,
  );
  assert.deepEqual(sent, [{ id: 'response-one', turnId: 'saved-one' }]);
  t.mock.timers.tick(799);
  assert.equal(sent.length, 1);
  const second = {
    ...first,
    id: 'response-two',
    turnId: 'saved-two',
    text: 'We could visit the market together tonight.',
    words: 5,
    done: true,
    interrupted: true,
  };
  scheduler.update([first, second], 'epoch-one', true);
  t.mock.timers.tick(1000);
  scheduler.update([first, second], 'epoch-one', true);
  assert.deepEqual(sent, [
    { id: 'response-one', turnId: 'saved-one' },
    { id: 'response-two', turnId: 'saved-two' },
  ]);
  scheduler.stop();
});
void test('captions: a stable audible fragment falls back once when no saved turn arrives', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: { id: string; turnId?: string; text?: string }[] = [];
  const scheduler = new SubtitleRequestScheduler((request) =>
    sent.push(request),
  );
  const cue: CaptionCue = {
    id: 'response-one',
    text: 'We could visit the market together tonight.',
    words: 5,
    started: true,
    done: true,
    interrupted: true,
    approximate: true,
  };
  scheduler.update([cue], 'epoch-one', true);
  scheduler.update([cue], 'epoch-one', true);
  t.mock.timers.tick(800);
  scheduler.update([cue], 'epoch-one', true);
  assert.deepEqual(sent, [
    { id: 'response-one', text: 'We could visit the market' },
  ]);
  scheduler.stop();
});
void test('captions: boundary indices and audio duration reveal whole words; bilingual reveals complete pairs', () => {
  const text = 'Hello there. How are you?';
  assert.equal(wordsAtBoundary(text, 0), 1);
  assert.equal(wordsAtBoundary(text, 6), 2);
  assert.equal(estimatedWords(text, 0, 3), 0);
  assert.equal(estimatedWords(text, 3, 3), 5);
  const pairs = [
    { english: 'Hello there.', chinese: '你好。' },
    { english: 'How are you?', chinese: '你好吗？' },
  ];
  assert.deepEqual(validateSubtitlePairs(pairs, text), pairs);
  assert.deepEqual(
    translatedSubtitlePairs(['你好。', '你好吗？'], text),
    pairs,
  );
  assert.deepEqual(translatedSubtitlePairs(['你好。你好吗？'], text), [
    { english: text, chinese: '你好。你好吗？' },
  ]);
  assert.equal(
    validateSubtitlePairs(
      [{ english: 'Wrong sentence.', chinese: '错误内容' }],
      text,
    ),
    undefined,
  );
  const cue: CaptionCue = {
    id: 'teacher',
    text,
    words: 1,
    started: true,
    done: false,
    interrupted: false,
    approximate: false,
    pairs,
  };
  assert.deepEqual(visiblePairs(cue), pairs.slice(0, 1));
  assert.deepEqual(visiblePairs({ ...cue, words: 3 }), pairs);
});
void test('captions: late translation cannot resurrect an evicted or cleared conversation', () => {
  let cues: CaptionCue[] = [];
  for (let i = 0; i < 10; i++)
    cues = captionReducer(cues, {
      type: 'text',
      id: String(i),
      text: 'Hello.',
    });
  assert.equal(cues.length, 8);
  assert.deepEqual(
    captionReducer(cues, {
      type: 'translation',
      id: '0',
      pairs: [{ english: 'Hello.', chinese: '你好。' }],
    }),
    cues,
  );
  assert.deepEqual(
    captionReducer([], { type: 'translation', id: '9', error: true }),
    [],
  );
});
void test('captions: English markup shows only revealed words, bilingual shows whole translated line, off renders nothing', () => {
  const client = new CoachClient(() => {});
  const cue: CaptionCue = {
    id: 'teacher',
    text: 'Hello my friend.',
    words: 1,
    started: true,
    done: false,
    interrupted: false,
    approximate: false,
    pairs: [{ english: 'Hello my friend.', chinese: '你好，我的朋友。' }],
  };
  const props = { cues: [cue], client, dispatch: () => {} };
  const english = renderToStaticMarkup(
    createElement(CoachCaptions, { ...props, mode: 'english' }),
  );
  assert.ok(english.includes('Hello'));
  assert.ok(!english.includes('friend.'));
  assert.ok(!english.includes('我的朋友'));
  const bilingual = renderToStaticMarkup(
    createElement(CoachCaptions, { ...props, mode: 'bilingual' }),
  );
  assert.ok(bilingual.includes('Hello my friend.'));
  assert.ok(bilingual.includes('我的朋友'));
  assert.equal(
    renderToStaticMarkup(
      createElement(CoachCaptions, { ...props, mode: 'off' }),
    ),
    '',
  );
});
void test('voice: a single full-volume English voice speaks English only and reports real word boundaries', async (t) => {
  type FakeUtterance = {
    text: string;
    lang: string;
    volume: number;
    voice: unknown;
    onstart: () => void;
    onboundary: (event: { name: string; charIndex: number }) => void;
  };
  const originals = ['window', 'SpeechSynthesisUtterance'].map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const spoken: FakeUtterance[] = [];
  class Utterance {
    lang = '';
    rate = 1;
    volume = 0;
    voice: unknown = null;
    constructor(public text: string) {}
  }
  const englishVoice = { lang: 'en-US', localService: true, name: 'English' },
    chineseVoice = { lang: 'zh-CN', localService: true, name: 'Chinese' };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      speechSynthesis: {
        speak(u: FakeUtterance) {
          spoken.push(u);
        },
        cancel() {},
        getVoices() {
          return [chineseVoice, englishVoice];
        },
      },
    },
  });
  Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
    configurable: true,
    value: Utterance,
  });
  const client = new CoachClient(() => {});
  client.settings = {
    ...defaultSettings,
    teacherKeyConfigured: true,
    voiceKeyConfigured: false,
    ready: true,
  };
  const events: CaptionEvent[] = [];
  const voice = new VoiceCoach(client, {
    status() {},
    error() {},
    message() {},
    caption: (e) => events.push(e),
  });
  Object.assign(voice, { alive: true });
  const inner = voice as unknown as {
    speak: (result: unknown) => Promise<void>;
    cancelPlayback: () => void;
  };
  t.after(() => {
    inner.cancelPlayback();
    for (const [name, value] of originals) {
      if (value) Object.defineProperty(globalThis, name, value);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  await inner.speak({
    turnId: 'teacher',
    speech: 'Hello my friend.',
    subtitles: [{ english: 'Hello my friend.', chinese: '你好，我的朋友。' }],
  });
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, 'Hello my friend.');
  assert.equal(spoken[0].lang, 'en-US');
  assert.equal(spoken[0].voice, englishVoice);
  assert.equal(spoken[0].volume, 1);
  spoken[0].onstart();
  spoken[0].onboundary({ name: 'word', charIndex: 6 });
  assert.ok(
    events.some(
      (e) => e.type === 'progress' && e.words === 2 && !e.approximate,
    ),
  );
  inner.cancelPlayback();
  const before = events.length;
  spoken[0].onboundary({ name: 'word', charIndex: 9 });
  assert.equal(events.length, before);
});
void test('voice: model English constraint wins over mixed legacy opening and invalid model speech is rejected', async (t) => {
  const data = freshData();
  data.plan.nextOpening = '你好，跟我读 Hello';
  const instructions = realtimeSession(data, 'test-model').instructions;
  assert.match(instructions, /Speak ONLY English in ONE voice/);
  assert.match(instructions, /Plans and review items are background/);
  assert.ok(!instructions.includes('开场可以参考：你好'));
  const oldFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = oldFetch;
  });
  const response = {
    speech: 'Hello, 你好。',
    helpLevel: 0,
    focus: '问候',
    reason: '先从问候开始',
    summary: '',
    assessment: { outcome: 'uncertain', phrases: [], context: '问候' },
    facts: [],
  };
  globalThis.fetch = async () =>
    Response.json({
      choices: [{ message: { content: JSON.stringify(response) } }],
    });
  await assert.rejects(
    propose(data, defaultConfig, 'test-api-key', 'opening'),
    /ENGLISH_ONLY/,
  );
});

void test('captions: native audio gates text; late clear and transcript cannot advance an interrupted turn', () => {
  const client = new CoachClient(() => {});
  const events: CaptionEvent[] = [];
  const voice = new VoiceCoach(client, {
    status() {},
    error() {},
    message() {},
    caption: (e) => events.push(e),
  });
  Object.assign(voice, { alive: true });
  const inner = voice as unknown as {
    event: (e: unknown) => void;
    endCaption: (interrupted: boolean) => void;
    captionProgress: (id: string, words: number, approximate: boolean) => void;
    captionActive: string | null;
  };
  inner.event({
    type: 'response.output_audio_transcript.delta',
    response_id: 'r1',
    item_id: 'i1',
    delta: 'Hello my friend.',
  });
  let cues = events.reduce(captionReducer, [] as CaptionCue[]);
  assert.equal(cues[0].started, false);
  inner.event({ type: 'output_audio_buffer.started', response_id: 'r1' });
  inner.captionProgress('r1', 1, true);
  inner.endCaption(true);
  inner.event({
    type: 'response.output_audio_transcript.delta',
    response_id: 'r2',
    item_id: 'i2',
    delta: 'Try again.',
  });
  inner.event({ type: 'output_audio_buffer.started', response_id: 'r2' });
  inner.event({ type: 'output_audio_buffer.cleared', response_id: 'r1' });
  assert.equal(inner.captionActive, 'r2');
  inner.event({
    type: 'response.output_audio_transcript.done',
    response_id: 'r1',
    item_id: 'i1',
    transcript: 'Hello my friend. How are you?',
  });
  cues = events.reduce(captionReducer, [] as CaptionCue[]);
  assert.equal(cues.find((c) => c.id === 'r1')?.words, 1);
  assert.equal(cues.find((c) => c.id === 'r1')?.interrupted, true);
  inner.endCaption(true);
  (voice as unknown as { clearResponseWait(): void }).clearResponseWait();
  Object.assign(voice, { alive: false });
});
