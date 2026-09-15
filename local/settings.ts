import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { defaultConfig, providers, type ModelConfig } from '../lib/providers';
import { validateKey, validateModelConfig } from '../lib/tutor/evaluator';
import {
  realtimeConfig,
  type RealtimeOptions,
} from '../lib/coach/realtime-providers';
export type LocalSettings = RealtimeOptions & {
  teacher: ModelConfig;
  evaluator?: ModelConfig;
  voiceMode: 'realtime' | 'audio' | 'browser';
  realtimeModel: string;
  asrModel: string;
  ttsModel: string;
  voice: string;
};
export const defaultSettings: LocalSettings = {
  teacher: defaultConfig,
  evaluator: defaultConfig,
  voiceMode: 'browser',
  realtimeModel: 'gpt-realtime-2.1-mini',
  asrModel: 'gpt-4o-mini-transcribe',
  ttsModel: 'gpt-4o-mini-tts',
  voice: 'marin',
};
function cleanModel(value: unknown): ModelConfig {
  const m = validateModelConfig(value);
  return {
    provider: m.provider,
    model: m.model,
    baseUrl: ['custom', 'qwen'].includes(m.provider)
      ? m.baseUrl
      : providers[m.provider].baseUrl,
    tokenParameter:
      m.tokenParameter === 'max_completion_tokens'
        ? 'max_completion_tokens'
        : 'max_tokens',
  };
}
function sameEndpoint(a: ModelConfig, b: ModelConfig) {
  return a.provider === b.provider && a.baseUrl === b.baseUrl;
}
export class SettingsStore {
  private settings: LocalSettings = structuredClone(defaultSettings);
  private teacherKey = '';
  private evaluatorKey = '';
  private voiceKey = '';
  private realtimeKey = '';
  revision = 0;
  private path: string;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, 'preferences.json');
    if (existsSync(this.path))
      try {
        this.settings = this.validate(
          JSON.parse(readFileSync(this.path, 'utf8')),
        );
      } catch {
        this.settings = structuredClone(defaultSettings);
      }
  }
  private validate(v: unknown): LocalSettings {
    const p = v as LocalSettings;
    if (
      !p ||
      !['realtime', 'audio', 'browser'].includes(p.voiceMode) ||
      ![p.realtimeModel, p.asrModel, p.ttsModel].every(
        (x) => typeof x === 'string' && /^[-\w./:]{1,150}$/.test(x),
      ) ||
      !['marin', 'coral', 'alloy', 'cedar', 'sage'].includes(p.voice)
    )
      throw Error('INVALID_BODY');
    const rt = realtimeConfig(p);
    return {
      teacher: cleanModel(p.teacher),
      evaluator: cleanModel(p.evaluator ?? p.teacher),
      voiceMode: p.voiceMode,
      realtimeModel: p.realtimeModel,
      realtimeProvider: rt.provider,
      realtimeBaseUrl: rt.endpoint,
      realtimeVoice: rt.voice,
      asrModel: p.asrModel,
      ttsModel: p.ttsModel,
      voice: p.voice,
    };
  }
  private analysisKey() {
    return (
      this.evaluatorKey ||
      (sameEndpoint(
        this.settings.evaluator ?? this.settings.teacher,
        this.settings.teacher,
      )
        ? this.teacherKey
        : '') ||
      ((this.settings.evaluator ?? this.settings.teacher).provider === 'openai'
        ? this.voiceKey
        : '')
    );
  }
  private audioKey() {
    return (
      this.voiceKey ||
      (this.settings.teacher.provider === 'openai' ? this.teacherKey : '') ||
      ((this.settings.evaluator ?? this.settings.teacher).provider === 'openai'
        ? this.evaluatorKey
        : '')
    );
  }
  public() {
    const conversationReady =
      this.settings.voiceMode === 'realtime'
        ? !!this.nativeKey()
        : !!this.teacherKey &&
          (this.settings.voiceMode === 'browser' || !!this.audioKey());
    return {
      ...this.settings,
      teacherKeyConfigured: !!this.teacherKey,
      evaluatorKeyConfigured: !!this.analysisKey(),
      voiceKeyConfigured: !!this.audioKey(),
      realtimeKeyConfigured: !!this.nativeKey(),
      conversationReady,
      ready: conversationReady && !!this.analysisKey(),
    };
  }
  save(value: unknown) {
    const v = value as LocalSettings & {
      teacherKey?: string;
      evaluatorKey?: string;
      voiceKey?: string;
      realtimeKey?: string;
      forgetKeys?: boolean;
    };
    const next = this.validate(v);
    let teacherKey = sameEndpoint(next.teacher, this.settings.teacher)
      ? this.teacherKey
      : '';
    let evaluatorKey = sameEndpoint(
      next.evaluator!,
      this.settings.evaluator ?? this.settings.teacher,
    )
      ? this.evaluatorKey
      : '';
    let voiceKey = this.voiceKey;
    let realtimeKey =
      next.realtimeProvider === this.settings.realtimeProvider &&
      next.realtimeBaseUrl === this.settings.realtimeBaseUrl
        ? this.realtimeKey
        : '';
    if (v.forgetKeys) {
      teacherKey = '';
      evaluatorKey = '';
      voiceKey = '';
      realtimeKey = '';
    } else {
      if (v.teacherKey) teacherKey = validateKey(v.teacherKey);
      if (v.evaluatorKey) evaluatorKey = validateKey(v.evaluatorKey);
      if (v.voiceKey) voiceKey = validateKey(v.voiceKey);
      if (v.realtimeKey) realtimeKey = validateKey(v.realtimeKey);
    }
    writeFileSync(this.path, JSON.stringify(next, null, 2), { mode: 0o600 });
    chmodSync(this.path, 0o600);
    this.settings = next;
    this.teacherKey = teacherKey;
    this.evaluatorKey = evaluatorKey;
    this.voiceKey = voiceKey;
    this.realtimeKey = realtimeKey;
    this.revision++;
    return this.public();
  }
  credentials() {
    if (!this.teacherKey) throw Error('KEY_REQUIRED');
    return {
      settings: this.settings,
      teacherKey: this.teacherKey,
      voiceKey: this.audioKey(),
    };
  }
  analysisCredentials() {
    const key = this.analysisKey();
    if (!key) throw Error('KEY_REQUIRED');
    return { config: this.settings.evaluator ?? this.settings.teacher, key };
  }
  openAI() {
    const key = this.audioKey();
    if (!key) throw Error('KEY_REQUIRED');
    return { settings: this.settings, key, baseUrl: providers.openai.baseUrl };
  }
  private nativeKey() {
    return (this.settings.realtimeProvider ?? 'openai') === 'openai'
      ? this.audioKey()
      : this.realtimeKey;
  }
  realtimeCredentials() {
    const key = this.nativeKey();
    if (!key) throw Error('KEY_REQUIRED');
    return { config: realtimeConfig(this.settings), key };
  }
}
