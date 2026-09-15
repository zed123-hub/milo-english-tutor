'use client';

import { useEffect, useRef, useState, useId, type ReactNode } from 'react';
import {
  ArrowRight,
  AudioLines,
  Check,
  Headphones,
  Mic,
  Settings2,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import VoiceSession from '@/components/voice-session';
import Link from 'next/link';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  emptyStudent,
  studentSummary,
  currentTask,
  type Learner,
} from '@/lib/tutor/domain';
import type { Snapshot } from '@/lib/tutor/storage';
import {
  providers,
  defaultConfig,
  type ModelConfig,
  type ProviderId,
} from '@/lib/providers';
import '@/app/tutor.css';

function Choice<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="t-choice">
      <legend>{label}</legend>
      <RadioGroup
        value={value}
        onValueChange={(v) => onChange(v as T)}
        aria-label={label}
      >
        {options.map((o) => (
          <label
            key={o.value}
            className={value === o.value ? 'is-selected' : ''}
          >
            <RadioGroupItem value={o.value} />
            {o.label}
          </label>
        ))}
      </RadioGroup>
    </fieldset>
  );
}
function ProfileForm({
  initial,
  busy,
  save,
}: {
  initial: Learner;
  busy: boolean;
  save: (profile: Learner) => void;
}) {
  const [profile, setProfile] = useState(initial);
  const nameId = useId();
  return (
    <form
      className="t-profile"
      onSubmit={(e) => {
        e.preventDefault();
        save(profile);
      }}
    >
      <label className="t-field" htmlFor={nameId}>
        我怎么称呼你
        <Input
          id={nameId}
          value={profile.name}
          maxLength={40}
          placeholder="你的名字（可以不填）"
          onChange={(e) => setProfile({ ...profile, name: e.target.value })}
        />
      </label>
      <Choice
        label="你现在和英语的关系"
        value={profile.background}
        options={[
          { value: 'beginner', label: '从基础开始' },
          { value: 'learned', label: '学过，但不敢说' },
          { value: 'unsure', label: '说不准，聊聊看' },
        ]}
        onChange={(background) => setProfile({ ...profile, background })}
      />
      <Choice
        label="你最想在哪儿用英语"
        value={profile.goal}
        options={[
          { value: 'life', label: '日常交流' },
          { value: 'travel', label: '旅行出行' },
          { value: 'work', label: '工作沟通' },
        ]}
        onChange={(goal) => setProfile({ ...profile, goal })}
      />
      <Choice
        label="今天留给自己的时间"
        value={profile.minutes}
        options={[
          { value: 5, label: '5 分钟' },
          { value: 10, label: '10 分钟' },
          { value: 15, label: '15 分钟' },
        ]}
        onChange={(minutes) => setProfile({ ...profile, minutes })}
      />
      <Choice
        label="今天的状态"
        value={profile.energy}
        options={[
          { value: 'normal', label: '可以开始' },
          { value: 'low', label: '有点累，轻松一点' },
        ]}
        onChange={(energy) => setProfile({ ...profile, energy })}
      />
      <Button className="t-primary" type="submit" disabled={busy}>
        保存，按这个节奏来
        <ArrowRight />
      </Button>
    </form>
  );
}
export default function TutorApp() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [login, setLogin] = useState(false);
  const [settings, setSettings] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [config, setConfig] = useState<ModelConfig>(defaultConfig);
  const [keys, setKeys] = useState<Partial<Record<ProviderId, string>>>({});
  const [realtimeKey, setRealtimeKey] = useState('');
  const [realtimeModel, setRealtimeModel] = useState('gpt-realtime-mini');
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  function accept(next: Snapshot) {
    snapshotRef.current = next;
    setSnapshot(next);
  }
  async function refresh() {
    const res = await fetch('/api/study', { cache: 'no-store' });
    const next = (await res.json()) as Snapshot & { error?: string };
    if (!res.ok) {
      setLogin(res.status === 401);
      throw Error(next.error || '暂时无法读取学习记录。');
    }
    accept(next);
  }
  useEffect(() => {
    let canceled = false;
    void fetch('/api/study', { cache: 'no-store' })
      .then(async (res) => {
        const next = (await res.json()) as Snapshot & { error?: string };
        if (canceled) return;
        if (!res.ok) {
          setLogin(res.status === 401);
          throw Error(next.error || '暂时无法读取学习记录。');
        }
        snapshotRef.current = next;
        setSnapshot(next);
      })
      .catch((e) => {
        if (!canceled) setError(e.message);
      });
    return () => {
      canceled = true;
    };
  }, []);
  function act(
    action: string,
    data: Record<string, unknown> = {},
  ): Promise<Snapshot> {
    const context = {
      sessionId: snapshot?.state.session?.id,
      taskId: snapshot?.state.session
        ? currentTask(snapshot.state).id
        : undefined,
      taskIndex: snapshot?.state.session?.index,
      attempt: snapshot?.state.session?.retries,
    };
    setBusy(true);
    setError('');
    const operation = queue.current
      .catch(() => {})
      .then(async () => {
        const previous = snapshotRef.current;
        if (!previous) throw Error('请先读取学习记录。');
        const res = await fetch('/api/study', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...data,
            action,
            eventId: crypto.randomUUID(),
            revision: previous.revision,
            ...context,
          }),
        });
        const next = (await res.json()) as Snapshot & { error?: string };
        if (!res.ok) {
          if (res.status === 409) await refresh();
          throw Error(next.error || '这次没有保存成功，请重试。');
        }
        accept(next);
        return next as Snapshot;
      });
    queue.current = operation;
    void operation
      .catch((e) => setError(e.message))
      .finally(() => {
        if (queue.current === operation) setBusy(false);
      });
    return operation;
  }
  function run(action: string, data?: Record<string, unknown>) {
    void act(action, data).catch(() => {});
  }
  const state = snapshot?.state ?? emptyStudent();
  const session = state.session;
  const task = session ? currentTask(state) : null;
  const summary = studentSummary(state);
  const modelName = keys[config.provider]
    ? providers[config.provider].name
    : '内置引导';
  function aside(): ReactNode {
    return (
      <aside className="t-aside">
        <p className="t-eyebrow">LEARNING TO KNOW YOU</p>
        <h2>我正在了解你</h2>
        <p className="t-muted">
          {state.configured
            ? '每一次真实交流，都会帮助我调整下一步。'
            : '先从你的需要开始。接着，我们用几句对话认识你的英语。'}
        </p>
        <div className="t-observations">
          <div>
            <Headphones />
            <span>听懂一句话</span>
            <strong>
              {summary.listening.samples
                ? `${summary.listening.successful} 次观察到`
                : '等待了解'}
            </strong>
          </div>
          <div>
            <Mic />
            <span>独立开口表达</span>
            <strong>
              {summary.speaking.samples
                ? `${summary.speaking.independent} 次观察到`
                : '等待了解'}
            </strong>
          </div>
          <div>
            <Sparkles />
            <span>跨天独立使用</span>
            <strong>
              {summary.activeItems
                ? `${summary.activeItems} 个表达`
                : '慢慢积累'}
            </strong>
          </div>
        </div>
        <p className="t-footnote">
          {summary.typed > 0 ? `另有 ${summary.typed} 次文字练习。` : ''}
          我会区分独立表达与提示后的尝试。目前不评估发音准确度。
        </p>
        <div className="t-note">
          <span className="t-dot" />
          {session && session.status !== 'complete' ? (
            <>
              <h3>为什么这样安排</h3>
              <p>{session.plan.reason}</p>
            </>
          ) : (
            <>
              <h3>你不用自己排课</h3>
              <p>
                先完成眼前的一小步。需要复习、讲解，还是换个场景，我会结合你的表现来安排。
              </p>
            </>
          )}
        </div>
        {state.configured && (
          <Button variant="ghost" onClick={() => setProfileOpen(true)}>
            调整今天的时间和状态
            <ArrowRight />
          </Button>
        )}
      </aside>
    );
  }
  return (
    <main className="t-app">
      <header className="t-header">
        <Link className="t-brand" href="/" aria-label="Milo 首页">
          <AudioLines />
          <span>
            milo<span className="t-brand-dot">.</span>
          </span>
          <small>你的英语导师</small>
        </Link>
        <Button variant="outline" onClick={() => setSettings(true)}>
          <span className="t-dot" />
          {modelName}
          <Settings2 />
        </Button>
      </header>
      <div className="t-layout">
        <section className="t-main">
          {error && (
            <div className="t-error" role="alert">
              {error}
              {login ? (
                // Sign-in is a dispatch-owned, top-level navigation and must never be prefetched.
                // oxlint-disable-next-line next/no-html-link-for-pages
                <a href="/signin-with-chatgpt?return_to=/" target="_top">
                  登录并继续
                </a>
              ) : (
                <Button
                  variant="ghost"
                  onClick={() => {
                    void refresh()
                      .then(() => setError(''))
                      .catch((e) => setError(e.message));
                  }}
                >
                  重新读取
                </Button>
              )}
            </div>
          )}
          {!state.configured ? (
            <>
              <p className="t-eyebrow">
                A LITTLE ENGLISH. A REAL CONVERSATION.
              </p>
              <h1>
                先聊几句，
                <br />
                让我认识你<span>。</span>
              </h1>
              <p className="t-lead">
                我是 Milo。你不用想好怎么学，
                <br className="t-desktop" />
                我会从你会的地方开始，一句一句带你说。
              </p>
              {snapshot ? (
                <ProfileForm
                  initial={state.profile}
                  busy={busy}
                  save={(profile) => {
                    void act('profile', { profile })
                      .then(() => act('start'))
                      .catch(() => {});
                  }}
                />
              ) : (
                <output className="t-muted">
                  {error ? '登录后就可以开始。' : '正在读取你的学习记录…'}
                </output>
              )}
            </>
          ) : !session || session.status === 'complete' ? (
            <>
              <p className="t-eyebrow">
                {session ? 'A SMALL STEP, WELL TAKEN.' : 'YOUR TUTOR IS HERE.'}
              </p>
              <h1>
                {session ? '今天这一小步，' : `${state.profile.name || '嗨'}，`}
                <br />
                {session ? '已经留下了痕迹。' : '我们开始说英语。'}
              </h1>
              <p className="t-lead">
                {session
                  ? '我已经记下你能独立完成的部分，以及需要帮助的地方。下一段对话会接着这些观察来。'
                  : '先做几次轻松的尝试。不用准备，不会的地方我会教你。'}
              </p>
              {session && (
                <div className="t-recap">
                  {session.turns.map((e) => (
                    <div key={e.id}>
                      <Check />
                      <span>
                        {e.transcript}
                        <small>{e.feedback}</small>
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="t-actions">
                <Button
                  className="t-primary"
                  disabled={busy}
                  onClick={() => run('start')}
                >
                  {session ? '继续，听你安排' : '带我开始'}
                  <ArrowRight />
                </Button>
                {state.diagnosticCompleted && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => run('start', { mode: 'morning' })}
                  >
                    只想聊聊今天 · 3 分钟
                  </Button>
                )}
              </div>
            </>
          ) : (
            task && (
              <>
                <div className="t-session-meta">
                  <p className="t-eyebrow">
                    {session.plan.kind === 'diagnostic'
                      ? 'GETTING TO KNOW YOU'
                      : 'ONE CONVERSATION AT A TIME'}
                  </p>
                  <span>
                    {session.index + 1} / {session.plan.taskIds.length} 个小交流
                  </span>
                </div>
                <h1 className="t-task-title">{task.title}</h1>
                <p className="t-lead">{task.instruction}</p>
                <VoiceSession
                  key={`${session.id}:${session.index}:${session.retries}`}
                  task={task}
                  session={session}
                  busy={busy}
                  act={act}
                  evaluation={
                    keys[config.provider]
                      ? { config, apiKey: keys[config.provider] }
                      : realtimeKey || keys.openai
                        ? {
                            config: {
                              provider: 'openai',
                              model: providers.openai.model,
                              baseUrl: providers.openai.baseUrl,
                              tokenParameter: 'max_completion_tokens',
                            },
                            apiKey: realtimeKey || keys.openai,
                          }
                        : { config }
                  }
                  realtimeKey={realtimeKey || keys.openai || ''}
                  realtimeModel={realtimeModel}
                  openSettings={() => setSettings(true)}
                />
              </>
            )
          )}
        </section>
        {aside()}
      </div>
      <footer className="t-footer">
        <span>不赶进度，练习真实发生的交流。</span>
        <span>Milo · 听见你的每一点进步</span>
      </footer>
      <Dialog open={settings} onOpenChange={setSettings}>
        <DialogContent className="t-dialog">
          <DialogTitle>选择你的导师模型</DialogTitle>
          <DialogDescription>
            模型负责理解回答和给出反馈。Key
            仅保留在当前页面，刷新后需要重新填写。
          </DialogDescription>
          <div className="t-settings">
            <Choice
              label="导师与后台评估"
              value={config.provider}
              options={Object.entries(providers).map(([value, p]) => ({
                value: value as ProviderId,
                label: p.name,
              }))}
              onChange={(provider) =>
                setConfig({
                  provider,
                  model: providers[provider].model,
                  baseUrl: providers[provider].baseUrl,
                  tokenParameter:
                    provider === 'openai'
                      ? 'max_completion_tokens'
                      : 'max_tokens',
                })
              }
            />
            <label className="t-field" htmlFor="t-model">
              模型名称
              <Input
                id="t-model"
                value={config.model}
                onChange={(e) =>
                  setConfig({ ...config, model: e.target.value })
                }
              />
            </label>
            {config.provider === 'custom' && (
              <label className="t-field" htmlFor="t-endpoint">
                兼容 API 地址
                <Input
                  id="t-endpoint"
                  value={config.baseUrl}
                  onChange={(e) => {
                    setConfig({ ...config, baseUrl: e.target.value });
                    setKeys({ ...keys, custom: '' });
                  }}
                />
              </label>
            )}
            {config.provider === 'custom' && (
              <Choice
                label="输出长度参数（按服务商要求）"
                value={config.tokenParameter}
                options={[
                  { value: 'max_tokens', label: 'max_tokens' },
                  {
                    value: 'max_completion_tokens',
                    label: 'max_completion_tokens',
                  },
                ]}
                onChange={(tokenParameter) =>
                  setConfig({ ...config, tokenParameter })
                }
              />
            )}
            <label className="t-field" htmlFor="t-api-key">
              {providers[config.provider].name} API Key
              <Input
                id="t-api-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={keys[config.provider] ?? ''}
                onChange={(e) =>
                  setKeys({ ...keys, [config.provider]: e.target.value.trim() })
                }
              />
            </label>
            <hr />
            <h3>自然语音对话</h3>
            <p className="t-muted">
              连接 OpenAI
              Realtime，可直接用声音交流与打断。未连接时可用浏览器语音分轮练习。若未填写独立的导师
              Key，后台评估会使用此 Key 调用 GPT。
            </p>
            <label className="t-field" htmlFor="t-voice-key">
              OpenAI API Key
              <Input
                id="t-voice-key"
                type="password"
                autoComplete="off"
                value={realtimeKey}
                onChange={(e) => setRealtimeKey(e.target.value.trim())}
              />
            </label>
            <label className="t-field" htmlFor="t-voice-model">
              语音模型
              <Input
                id="t-voice-model"
                value={realtimeModel}
                onChange={(e) => setRealtimeModel(e.target.value)}
              />
            </label>
            <Button className="t-primary" onClick={() => setSettings(false)}>
              完成设置
              <Check />
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={profileOpen} onOpenChange={setProfileOpen}>
        <DialogContent className="t-dialog">
          <DialogTitle>按今天的状态来</DialogTitle>
          <DialogDescription>
            当前对话保留，新的安排会使用这些偏好。
          </DialogDescription>
          <ProfileForm
            initial={state.profile}
            busy={busy}
            save={(profile) => {
              void act('profile', { profile })
                .then(() => setProfileOpen(false))
                .catch(() => {});
            }}
          />
        </DialogContent>
      </Dialog>
    </main>
  );
}
