'use client';
import { CoachCaptions } from '@/components/coach-captions';
import { CoachTeachingView } from '@/components/coach-teaching-view';
import {
  captionReducer,
  nextCaptionMode,
  type CaptionCue,
  type CaptionMode,
  type CaptionEvent,
} from '@/lib/coach/captions';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import {
  Captions,
  BrainCircuit,
  AudioLines,
  Mic,
  Square,
  Settings2,
  ArrowUpRight,
  Sparkles,
  HardDrive,
  Download,
  Upload,
  RotateCcw,
  Check,
  ChevronRight,
  GitBranch,
  Headphones,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { VoiceCoach } from '@/lib/coach/voice-coach';
import { CoachClient, type PublicSettings } from '@/lib/coach/client';
import { skillProgress } from '@/lib/coach/learning-engine';
import { accomplishments, freshData } from '@/lib/coach/model';
import {
  providers,
  defaultConfig,
  type ProviderId,
  type ModelConfig,
} from '@/lib/providers';
import type { LocalSettings } from '@/local/settings';
import {
  realtimeProviders,
  type RealtimeProvider,
} from '@/lib/coach/realtime-providers';
import '@/app/coach.css';

const settingsDefault: LocalSettings = {
  teacher: defaultConfig,
  evaluator: defaultConfig,
  voiceMode: 'browser',
  realtimeModel: 'gpt-realtime-2.1-mini',
  asrModel: 'gpt-4o-mini-transcribe',
  ttsModel: 'gpt-4o-mini-tts',
  voice: 'marin',
};
function ModelFields({
  label,
  prefix,
  config,
  onChange,
  apiKey,
  setKey,
  configured,
}: {
  label: string;
  prefix: string;
  config: ModelConfig;
  onChange: (c: ModelConfig) => void;
  apiKey: string;
  setKey: (s: string) => void;
  configured?: boolean;
}) {
  return (
    <fieldset className="c-model-role">
      <legend>{label}</legend>
      <RadioGroup
        className="c-choices"
        value={config.provider}
        onValueChange={(v) => {
          const provider = v as ProviderId;
          setKey('');
          onChange({
            provider,
            model: providers[provider].model,
            baseUrl: providers[provider].baseUrl,
            tokenParameter:
              provider === 'openai' ? 'max_completion_tokens' : 'max_tokens',
          });
        }}
      >
        {Object.entries(providers).map(([id, p]) => (
          <label key={id}>
            <RadioGroupItem value={id} />
            {p.name}
          </label>
        ))}
      </RadioGroup>
      {config.provider === 'deepseek' && (
        <div className="grid gap-2">
          <label htmlFor={prefix + '-model-preset'}>DeepSeek 模型</label>
          <Select
            value={
              config.model === 'deepseek-flash' ||
              config.model === 'deepseek-v4-flash'
                ? config.model
                : 'custom'
            }
            onValueChange={(model) => {
              if (model)
                onChange({
                  ...config,
                  model: model === 'custom' ? '' : model,
                });
            }}
          >
            <SelectTrigger
              id={prefix + '-model-preset'}
              className="h-11 w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="deepseek-flash">V4.1 Flash（最新）</SelectItem>
              <SelectItem value="deepseek-v4-flash">
                V4 Flash（旧别名，暂时兼容）
              </SelectItem>
              <SelectItem value="custom">其他模型（下方填写）</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      <label htmlFor={prefix + '-model'}>
        模型名称
        <Input
          id={prefix + '-model'}
          value={config.model}
          required
          onChange={(e) => onChange({ ...config, model: e.target.value })}
        />
      </label>
      {['custom', 'qwen'].includes(config.provider) && (
        <label htmlFor={prefix + '-url'}>
          API 地址
          {config.provider === 'qwen' && (
            <small>填写与你的 Key 同地域的百炼兼容地址</small>
          )}
          <Input
            id={prefix + '-url'}
            value={config.baseUrl}
            required
            onChange={(e) => {
              setKey('');
              onChange({ ...config, baseUrl: e.target.value });
            }}
          />
        </label>
      )}
      <label htmlFor={prefix + '-key'}>
        API Key{' '}
        {configured && <small>本次运行已配置；服务地址未变时可留空沿用</small>}
        <Input
          id={prefix + '-key'}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          onChange={(e) => setKey(e.target.value.trim())}
          placeholder="仅保存在本机服务内存"
        />
      </label>
    </fieldset>
  );
}
function ModelSettings({
  value,
  save,
  busy,
}: {
  value: PublicSettings | null;
  save: (
    v: LocalSettings & {
      teacherKey: string;
      evaluatorKey: string;
      voiceKey: string;
      realtimeKey: string;
    },
  ) => void;
  busy: boolean;
}) {
  const [form, setForm] = useState<LocalSettings>(value ?? settingsDefault);
  const [teacherKey, setTeacherKey] = useState(''),
    [evaluatorKey, setEvaluatorKey] = useState(''),
    [voiceKey, setVoiceKey] = useState(''),
    [realtimeKey, setRealtimeKey] = useState('');
  const rtProvider = form.realtimeProvider ?? 'openai';
  return (
    <form
      className="c-settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        save({ ...form, teacherKey, evaluatorKey, voiceKey, realtimeKey });
      }}
    >
      <fieldset>
        <legend>01 · 实时交流</legend>
        <p className="c-muted">这位老师负责听你说、带着你接着聊。</p>
        <RadioGroup
          className="c-mode-choices"
          value={form.voiceMode}
          onValueChange={(v) =>
            setForm({ ...form, voiceMode: v as LocalSettings['voiceMode'] })
          }
        >
          <label htmlFor="mode-realtime">
            <RadioGroupItem id="mode-realtime" value="realtime" />
            <span>
              自然实时语音<small>模型直接听和说，支持开口打断</small>
            </span>
          </label>
          <label htmlFor="mode-audio">
            <RadioGroupItem id="mode-audio" value="audio" />
            <span>
              语音服务 + 自选对话模型
              <small>OpenAI 听写与发声，自选模型接续交流</small>
            </span>
          </label>
          <label htmlFor="mode-browser">
            <RadioGroupItem id="mode-browser" value="browser" />
            <span>
              系统语音 + 自选对话模型
              <small>使用浏览器听写与朗读，不需要额外声音 Key</small>
            </span>
          </label>
        </RadioGroup>
      </fieldset>
      {form.voiceMode !== 'realtime' && (
        <ModelFields
          label="对话模型"
          prefix="live"
          config={form.teacher}
          onChange={(teacher) => setForm({ ...form, teacher })}
          apiKey={teacherKey}
          setKey={setTeacherKey}
          configured={value?.teacherKeyConfigured}
        />
      )}
      {form.voiceMode !== 'browser' && (
        <fieldset className="c-model-role">
          <legend>
            {form.voiceMode === 'realtime' ? '原生实时声音' : 'OpenAI 声音服务'}
          </legend>
          {form.voiceMode === 'realtime' && (
            <>
              <RadioGroup
                className="c-choices"
                value={rtProvider}
                onValueChange={(value) => {
                  const provider = value as RealtimeProvider;
                  const preset = realtimeProviders[provider];
                  setRealtimeKey('');
                  setVoiceKey('');
                  setForm({
                    ...form,
                    realtimeProvider: provider,
                    realtimeModel: preset.model,
                    realtimeBaseUrl: preset.endpoint,
                    realtimeVoice: preset.voice,
                  });
                }}
              >
                {Object.entries(realtimeProviders).map(([id, p]) => (
                  <label key={id}>
                    <RadioGroupItem value={id} />
                    {p.name}
                  </label>
                ))}
              </RadioGroup>
              {rtProvider === 'qwen' && (
                <label htmlFor="rt-endpoint">
                  实时服务地址
                  <small>
                    选择 Key 所在地域的 WebSocket 地址；支持百炼专属域名
                  </small>
                  <Input
                    id="rt-endpoint"
                    value={
                      form.realtimeBaseUrl ?? realtimeProviders.qwen.endpoint
                    }
                    required
                    onChange={(e) => {
                      setRealtimeKey('');
                      setForm({ ...form, realtimeBaseUrl: e.target.value });
                    }}
                  />
                  <div className="c-choices">
                    {[
                      ['北京', realtimeProviders.qwen.endpoint],
                      [
                        '新加坡',
                        'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime',
                      ],
                    ].map(([label, url]) => (
                      <Button
                        key={url}
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setRealtimeKey('');
                          setForm({ ...form, realtimeBaseUrl: url });
                        }}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                </label>
              )}
            </>
          )}
          <label htmlFor="voice-key">
            语音 API Key{' '}
            {(form.voiceMode !== 'realtime' || rtProvider === 'openai'
              ? value?.voiceKeyConfigured
              : value?.realtimeProvider === rtProvider &&
                value?.realtimeBaseUrl === form.realtimeBaseUrl &&
                value?.realtimeKeyConfigured) && (
              <small>已配置，留空沿用</small>
            )}
            <Input
              id="voice-key"
              type="password"
              autoComplete="off"
              value={
                form.voiceMode === 'realtime' && rtProvider !== 'openai'
                  ? realtimeKey
                  : voiceKey
              }
              onChange={(e) =>
                (form.voiceMode === 'realtime' && rtProvider !== 'openai'
                  ? setRealtimeKey
                  : setVoiceKey)(e.target.value.trim())
              }
              placeholder={
                form.voiceMode === 'realtime' && rtProvider !== 'openai'
                  ? `填写 ${realtimeProviders[rtProvider].name} 的 Key，仅保留在服务内存`
                  : '使用相同 OpenAI 账号时可共用下方 Key'
              }
            />
          </label>
          {form.voiceMode === 'realtime' ? (
            <>
              <label htmlFor="rt-model">
                实时语音模型
                <Input
                  id="rt-model"
                  value={form.realtimeModel}
                  required
                  onChange={(e) =>
                    setForm({ ...form, realtimeModel: e.target.value })
                  }
                />
              </label>
              <label htmlFor="rt-voice">
                声音
                <Input
                  id="rt-voice"
                  required
                  value={
                    form.realtimeVoice ?? realtimeProviders[rtProvider].voice
                  }
                  onChange={(e) =>
                    setForm({ ...form, realtimeVoice: e.target.value })
                  }
                />
              </label>
              {rtProvider === 'qwen' && (
                <p className="c-muted">
                  支持 Qwen3.5 Omni Flash / Plus Realtime。课后分析 Key
                  请在下方单独填写。
                </p>
              )}
              {rtProvider === 'glm' && (
                <p className="c-muted">
                  支持 GLM Realtime Air / Flash。课后分析 Key 请在下方单独填写。
                </p>
              )}
            </>
          ) : (
            <div className="c-two-fields">
              <label htmlFor="asr-model">
                听写模型
                <Input
                  id="asr-model"
                  value={form.asrModel}
                  required
                  onChange={(e) =>
                    setForm({ ...form, asrModel: e.target.value })
                  }
                />
              </label>
              <label htmlFor="tts-model">
                声音模型
                <Input
                  id="tts-model"
                  value={form.ttsModel}
                  required
                  onChange={(e) =>
                    setForm({ ...form, ttsModel: e.target.value })
                  }
                />
              </label>
            </div>
          )}
        </fieldset>
      )}
      <ModelFields
        label="02 · 课后分析与教学安排"
        prefix="analysis"
        config={form.evaluator ?? form.teacher}
        onChange={(evaluator) => setForm({ ...form, evaluator })}
        apiKey={evaluatorKey}
        setKey={setEvaluatorKey}
        configured={value?.evaluatorKeyConfigured}
      />
      <p className="c-muted">
        对话结束后整理真实表现、更新记忆和下一次的带法。两种职责可以选不同模型；服务地址相同时，分析
        Key 留空可共用对话 Key。整理期间可以继续说英语。
      </p>
      <p className="c-privacy">
        <HardDrive />
        Key
        只保存在本次本机服务运行内存，重启后需重填。声音与必要的对话会发给所选服务商，可能产生
        API 费用。
      </p>
      <Button type="submit" className="c-primary" disabled={busy}>
        {busy ? '正在保存配置…' : '保存，开始和 Milo 说话'}
        <ArrowUpRight />
      </Button>
    </form>
  );
}
export default function CoachApp() {
  const [, render] = useState(0);
  const [client] = useState(() => new CoachClient(() => render((n) => n + 1)));
  const [page, setPage] = useState(() =>
    typeof window !== 'undefined' ? window.location.pathname : '/',
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('idle');
  const [message, setMessage] = useState('');
  const [captionMode, setCaptionMode] = useState<CaptionMode>('off');
  const [captions, setCaptions] = useState<CaptionCue[]>([]);
  const [teachingOpen, setTeachingOpen] = useState(false);
  const dispatchCaption = useCallback(
    (event: CaptionEvent) =>
      setCaptions((current) => captionReducer(current, event)),
    [],
  );
  const voice = useRef<{
    start: () => Promise<void>;
    stop: () => Promise<void>;
    interrupt: () => void;
  } | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [importFile, setImportFile] = useState<{
    backup: unknown;
    summary: {
      conversations: number;
      turns: number;
      memories: number;
      facts: number;
      legacy: boolean;
    };
  } | null>(null);
  useEffect(() => {
    void client.load().catch((e) => setError(e.message));
    const pop = () => setPage(window.location.pathname);
    window.addEventListener('popstate', pop);
    return () => {
      window.removeEventListener('popstate', pop);
      void voice.current?.stop();
    };
  }, [client]);
  const data = client.snapshot?.data ?? freshData();
  const growth = accomplishments(data);
  const heardOnly = skillProgress(data).filter(
    (p) => p.exposures && !p.assisted && !p.independent,
  );
  const pendingAnalyses = data.analyses.filter((j) => j.status !== 'complete');
  useEffect(() => {
    if (!pendingAnalyses.length) return;
    let cancelled = false;
    const timer = setInterval(() => {
      if (!cancelled) void client.load().catch(() => {});
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, pendingAnalyses.length]);
  const active = !['idle', 'paused', 'error'].includes(status);
  function navigate(path: string) {
    window.history.pushState({}, '', path);
    setPage(path);
  }
  async function begin() {
    setError('');
    if (!client.settings?.ready) {
      setSettingsOpen(true);
      return;
    }
    setStatus('connecting');
    dispatchCaption({ type: 'clear' });
    try {
      const instance = new VoiceCoach(client, {
        caption: (event) => {
          if (voice.current === instance) dispatchCaption(event);
        },
        status: (s) => {
          if (voice.current === instance) setStatus(s);
        },
        error: (s) => {
          if (voice.current === instance) setError(s);
        },
        message: (s) => {
          if (voice.current === instance) setMessage(s);
        },
      });
      voice.current = instance;
      await instance.start();
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : '无法开始语音对话。');
    }
  }
  async function saveSettings(
    v: LocalSettings & {
      teacherKey: string;
      evaluatorKey: string;
      voiceKey: string;
    },
  ) {
    setBusy(true);
    setError('');
    try {
      await client.request('settings', v);
      if (!client.settings?.ready)
        throw Error('请补充对话与课后分析所需的 Key；两种模型可分别配置。');
      setSettingsOpen(false);
      await begin();
    } catch (e) {
      setError(e instanceof Error ? e.message : '配置未保存。');
    } finally {
      setBusy(false);
    }
  }
  async function exportData() {
    try {
      await client.settled();
      const res = await fetch('/api/local/export', {
        headers: { 'X-Milo-Local': '1' },
      });
      if (!res.ok) {
        const failure = (await res.json()) as { error?: string };
        throw Error(failure.error ?? '导出失败，请重试。');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `milo-learning-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function inspectFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    try {
      if (file.size > 20 * 1024 * 1024) throw Error('备份文件不能超过20 MB。');
      const backup: unknown = JSON.parse(await file.text());
      const res = (await client.request('import/inspect', {
        backup,
      })) as unknown as {
        conversations: number;
        turns: number;
        memories: number;
        facts: number;
        legacy: boolean;
      };
      setImportFile({ backup, summary: res });
    } catch (error) {
      setError(
        error instanceof SyntaxError
          ? '文件不是有效备份。'
          : (error as Error).message,
      );
    }
  }
  async function importData() {
    if (!importFile) return;
    setBusy(true);
    try {
      await voice.current?.stop();
      await client.settled();
      await client.request('import', {
        backup: importFile.backup,
        revision: client.snapshot?.revision,
        epoch: client.snapshot?.epoch,
      });
      setImportFile(null);
      dispatchCaption({ type: 'clear' });
      setMessage('学情和记忆已带到这里。下一次对话，Milo 会接着了解你。');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const labels: Record<string, string> = {
    idle: '准备好，我们就开始',
    microphone: '等待麦克风授权，请留意浏览器提示',
    audio: '正在准备声音播放',
    connecting: '正在接通你的导师',
    saving: '语音已暂停，正在保存这次交流',
    listening: '我在听，你慢慢说',
    thinking: '让我想想，怎么接着聊',
    speaking: '听我说一句，再轮到你',
    paused: '下次，我们接着聊',
    error: '调整一下，再继续',
  };
  return (
    <SidebarProvider
      className={`c-app ${teachingOpen ? 'is-teaching-open' : ''} ${captionMode !== 'off' ? 'has-captions' : ''}`}
      style={{ '--sidebar-width': '235px' } as React.CSSProperties}
    >
      <Sidebar className="c-sidebar">
        <SidebarHeader>
          <div className="c-logo">
            <AudioLines />
            <span>
              milo<span>.</span>
            </span>
          </div>
          <p>一个只属于你的英语导师</p>
        </SidebarHeader>
        <SidebarContent>
          <SidebarMenu>
            {[
              { path: '/', label: '和 Milo 说英语', icon: Mic },
              { path: '/growth', label: '成长足迹', icon: Sparkles },
              { path: '/memory', label: '记忆与迁移', icon: HardDrive },
            ].map((item) => (
              <SidebarMenuItem key={item.path}>
                <SidebarMenuButton
                  isActive={page === item.path}
                  onClick={() => navigate(item.path)}
                >
                  <item.icon />
                  <span>{item.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
          <div className="c-roadmap">
            <div>
              <GitBranch />
              <span>你的私人英语导师</span>
            </div>
            <p>现在可以一起做的事</p>
            <ul>
              <li>
                <span />
                用声音自然交流
              </li>
              <li>
                <span />
                课后整理与接续教学
              </li>
              <li>
                <span />
                听说足迹与本机迁移
              </li>
            </ul>
          </div>
        </SidebarContent>
        <SidebarFooter>
          <span>
            <span className="c-dot" />
            本机存储 · 无账号
          </span>
          <small>开源，自用，也欢迎一起改进。</small>
        </SidebarFooter>
      </Sidebar>
      <main className="c-main">
        <header className="c-top">
          <div>
            <SidebarTrigger />
            <span>
              {page === '/growth'
                ? '成长足迹'
                : page === '/memory'
                  ? '记忆与迁移'
                  : '一起，把英语用起来'}
            </span>
          </div>
          <Button
            variant="outline"
            disabled={active}
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 />
            {client.settings?.ready ? '模型已连接' : '连接我的模型'}
          </Button>
        </header>
        {error && (
          <div className="c-error" role="alert">
            {error}
            <Button
              variant="ghost"
              onClick={() => {
                void client
                  .load()
                  .then(() => setError(''))
                  .catch((e) => setError(e.message));
              }}
            >
              重新读取
            </Button>
          </div>
        )}
        {active && page !== '/' && (
          <Button
            variant="outline"
            disabled={status === 'saving'}
            onClick={() => {
              void voice.current?.stop();
            }}
          >
            <Square />
            语音连接中 · 暂停交流
          </Button>
        )}
        {message && page !== '/' && (
          <output className="c-muted">{message}</output>
        )}
        {page === '/' ? (
          <section className="c-talk">
            <p className="c-eyebrow">YOUR ENGLISH, OUT LOUD.</p>
            <h1>{active ? '一段对话，正在发生。' : '开口，就是开始。'}</h1>
            <p className="c-lead">
              {active
                ? '不用组织完美的句子。听一听，说一说，我会陪你接下去。'
                : '没有课表，也没有入学问卷。让我从声音里认识你。'}
            </p>
            <div className={`c-voice-orbit ${active ? 'is-active' : ''}`}>
              <div className="c-wave" aria-hidden="true">
                {[18, 34, 54, 32, 44, 24, 16].map((h, i) => (
                  <span
                    key={i}
                    style={{ height: h, animationDelay: `${i * 0.12}s` }}
                  />
                ))}
              </div>
            </div>
            <output className="c-voice-status">
              <span className="c-dot" />
              {labels[status] ?? status}
            </output>
            <div className="c-talk-actions">
              {active ? (
                <>
                  <Button
                    className="c-primary"
                    disabled={status === 'saving'}
                    onClick={() => {
                      void voice.current?.stop();
                    }}
                  >
                    <Square />
                    暂停，我想休息一下
                  </Button>
                  {status === 'speaking' && (
                    <Button
                      variant="outline"
                      onClick={() => voice.current?.interrupt()}
                    >
                      <Mic />
                      我想说一句
                    </Button>
                  )}
                </>
              ) : (
                <Button
                  className="c-primary"
                  disabled={!client.snapshot || busy}
                  onClick={() => {
                    void begin();
                  }}
                >
                  <Mic />
                  {client.settings?.ready
                    ? '开始和 Milo 说话'
                    : '配置 API，开始对话'}
                  <ArrowUpRight />
                </Button>
              )}
            </div>
            <div className="c-conversation-tools">
              <Button
                variant="ghost"
                aria-pressed={captionMode !== 'off'}
                aria-label={`字幕：${{ off: '关闭，点击显示英文字幕', english: '英文，点击显示中英字幕', bilingual: '中英，点击关闭字幕' }[captionMode]}`}
                onClick={() => setCaptionMode(nextCaptionMode(captionMode))}
              >
                <Captions />
                字幕 ·{' '}
                {
                  { off: '关闭', english: 'English', bilingual: '中英' }[
                    captionMode
                  ]
                }
              </Button>
              <Button
                variant="ghost"
                aria-expanded={teachingOpen}
                onClick={() => setTeachingOpen(!teachingOpen)}
              >
                <BrainCircuit />
                教学思路
              </Button>
            </div>
            <p className="c-disclosure">
              {message ||
                '开始后会申请麦克风权限。Milo 是 AI 导师，声音由模型或系统合成。'}
            </p>
            <div className="c-dialogue-note">
              <Headphones />
              <p>
                听不懂，可以说 “Please say it again.”
                <br />
                我会用更简单的英语，陪你再试一次。
              </p>
            </div>
          </section>
        ) : page === '/growth' ? (
          <section className="c-content">
            <p className="c-eyebrow">IT’S ALREADY BECOMING YOURS.</p>
            <h1>原来，我已经说过这么多。</h1>
            <p className="c-lead">这些足迹，来自你和导师真正发生过的交流。</p>
            <div className="c-stats">
              <div>
                <strong>{growth.turns}</strong>
                <span>次开口尝试</span>
              </div>
              <div>
                <strong>
                  {Math.floor(growth.seconds / 60)}
                  <small>分</small>
                  {growth.seconds % 60}
                  <small>秒</small>
                </strong>
                <span>记录到的说话时间</span>
              </div>
              <div>
                <strong>{growth.phrases.length}</strong>
                <span>实际用过的表达</span>
              </div>
              <div>
                <strong>{growth.days}</strong>
                <span>天留下声音足迹</span>
              </div>
            </div>
            {pendingAnalyses.length > 0 && (
              <section className="c-analysis-status" aria-live="polite">
                <div>
                  <h3>正在整理交流足迹</h3>
                  <p>
                    已保存原始对话。
                    {pendingAnalyses.some((j) => j.status === 'failed')
                      ? '有一次整理未完成，修正模型设置后可以接着整理。'
                      : pendingAnalyses.every((j) => j.status === 'waiting')
                        ? '补好分析模型的 Key 后，老师会接着整理。'
                        : '分析在后台进行，你可以继续交流。'}
                  </p>
                  <small>
                    {pendingAnalyses.reduce((n, j) => n + j.cursor, 0)} /{' '}
                    {pendingAnalyses.reduce((n, j) => n + j.turnIds.length, 0)}{' '}
                    条表达已整理
                  </small>
                </div>
                {pendingAnalyses.some(
                  (j) => j.status === 'failed' || j.status === 'waiting',
                ) && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void client
                        .command('analysis/retry')
                        .catch((e) => setError(e.message))
                        .finally(() => setBusy(false));
                    }}
                  >
                    继续整理
                  </Button>
                )}
              </section>
            )}
            <h2>正在成为你的表达</h2>
            {growth.phrases.length ? (
              <div className="c-phrases">
                {growth.phrases.map((p) => (
                  <article key={p.phrase}>
                    <div>
                      <h3>{p.phrase}</h3>
                      <span>{p.stage}</span>
                    </div>
                    <p>{p.meaning}</p>
                    <small>
                      {p.independent} 次独立使用 · {p.assisted} 次在帮助下尝试
                    </small>
                  </article>
                ))}
              </div>
            ) : (
              <div className="c-empty">
                <Sparkles />
                <p>第一段对话之后，这里会慢慢长出你的英语。</p>
                <small>每一条表达，都对应一次真实的语音尝试。</small>
              </div>
            )}
            {heardOnly.length > 0 && (
              <>
                <h2>耳朵已经遇见的表达</h2>
                <p className="c-muted">
                  这些来自已播放的老师示范，等你在对话中自己用出来。
                </p>
                <div className="c-phrases">
                  {heardOnly.map((p) => (
                    <article key={p.phrase}>
                      <div>
                        <h3>{p.phrase}</h3>
                        <span>听过示范</span>
                      </div>
                      <p>{p.meaning}</p>
                    </article>
                  ))}
                </div>
              </>
            )}
            <h2>我们聊过的日子</h2>
            {data.sessions.length ? (
              data.sessions
                .slice()
                .reverse()
                .map((s) => (
                  <details className="c-history" key={s.id}>
                    <summary>
                      <span>
                        {new Date(s.startedAt).toLocaleString('zh-CN')}
                      </span>
                      <span>
                        {
                          data.turns.filter(
                            (t) => t.sessionId === s.id && t.role === 'user',
                          ).length
                        }{' '}
                        次开口
                        <ChevronRight />
                      </span>
                    </summary>
                    <p>
                      {s.summary ||
                        '这段交流已保存，课后分析完成后会显示摘要。'}
                    </p>
                    {data.turns
                      .filter((t) => t.sessionId === s.id)
                      .map((t) => (
                        <div className="c-history-turn" key={t.id}>
                          <strong>{t.role === 'user' ? '你' : 'Milo'}</strong>
                          <p>{t.text}</p>
                        </div>
                      ))}
                  </details>
                ))
            ) : (
              <p className="c-muted">还没有对话记录。</p>
            )}
            <p className="c-muted c-small">
              这里记录真实使用和提示情况，暂不评发音分数，也不据此宣布英语等级。
            </p>
          </section>
        ) : (
          <section className="c-content">
            <p className="c-eyebrow">YOUR LEARNING STAYS WITH YOU.</p>
            <h1>换个设备，老师依然认识你。</h1>
            <p className="c-lead">
              画像、完整对话、导师记忆、下一步安排和学习成果，都跟你一起走。
            </p>
            <div className="c-transfer">
              <HardDrive />
              <div>
                <h2>一份完整的学习备份</h2>
                <p>
                  在新设备部署好 Milo，导入备份、重新配置自己的
                  Key，便能接着交流。
                </p>
                <div>
                  <Button
                    className="c-primary"
                    disabled={busy}
                    onClick={() => {
                      void exportData();
                    }}
                  >
                    <Download />
                    导出我的学习记忆
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || active}
                    onClick={() => fileInput.current?.click()}
                  >
                    <Upload />
                    导入另一台设备的备份
                  </Button>
                </div>
                <input
                  ref={fileInput}
                  className="sr-only"
                  type="file"
                  accept=".json,application/json"
                  onChange={(e) => {
                    void inspectFile(e);
                  }}
                  aria-label="选择学习备份"
                />
                <small>
                  迁移包不包含 API Key
                  或录音文件。对话原文属于你的私人数据，请妥善保管。
                </small>
              </div>
            </div>
            {client.hasRecovery && (
              <Button
                variant="ghost"
                disabled={active || busy}
                onClick={() => {
                  setBusy(true);
                  void client
                    .request('restore', {
                      revision: client.snapshot?.revision,
                      epoch: client.snapshot?.epoch,
                    })
                    .then(() => setMessage('已恢复到导入前的学习记忆。'))
                    .catch((e) => setError(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                <RotateCcw />
                恢复到上次导入前
              </Button>
            )}
            <h2>导师从交流中认识的你</h2>
            {data.facts.length ? (
              <div className="c-facts">
                {data.facts.map((f) => (
                  <article key={f.id}>
                    <span>
                      {
                        {
                          name: '称呼',
                          interest: '兴趣',
                          goal: '想用英语做的事',
                          difficulty: '需要一点帮助',
                          context: '日常生活',
                        }[f.kind]
                      }
                    </span>
                    <p>{f.text}</p>
                    <small>来自你说的：“{f.quote}”</small>
                  </article>
                ))}
              </div>
            ) : (
              <p className="c-muted">
                这里现在是空的。我们会在聊天中慢慢了解，不需要填写资料。
              </p>
            )}
            <h2>下一步，老师准备这样带你</h2>
            <div className="c-plan">
              <h3>{data.plan.focus}</h3>
              <p>{data.plan.reason}</p>
              {data.plan.review.length > 0 && (
                <small>会在交流里再用到：{data.plan.review.join(' · ')}</small>
              )}
            </div>
            {data.legacy && (
              <p className="c-muted">
                保留了一份旧版学情档案，文字练习不会转算为新版本的口语成果。
              </p>
            )}
            <p className="c-muted c-small">
              完整学习记录保存在本机。导出后可在另一台部署了 Milo
              的设备上接着用。
            </p>
          </section>
        )}
        {page === '/' && (
          <CoachCaptions
            mode={captionMode}
            cues={captions}
            client={client}
            dispatch={dispatchCaption}
          />
        )}
      </main>
      <CoachTeachingView
        open={teachingOpen}
        onOpenChange={setTeachingOpen}
        data={data}
        status={status}
        pause={() => {
          void voice.current?.stop();
        }}
      />
      <Dialog
        open={settingsOpen}
        onOpenChange={(open) => {
          if (!busy) setSettingsOpen(open);
        }}
      >
        <DialogContent className="c-dialog">
          <DialogTitle>连接你自己的模型</DialogTitle>
          <DialogDescription>
            配置好，我们就开始用声音交流。这里不需要注册。
          </DialogDescription>
          {error && (
            <p className="c-error" role="alert">
              {error}
            </p>
          )}
          <ModelSettings
            key={settingsOpen ? 'open' : 'closed'}
            value={client.settings}
            busy={busy}
            save={(v) => {
              void saveSettings(v);
            }}
          />
          {(client.settings?.teacherKeyConfigured ||
            client.settings?.voiceKeyConfigured ||
            client.settings?.evaluatorKeyConfigured) && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                void client
                  .request('settings', { ...client.settings, forgetKeys: true })
                  .catch((e) => setError(e.message));
              }}
            >
              从运行内存中清除 Key
            </Button>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!importFile}
        onOpenChange={(open) => {
          if (!open && !busy) setImportFile(null);
        }}
      >
        <DialogContent className="c-dialog">
          <DialogTitle>把这份学习记忆带过来</DialogTitle>
          <DialogDescription>
            将替换当前学习数据；Milo 会先自动保存一个完整恢复点。模型 Key
            保持独立，不会从文件中导入。
          </DialogDescription>
          <p>
            {importFile?.summary.conversations} 段交流 ·{' '}
            {importFile?.summary.turns} 条对话 · {importFile?.summary.memories}{' '}
            段导师记忆 · {importFile?.summary.facts} 条画像事实
          </p>
          {error && (
            <p className="c-error" role="alert">
              {error}
            </p>
          )}
          {importFile?.summary.legacy && (
            <p>
              这是旧版学情，仅迁移实际保存的数据，不虚构以前没有记录的聊天。
            </p>
          )}
          <Button
            className="c-primary"
            disabled={busy}
            onClick={() => {
              void importData();
            }}
          >
            <Check />
            {busy ? '正在迁移…' : '保存恢复点并导入'}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setImportFile(null)}
          >
            暂不导入
          </Button>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  );
}
