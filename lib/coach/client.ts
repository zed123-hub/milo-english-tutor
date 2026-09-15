import type { SubtitlePair } from './captions';
import type { Snapshot } from './model';
import type { LocalSettings } from '../../local/settings';
export type PublicSettings = LocalSettings & {
  teacherKeyConfigured: boolean;
  voiceKeyConfigured: boolean;
  realtimeKeyConfigured?: boolean;
  evaluatorKeyConfigured?: boolean;
  conversationReady?: boolean;
  ready: boolean;
};
export type ApiResult = {
  snapshot?: Snapshot;
  settings?: PublicSettings;
  hasRecovery?: boolean;
  speech?: string;
  speakingRate?: number;
  subtitles?: SubtitlePair[];
  turnId?: string;
  instructions?: string;
  sdp?: string;
  ticket?: string;
  inputRate?: number;
  outputRate?: number;
  text?: string;
  error?: string;
  code?: string;
};
export class LocalApiError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
export class CoachClient {
  snapshot: Snapshot | null = null;
  settings: PublicSettings | null = null;
  hasRecovery = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private changed: () => void) {}
  async request(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<ApiResult> {
    const res = await fetch('/api/local/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'X-Milo-Local': '1',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(35000)])
        : AbortSignal.timeout(35000),
      cache: 'no-store',
    });
    let result: ApiResult;
    try {
      result = (await res.json()) as ApiResult;
    } catch {
      throw Error('本机服务没有响应，请确认已用本地启动命令运行。');
    }
    if (
      result.snapshot &&
      (!this.snapshot || result.snapshot.revision >= this.snapshot.revision)
    )
      this.snapshot = result.snapshot;
    if (result.settings) this.settings = result.settings;
    if (result.hasRecovery !== undefined) this.hasRecovery = result.hasRecovery;
    this.changed();
    if (!res.ok)
      throw new LocalApiError(
        result.error ?? '操作没有完成，请重试。',
        result.code,
      );
    return result;
  }
  async load() {
    return this.request('bootstrap');
  }
  command(
    action: string,
    body: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) {
    const commandId = crypto.randomUUID();
    const epoch = this.snapshot?.epoch;
    const sessionId = this.snapshot?.data.activeSessionId;
    const result = this.queue
      .catch(() => {})
      .then(async () => {
        if (!this.snapshot || this.snapshot.epoch !== epoch)
          throw Error('数据已切换，请重新开始对话。');
        const send = () =>
          this.request(
            action,
            {
              ...body,
              commandId,
              revision: this.snapshot!.revision,
              epoch,
              sessionId,
            },
            signal,
          );
        try {
          return await send();
        } catch (error) {
          // A background analysis can advance revision between speech turns. Retry once
          // only within this same dataset and conversation, preserving command identity.
          if (
            error instanceof LocalApiError &&
            error.code === 'CONFLICT' &&
            this.snapshot?.epoch === epoch &&
            this.snapshot.data.activeSessionId === sessionId &&
            !signal?.aborted
          )
            return send();
          throw error;
        }
      });
    this.queue = result;
    return result;
  }
  async settled() {
    await this.queue.catch(() => {});
  }
}
