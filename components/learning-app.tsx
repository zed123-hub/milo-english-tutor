'use client';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Flame,
  Headphones,
  Home,
  Lightbulb,
  Loader2,
  LockKeyhole,
  MessageCircle,
  Mic,
  Play,
  Plus,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Target,
  Volume2,
  X,
  CalendarDays,
  Download,
  CircleHelp,
} from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { lessons, allPhrases, isCorrect } from '@/lib/curriculum';
import {
  initialProgress,
  parseProgress,
  dayKey,
  createStudySession,
  sessionPhrases,
  submitRecall,
  advanceStudySession,
  dueReviews,
  calendarFile,
  type ProgressData,
  type Session,
} from '@/lib/progress';
import {
  defaultConfig,
  providers,
  type ModelConfig,
  type ProviderId,
} from '@/lib/providers';

type View = 'today' | 'roadmap' | 'review' | 'tutor';
type ChatMessage = { role: 'user' | 'assistant'; content: string };
type TutorResponse = { error?: string; content?: string; truncated?: boolean };
const progressKey = 'milo-progress-v1';
const names: Record<View, string> = {
  today: '今日学习',
  roadmap: '学习路线',
  review: '复习本',
  tutor: '我的导师',
};
const navItems = [
  { id: 'today', icon: Home, label: '今日学习' },
  { id: 'roadmap', icon: BookOpen, label: '学习路线' },
  { id: 'review', icon: RotateCcw, label: '复习本' },
  { id: 'tutor', icon: MessageCircle, label: '我的导师' },
] as const;
function Navigation({
  view,
  onChange,
  due,
  onSettings,
}: {
  view: View;
  onChange: (v: View) => void;
  due: number;
  onSettings: () => void;
}) {
  const { setOpenMobile } = useSidebar();
  return (
    <Sidebar className="milo-sidebar">
      <SidebarHeader className="brand">
        <div className="brand-mark">
          m<span>•</span>
        </div>
        <div>
          <b>
            milo<span className="brand-dot">.</span>
          </b>
          <small>你的英语导师</small>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <div className="nav-caption">LET’S MAKE A LITTLE PROGRESS</div>
        <SidebarMenu className="nav-list">
          {navItems.map(({ id, icon: Icon, label }) => (
            <SidebarMenuItem key={id}>
              <SidebarMenuButton
                isActive={view === id}
                onClick={() => {
                  onChange(id);
                  setOpenMobile(false);
                }}
                className="nav-item"
              >
                <Icon size={19} />
                <span>{label}</span>
                {id === 'review' && due > 0 && <em>{due}</em>}
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
        <div className="sidebar-note">
          <span className="note-spark">✳</span>
          <p>
            不用一下子变得厉害。
            <br />
            今天，比昨天多会一句。
          </p>
          <small>ONE SMALL STEP AT A TIME.</small>
        </div>
      </SidebarContent>
      <SidebarFooter>
        <button
          className="sidebar-settings"
          onClick={() => {
            onSettings();
            setOpenMobile(false);
          }}
        >
          <Settings2 size={19} /> 模型与学习设置
        </button>
        <div className="learner">
          <span>Me</span>
          <div>
            <b>英语探索者</b>
            <small>从零开始，也很棒</small>
          </div>
          <span className="learner-dot" />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
export default function LearningApp() {
  const [view, setView] = useState<View>('today');
  const [data, setData] = useState<ProgressData>(initialProgress);
  const [loaded, setLoaded] = useState(false);
  const [config, setConfig] = useState<ModelConfig>(defaultConfig);
  const [keys, setKeys] = useState<Partial<Record<ProviderId, string>>>({});
  const [settings, setSettings] = useState(false);
  const [lessonOpen, setLessonOpen] = useState(false);
  const [flash, setFlash] = useState('');
  const [now, setNow] = useState(new Date(0));
  const [storageError, setStorageError] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState('');
  const [testStatus, setTestStatus] = useState('');
  const [testing, setTesting] = useState(false);
  const chatEnd = useRef<HTMLDivElement>(null);
  const key = keys[config.provider] ?? '';
  const due = dueReviews(data, now);
  const nextLesson =
    lessons.find((l) => !data.completedLessons.includes(l.id)) ??
    lessons[lessons.length - 1];
  const activeSession = data.session;
  const currentPhrase = activeSession
    ? activeSession.mode === 'review' || activeSession.quick
      ? allPhrases.find(
          (p) =>
            p.id ===
            activeSession.reviewIds[
              activeSession.mode === 'review' ? activeSession.phraseIndex : 0
            ],
        )
      : lessons[activeSession.lessonId].phrases[activeSession.phraseIndex]
    : nextLesson.phrases[0];
  const currentLesson =
    lessons.find((l) => l.phrases.some((p) => p.id === currentPhrase?.id)) ??
    nextLesson;
  const todayCount = data.days[dayKey(now)] ?? 0;
  const mastered = data.reviews.filter((r) => r.successes >= 3).length;
  const remaining = lessons.length - data.completedLessons.length;
  useEffect(() => {
    queueMicrotask(() => {
      try {
        setData(parseProgress(localStorage.getItem(progressKey)));
        const saved = JSON.parse(
          localStorage.getItem('milo-model-config') || 'null',
        );
        if (
          saved &&
          typeof saved.provider === 'string' &&
          Object.hasOwn(providers, saved.provider) &&
          typeof saved.model === 'string' &&
          typeof saved.baseUrl === 'string'
        )
          setConfig({ ...defaultConfig, ...saved });
      } catch {
        setStorageError(true);
      }
      setNow(new Date());
      setLoaded(true);
    });
    const interval = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(interval);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(progressKey, JSON.stringify(data));
      localStorage.setItem(
        'milo-model-config',
        JSON.stringify({
          provider: config.provider,
          model: config.model,
          baseUrl: config.baseUrl,
          tokenParameter: config.tokenParameter,
        }),
      );
    } catch {
      queueMicrotask(() => setStorageError(true));
    }
  }, [data, config, loaded]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(''), 4500);
    return () => clearTimeout(t);
  }, [flash]);
  useEffect(
    () => chatEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }),
    [messages, chatBusy],
  );
  function startLesson(id = nextLesson.id, quick = false) {
    if (!loaded) return;
    setData((d) => ({ ...d, session: createStudySession(d, id, quick) }));
    setLessonOpen(true);
  }
  function startReview() {
    if (!due.length) {
      setView('review');
      return;
    }
    setData((d) => ({
      ...d,
      session: {
        lessonId: nextLesson.id,
        phraseIndex: 0,
        step: 2,
        hinted: false,
        mistakes: 0,
        quick: false,
        mode: 'review',
        reviewIds: due.slice(0, 3).map((r) => r.phraseId),
      },
    }));
    setLessonOpen(true);
  }
  function startToday() {
    if (data.session && !data.session.completed) {
      setLessonOpen(true);
      return;
    }
    if (due.length) {
      startReview();
      return;
    }
    if (!remaining) {
      setView('tutor');
      return;
    }
    startLesson(nextLesson.id, data.dailyMinutes === 2);
  }
  async function apiCall(history: ChatMessage[], action = 'chat') {
    const response = await fetch('/api/tutor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config,
        apiKey: key,
        messages: history.slice(-24),
        lessonId: currentLesson.id,
        phraseId: currentPhrase?.id,
        learner: {
          completed: data.completedLessons.length,
          due: due.length,
          needsPractice: data.reviews
            .filter((r) => r.successes === 0)
            .map((r) => r.phraseId),
        },
        action,
      }),
      signal: AbortSignal.timeout(55000),
    });
    let result: TutorResponse;
    try {
      result = (await response.json()) as TutorResponse;
    } catch {
      throw new Error('服务暂时没有返回有效内容，请稍后重试。');
    }
    if (!response.ok) throw new Error(result.error || '连接失败，请重试。');
    if (typeof result.content !== 'string' || !result.content.trim())
      throw new Error('模型没有返回有效回答，请重试。');
    return `${result.content}${result.truncated ? '\n\n（这次回答达到长度上限，你可以让我继续。）' : ''}`;
  }
  function localReply(text: string) {
    const phrase = currentPhrase ?? currentLesson.phrases[0];
    if (/累|不想|放弃|难|懒/.test(text))
      return `今天把任务缩小一点。只读一句：\n\n${phrase.en}\n${phrase.zh}\n\n不用开始整节课。看过后遮住英文，试着打出来就好。`;
    if (/为什么|解释|简单|不懂/.test(text))
      return `${currentLesson.grammar}\n\n我们先看一句：${phrase.en}（${phrase.zh}）\n${phrase.note}\n\n试一试：${phrase.prompt}`;
    if (isCorrect(phrase, text))
      return `这句写对了：${phrase.en}\n\n${phrase.note}\n\n下一句可以练：${currentLesson.phrases[1].en}（${currentLesson.phrases[1].zh}）。在「今日学习」里练习，会自动记录和安排复习。`;
    return `我们从「${currentLesson.title}」开始。\n\n${phrase.en}\n${phrase.zh}\n\n${phrase.note}\n\n现在轮到你：${phrase.prompt}\n\n当前是内置辅导，能讲解本课内容；接入模型后，我可以针对你的回答继续辅导。`;
  }
  async function sendChat(text = chatInput) {
    if (!text.trim() || chatBusy) return;
    const history = [
      ...messages,
      { role: 'user' as const, content: text.trim() },
    ];
    setChatBusy(true);
    setChatError('');
    try {
      const content = key ? await apiCall(history) : localReply(text);
      setMessages([...history, { role: 'assistant', content }]);
      setChatInput('');
    } catch (e) {
      setChatError(
        e instanceof Error && e.name === 'TimeoutError'
          ? '请求超时了，输入已保留，请重试。'
          : e instanceof Error
            ? e.message
            : '连接失败，请重试。',
      );
      setChatInput(text);
    } finally {
      setChatBusy(false);
    }
  }
  async function testConnection() {
    setTesting(true);
    setTestStatus('');
    try {
      await apiCall(
        [{ role: 'user', content: '只回复：连接成功。' }],
        'connection-test',
      );
      setTestStatus('连接成功，可以开始 AI 辅导了。');
    } catch (e) {
      setTestStatus(e instanceof Error ? e.message : '连接失败。');
    } finally {
      setTesting(false);
    }
  }
  function switchProvider(value: ProviderId) {
    setConfig({
      provider: value,
      model: providers[value].model,
      baseUrl: providers[value].baseUrl,
      tokenParameter:
        value === 'openai' ? 'max_completion_tokens' : 'max_tokens',
    });
    setTestStatus('');
  }
  function downloadCalendar() {
    const a = document.createElement('a');
    const url = URL.createObjectURL(
      new Blob([calendarFile(data.reminder, new Date(), data.dailyMinutes)], {
        type: 'text/calendar;charset=utf-8',
      }),
    );
    a.href = url;
    a.download = 'Milo-每日英语.ics';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setFlash('提醒文件已生成，导入手机或电脑日历即可。');
  }
  const dates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - 6 + i);
    return d;
  });
  return (
    <SidebarProvider
      style={{ '--sidebar-width': '236px' } as React.CSSProperties}
    >
      <Navigation
        view={view}
        onChange={setView}
        due={due.length}
        onSettings={() => setSettings(true)}
      />
      <main className="app-main">
        <header className="topbar">
          <div className="breadcrumb">
            <SidebarTrigger className="mobile-menu" />
            <span>我的学习空间</span>
            <ChevronRight size={14} />
            <b>{names[view]}</b>
          </div>
          <div className="topbar-right">
            <span className="today-date">
              {loaded
                ? now.toLocaleDateString('zh-CN', {
                    month: 'long',
                    day: 'numeric',
                    weekday: 'long',
                  })
                : '每天一小步'}
            </span>
            <button className="model-status" onClick={() => setSettings(true)}>
              <span className={key ? 'status-dot online' : 'status-dot'} />
              {key ? providers[config.provider].name : '内置课程'}
              <Settings2 size={14} />
            </button>
          </div>
        </header>
        <div className="page-content">
          {storageError && (
            <div className="notice warning">
              当前浏览器无法保存学习记录，刷新后可能丢失。请允许此网站使用本地存储。
            </div>
          )}
          {view === 'today' && (
            <>
              <div className="page-heading">
                <div className="eyebrow">
                  <span /> YOUR DAILY ENGLISH MOMENT
                </div>
                <h1>
                  {todayCount
                    ? '做得很好，继续一小步。'
                    : '嗨，今天也一起学一点。'}
                  <span className="hello-wave">✳</span>
                </h1>
                <p>
                  {due.length
                    ? `有 ${due.length} 句到了复习时间，我已经帮你排在前面。`
                    : '不用想学什么，我已经为你准备好了。花几分钟，学会开口的第一步。'}
                </p>
              </div>
              <div className="dashboard-grid">
                <section className="daily-card">
                  <div className="daily-top">
                    <span className="pill">
                      <span /> {due.length ? '优先复习' : 'MILO 为你安排'}
                    </span>
                    <span>
                      <Clock3 size={15} />
                      {data.dailyMinutes} 分钟左右
                    </span>
                  </div>
                  <div className="daily-content">
                    <div>
                      <p className="lesson-counter">
                        {due.length
                          ? 'REVIEW · 让记忆更牢固'
                          : `LESSON ${String(nextLesson.id + 1).padStart(2, '0')} · 零基础起步`}
                      </p>
                      <h2>
                        {due.length
                          ? '把学过的，变成自己的。'
                          : remaining
                            ? nextLesson.title
                            : '基础旅程，迈出下一步。'}
                      </h2>
                      <p>
                        {due.length
                          ? '先不看答案，试着把熟悉的表达说出来。'
                          : remaining
                            ? nextLesson.goal
                            : '用你学过的句子，和导师进行一段真实对话。'}
                      </p>
                      <button
                        className="primary dark-button"
                        onClick={startToday}
                        disabled={!loaded}
                      >
                        <Play size={17} fill="currentColor" />
                        {data.session && !data.session.completed
                          ? '接着上次继续'
                          : due.length
                            ? '开始今天的复习'
                            : remaining
                              ? `开始今天的 ${data.dailyMinutes} 分钟`
                              : '和导师继续练习'}
                        <ArrowRight size={19} />
                      </button>
                      <button
                        className="tiny-link"
                        onClick={() => startLesson(nextLesson.id, true)}
                      >
                        今天有点累？只学一句也可以 <ArrowUpRight size={14} />
                      </button>
                    </div>
                    <div className="hello-type" aria-hidden="true">
                      {due.length
                        ? 'Again.'
                        : nextLesson.id === 0
                          ? 'Hello.'
                          : nextLesson.id === 1
                            ? 'I’m Alex.'
                            : 'Let’s go.'}
                      <span>每一句，都是一个新开始。</span>
                      <span className="type-underline" />
                    </div>
                  </div>
                  <div className="daily-bottom">
                    <span>
                      <CheckCircle2 size={15} />
                      中文讲解
                    </span>
                    <span>
                      <Headphones size={15} />
                      听音跟读
                    </span>
                    <span>
                      <MessageCircle size={15} />
                      开口练习
                    </span>
                    <span>
                      <RotateCcw size={15} />
                      自动复习
                    </span>
                  </div>
                </section>
                <section className="weekly-card">
                  <div className="section-title">
                    <h3>一点点，就在进步</h3>
                    <Flame size={20} />
                  </div>
                  <div className="week-number">
                    <b>
                      {
                        dates.filter((d) => (data.days[dayKey(d)] ?? 0) > 0)
                          .length
                      }
                    </b>
                    <span>
                      / 7 天<small>最近一周，留下的足迹</small>
                    </span>
                  </div>
                  <div className="week-grid">
                    {dates.map((d, i) => (
                      <div key={i}>
                        <span
                          className={
                            (data.days[dayKey(d)] ?? 0) > 0
                              ? 'day active'
                              : i === 6
                                ? 'day current'
                                : 'day'
                          }
                        >
                          {(data.days[dayKey(d)] ?? 0) > 0 ? (
                            <Check size={16} />
                          ) : (
                            d.getDate()
                          )}
                        </span>
                        <small>
                          {
                            ['日', '一', '二', '三', '四', '五', '六'][
                              d.getDay()
                            ]
                          }
                        </small>
                      </div>
                    ))}
                  </div>
                  <p>不需要满勤，回来就很好。</p>
                  <button
                    className="reminder-link"
                    onClick={() => setSettings(true)}
                  >
                    <CalendarDays size={16} />
                    给学习留一个固定时间
                    <ChevronRight size={15} />
                  </button>
                </section>
              </div>
              <div className="lower-grid">
                <section className="journey-section">
                  <div className="section-heading">
                    <h2>今天，我们这样学</h2>
                    <span>一次，只做一件小事</span>
                  </div>
                  <div className="steps-grid">
                    {[
                      {
                        icon: BookOpen,
                        title: '先听我讲',
                        text: '用中文讲明白，配一个小例子。',
                        n: '01',
                      },
                      {
                        icon: Mic,
                        title: '轮到你试',
                        text: '听一遍，再试着自己说出来。',
                        n: '02',
                      },
                      {
                        icon: RotateCcw,
                        title: '帮你记牢',
                        text: '答错没关系，我会安排再练。',
                        n: '03',
                      },
                    ].map(({ icon: Icon, title, text, n }) => (
                      <div className="step-card" key={n}>
                        <div>
                          <span className="step-icon">
                            <Icon size={20} />
                          </span>
                          <small>{n}</small>
                        </div>
                        <h3>{title}</h3>
                        <p>{text}</p>
                      </div>
                    ))}
                  </div>
                  <div className="path-preview">
                    <div className="path-icon">
                      <Target size={22} />
                    </div>
                    <div>
                      <b>你的第一段旅程</b>
                      <p>从打招呼，到完成一段小对话</p>
                    </div>
                    <button onClick={() => setView('roadmap')}>
                      查看路线 <ArrowRight size={16} />
                    </button>
                  </div>
                </section>
                <section className="tutor-note">
                  <div className="section-heading">
                    <h2>导师的小纸条</h2>
                    <span className="milo-badge">m.</span>
                  </div>
                  <p>
                    “你不需要先准备好，
                    <br />
                    才开始学英语。
                    <br />
                    <strong>我们从一句话开始就好。</strong>”
                  </p>
                  <div className="note-footer">
                    <span>— Milo，你的英语导师</span>
                    <button
                      aria-label="和 Milo 聊聊"
                      onClick={() => setView('tutor')}
                    >
                      <ArrowUpRight size={20} />
                    </button>
                  </div>
                </section>
              </div>
              <div className="stats-strip">
                <span>
                  <b>{data.completedLessons.length}</b> 节课程已完成
                </span>
                <span>
                  <b>{data.reviews.length}</b> 个表达已练习
                </span>
                <span>
                  <b>{mastered}</b> 个表达多日答对
                </span>
                <span className="local-note">
                  <ShieldCheck size={15} />
                  学习记录保存在这台设备
                </span>
              </div>
            </>
          )}
          {view === 'roadmap' && (
            <>
              <div className="page-heading">
                <div className="eyebrow">YOUR FIRST CHAPTER</div>
                <h1>从不会，到敢开口。</h1>
                <p>不用自己找教材，顺着这条路线，每次解决一个小问题。</p>
              </div>
              <div className="route-overview">
                <div>
                  <span className="pill">起步阶段 · 8 节基础课</span>
                  <h2>和世界，说上第一句话。</h2>
                  <p>
                    先学有用的表达，再一点点理解它们。完成基础课后，继续和 AI
                    导师做情景练习。
                  </p>
                </div>
                <div className="route-count">
                  <b>
                    {data.completedLessons.length}
                    <small> / 8</small>
                  </b>
                  <Progress
                    value={(data.completedLessons.length / 8) * 100}
                    aria-label="基础课程完成进度"
                  />
                </div>
              </div>
              <div className="lesson-list">
                {lessons.map((l) => {
                  const done = data.completedLessons.includes(l.id);
                  const unlocked =
                    l.id === 0 || data.completedLessons.includes(l.id - 1);
                  return (
                    <button
                      key={l.id}
                      className={`lesson-row ${done ? 'done' : unlocked ? 'available' : 'locked'}`}
                      disabled={!unlocked}
                      onClick={() => startLesson(l.id)}
                    >
                      <span className="lesson-number">
                        {done ? (
                          <Check size={22} />
                        ) : unlocked ? (
                          String(l.id + 1).padStart(2, '0')
                        ) : (
                          <LockKeyhole size={19} />
                        )}
                      </span>
                      <div>
                        <small>
                          LESSON {String(l.id + 1).padStart(2, '0')} ·{' '}
                          {l.subtitle}
                        </small>
                        <h3>{l.title}</h3>
                        <p>{l.goal}</p>
                      </div>
                      <span className="lesson-row-state">
                        {done
                          ? '再练一次'
                          : unlocked
                            ? '开始学习'
                            : '完成上一课解锁'}
                        {unlocked && <ArrowRight size={18} />}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="muted-footnote">
                完成基础课不等于达到完整语言等级。真正的熟练，需要在不同日子和真实情境中继续使用。
              </p>
            </>
          )}
          {view === 'review' && (
            <>
              <div className="page-heading">
                <div className="eyebrow">MAKE IT STICK</div>
                <h1>学过的，我们一起记牢。</h1>
                <p>
                  先试着回忆，再看答案。复习会根据你的回答，安排在后面的日子。
                </p>
              </div>
              <div className="review-overview">
                <div>
                  <span className="pill">今天到期</span>
                  <h2>
                    {due.length} <small>个表达等你复习</small>
                  </h2>
                  <p>
                    {due.length
                      ? '每轮最多 3 句，一小步就好。'
                      : '现在没有到期复习。完成课程后，明天再来试试。'}
                  </p>
                </div>
                <button
                  className="primary"
                  disabled={!due.length}
                  onClick={startReview}
                >
                  <RotateCcw size={18} />
                  开始复习
                  <ArrowRight size={18} />
                </button>
              </div>
              {!data.reviews.length ? (
                <div className="empty-state">
                  <BookOpen size={36} />
                  <h3>复习本，还在等第一句话。</h3>
                  <p>先上一小节课，学过的表达会自动出现在这里。</p>
                  <button className="primary" onClick={() => startLesson()}>
                    去学第一课
                    <ArrowRight size={17} />
                  </button>
                </div>
              ) : (
                <div className="phrase-grid">
                  {data.reviews.map((r) => {
                    const p = allPhrases.find((p) => p.id === r.phraseId)!;
                    return (
                      <article key={r.phraseId} className="phrase-card">
                        <div className="phrase-card-top">
                          <span
                            className={
                              r.due <= dayKey(now) ? 'due-label' : 'muted-label'
                            }
                          >
                            {r.due <= dayKey(now)
                              ? '今天复习'
                              : `${r.due.slice(5).replace('-', '月')}日复习`}
                          </span>
                          <SpeakButton text={p.en} notify={setFlash} />
                        </div>
                        <h3>{p.en}</h3>
                        <p>{p.zh}</p>
                        <div className="phrase-meta">
                          <span>
                            {r.successes >= 3
                              ? '多日答对'
                              : r.successes > 0
                                ? '正在巩固'
                                : '需要再练'}
                          </span>
                          <span>
                            {r.mistakes
                              ? `曾需帮助 ${r.mistakes} 次`
                              : '继续保持回忆'}
                          </span>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </>
          )}
          {view === 'tutor' && (
            <>
              <div className="page-heading">
                <div className="eyebrow">A LITTLE HELP, EVERY STEP</div>
                <h1>不懂的，慢慢问我。</h1>
                <p>我会结合你当前的课程讲解，并给你一个可以马上做的小练习。</p>
              </div>
              <div className="chat-layout">
                <section className="chat-panel">
                  <div className="chat-header">
                    <div className="chat-person">
                      <span className="milo-avatar">m.</span>
                      <div>
                        <b>Milo</b>
                        <small>
                          {key
                            ? `${providers[config.provider].name} · ${config.model}`
                            : '内置辅导 · 接入模型后可自由对话'}
                        </small>
                      </div>
                    </div>
                    <button
                      className="icon-button"
                      aria-label="开始新对话"
                      disabled={chatBusy}
                      onClick={() => {
                        setMessages([]);
                        setChatError('');
                      }}
                    >
                      <Plus size={20} />
                    </button>
                  </div>
                  <div className="chat-messages">
                    {!messages.length && (
                      <div className="chat-welcome">
                        <span className="welcome-spark">✳</span>
                        <h2>我在，先学一句就好。</h2>
                        <p>
                          今天我们在学「{currentLesson.title}」。
                          <br />
                          你可以直接开始练，或者让我讲得再简单一点。
                        </p>
                        <div className="quick-prompts">
                          {[
                            '带我开始今天的学习',
                            '讲得再简单一点',
                            '今天很累，只想学一句',
                          ].map((x) => (
                            <button
                              key={x}
                              disabled={chatBusy}
                              onClick={() => sendChat(x)}
                            >
                              {x}
                              <ArrowUpRight size={14} />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {messages.map((m, i) => (
                      <div key={i} className={`chat-message ${m.role}`}>
                        <span className="message-author">
                          {m.role === 'assistant' ? 'Milo' : '你'}
                        </span>
                        <p>{m.content}</p>
                      </div>
                    ))}
                    {chatBusy && (
                      <div className="thinking">
                        <Loader2 className="spin" size={17} />
                        Milo 正在准备一个简单的解释…
                      </div>
                    )}
                    <div ref={chatEnd} />
                  </div>
                  {chatError && (
                    <div className="notice warning" role="alert">
                      {chatError}
                    </div>
                  )}
                  <form
                    className="chat-composer"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void sendChat();
                    }}
                  >
                    <label className="sr-only" htmlFor="chat-input">
                      给导师发消息
                    </label>
                    <textarea
                      id="chat-input"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      maxLength={4000}
                      placeholder="可以用中文问，也可以用英语试着说…"
                      onKeyDown={(e) => {
                        if (
                          e.key === 'Enter' &&
                          !e.shiftKey &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          void sendChat();
                        }
                      }}
                    />
                    <button
                      type="submit"
                      className="send-button"
                      aria-label="发送消息"
                      disabled={!chatInput.trim() || chatBusy}
                    >
                      {chatBusy ? (
                        <Loader2 size={19} className="spin" />
                      ) : (
                        <Send size={19} />
                      )}
                    </button>
                  </form>
                  <div className="chat-disclaimer">
                    {key
                      ? 'AI 可能会出错，重要表达可以追问核对。'
                      : '当前回复来自内置教学规则。'}
                    <button onClick={() => setSettings(true)}>
                      {key ? '切换模型' : '连接我的 AI 模型'}
                      <ArrowUpRight size={13} />
                    </button>
                  </div>
                </section>
                <aside className="chat-context">
                  <span className="context-icon">
                    <BookOpen size={23} />
                  </span>
                  <h3>我记得你在学</h3>
                  <b>{currentLesson.title}</b>
                  <p>{currentLesson.goal}</p>
                  <div className="context-stat">
                    <span>完成的基础课</span>
                    <b>{data.completedLessons.length} / 8</b>
                  </div>
                  <div className="context-stat">
                    <span>今天待复习</span>
                    <b>{due.length} 句</b>
                  </div>
                  <button className="secondary" onClick={startToday}>
                    回到引导课程
                    <ArrowRight size={16} />
                  </button>
                  <small>
                    对话是补充练习。课程中的作答会记录进度并安排复习。
                  </small>
                </aside>
              </div>
            </>
          )}
        </div>
        <footer className="app-footer">
          <span>
            milo<span> · </span>慢慢来，每一步都算数。
          </span>
          <span>MADE FOR YOUR NEXT LITTLE STEP</span>
        </footer>
      </main>
      <Dialog open={settings} onOpenChange={setSettings}>
        <DialogContent className="settings-dialog">
          <DialogTitle className="dialog-title">让 Milo 更适合你</DialogTitle>
          <DialogDescription>
            选择你的模型，给每天的学习留一点时间。
          </DialogDescription>
          <section className="settings-section">
            <h3>
              <Sparkles size={18} />
              AI 模型
            </h3>
            <label htmlFor="provider">模型服务商</label>
            <Select
              value={config.provider}
              onValueChange={(v) => v && switchProvider(v as ProviderId)}
            >
              <SelectTrigger id="provider" className="field-select">
                <SelectValue>{providers[config.provider].name}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {Object.entries(providers).map(([id, p]) => (
                  <SelectItem key={id} value={id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="field-help">
              {providers[config.provider].description}
              。模型名称可按你的账户权限修改。
            </p>
            <label htmlFor="model-id">模型名称</label>
            <input
              id="model-id"
              value={config.model}
              onChange={(e) => {
                setConfig({ ...config, model: e.target.value });
                setTestStatus('');
              }}
              placeholder="例如 gpt-5.4-nano"
            />
            {config.provider === 'custom' && (
              <>
                <label htmlFor="base-url">API Base URL</label>
                <input
                  id="base-url"
                  type="url"
                  value={config.baseUrl}
                  onChange={(e) => {
                    setConfig({ ...config, baseUrl: e.target.value });
                    setKeys((k) => ({ ...k, custom: '' }));
                    setTestStatus('');
                  }}
                />
                <p className="field-help">
                  支持
                  OpenRouter、硅基流动、Moonshot、通义千问的兼容接口。其他域名需在服务端配置。
                </p>
                <label htmlFor="token-parameter">输出长度参数</label>
                <Select
                  value={config.tokenParameter}
                  onValueChange={(v) =>
                    v &&
                    setConfig({
                      ...config,
                      tokenParameter: v as ModelConfig['tokenParameter'],
                    })
                  }
                >
                  <SelectTrigger id="token-parameter" className="field-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="max_tokens">
                      max_tokens（多数兼容接口）
                    </SelectItem>
                    <SelectItem value="max_completion_tokens">
                      max_completion_tokens（GPT 推理模型）
                    </SelectItem>
                  </SelectContent>
                </Select>
              </>
            )}
            <label htmlFor="api-key">
              API Key <span>仅当前页面有效</span>
            </label>
            <input
              id="api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(e) => {
                setKeys({ ...keys, [config.provider]: e.target.value.trim() });
                setTestStatus('');
              }}
              placeholder="粘贴你的 API Key"
            />
            <p className="field-help">
              Key
              只在当前页面内存中保留，刷新后需重新填写。调用时会经本应用服务端转发给所选服务商，不写入学习记录。
            </p>
            <div className="settings-actions">
              <button
                className="secondary"
                disabled={!key || !config.model || testing}
                onClick={testConnection}
              >
                {testing ? (
                  <Loader2 className="spin" size={16} />
                ) : (
                  <ShieldCheck size={16} />
                )}
                测试连接
              </button>
              {key && (
                <button
                  className="text-button"
                  onClick={() => {
                    setKeys((k) => ({ ...k, [config.provider]: '' }));
                    setTestStatus('已移除当前服务商的 Key。');
                  }}
                >
                  移除 Key
                </button>
              )}
              <small>会发送一次简短请求</small>
            </div>
            {testStatus && <output className="notice">{testStatus}</output>}
          </section>
          <section className="settings-section">
            <h3>
              <Clock3 size={18} />
              我的学习节奏
            </h3>
            <label htmlFor="daily-time">每日安排</label>
            <Select
              value={String(data.dailyMinutes)}
              onValueChange={(v) =>
                setData((d) => ({ ...d, dailyMinutes: Number(v) }))
              }
            >
              <SelectTrigger id="daily-time" className="field-select">
                <SelectValue>
                  {data.dailyMinutes === 2
                    ? '2 分钟 · 只学一句'
                    : data.dailyMinutes === 10
                      ? '10 分钟 · 学完可继续练'
                      : '5 分钟 · 每天一小节'}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="2">2 分钟 · 只学一句</SelectItem>
                <SelectItem value="5">5 分钟 · 每天一小节</SelectItem>
                <SelectItem value="10">10 分钟 · 学完可继续练</SelectItem>
              </SelectContent>
            </Select>
            <label htmlFor="reminder-time">提醒时间</label>
            <div className="time-row">
              <input
                id="reminder-time"
                type="time"
                value={data.reminder}
                onChange={(e) => {
                  if (e.target.value)
                    setData((d) => ({ ...d, reminder: e.target.value }));
                }}
              />
              <button className="secondary" onClick={downloadCalendar}>
                <Download size={16} />
                导出日历提醒
              </button>
            </div>
            <p className="field-help">
              导入系统日历后，由日历每天提醒。网页关闭后，Milo
              暂时不会主动推送通知。
            </p>
          </section>
          <button
            className="primary settings-done"
            onClick={() => {
              setSettings(false);
              setFlash('设置已生效，开始今天的一小步。');
            }}
          >
            设置好了，继续学习
            <ArrowRight size={18} />
          </button>
        </DialogContent>
      </Dialog>
      <Dialog open={lessonOpen} onOpenChange={setLessonOpen}>
        <DialogContent className="lesson-dialog">
          {data.session && (
            <LessonPlayer
              key={`${data.session.mode}-${data.session.lessonId}-${data.session.phraseIndex}-${data.session.step}`}
              session={data.session}
              onData={setData}
              onClose={() => setLessonOpen(false)}
              notify={setFlash}
              onAsk={(text) => {
                setLessonOpen(false);
                setView('tutor');
                void sendChat(text);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      {flash && (
        <output className="toast-message">
          <CheckCircle2 size={18} />
          {flash}
          <button onClick={() => setFlash('')} aria-label="关闭提示">
            <X size={14} />
          </button>
        </output>
      )}
    </SidebarProvider>
  );
}
function SpeakButton({
  text,
  notify,
  label,
}: {
  text: string;
  notify: (s: string) => void;
  label?: string;
}) {
  const [speaking, setSpeaking] = useState(false);
  useEffect(
    () => () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window)
        window.speechSynthesis.cancel();
    },
    [],
  );
  function speak() {
    if (!('speechSynthesis' in window)) {
      notify('此浏览器不支持朗读。可以直接看英文并跟读。');
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 0.8;
    const voice = window.speechSynthesis
      .getVoices()
      .find((v) => v.lang === 'en-US');
    if (voice) utterance.voice = voice;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => {
      setSpeaking(false);
      notify('朗读暂不可用，请检查系统语音和音量。');
    };
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  }
  return (
    <button
      type="button"
      className={label ? 'listen-button' : 'icon-button'}
      aria-label={`朗读 ${text}`}
      onClick={speak}
    >
      <Volume2 size={19} className={speaking ? 'pulse' : ''} />
      {label && (speaking ? '正在朗读…' : label)}
    </button>
  );
}
function LessonPlayer({
  session,
  onData,
  onClose,
  notify,
  onAsk,
}: {
  session: Session;
  onData: React.Dispatch<React.SetStateAction<ProgressData>>;
  onClose: () => void;
  notify: (s: string) => void;
  onAsk: (s: string) => void;
}) {
  const baseLesson = lessons[session.lessonId];
  const phrases = sessionPhrases(session);
  const phrase = phrases[session.phraseIndex] ?? phrases[0];
  const lesson =
    lessons.find((l) => l.phrases.some((p) => p.id === phrase.id)) ??
    baseLesson;
  const [answer, setAnswer] = useState(session.graded ? phrase.en : '');
  const [feedback, setFeedback] = useState<'correct' | 'incorrect' | null>(
    session.graded ? 'correct' : null,
  );
  const [choice, setChoice] = useState(session.graded ? phrase.zh : '');
  const [hintVisible, setHintVisible] = useState(false);
  const total = phrases.length * (session.mode === 'review' ? 1 : 3);
  const done =
    session.mode === 'review'
      ? session.phraseIndex
      : session.phraseIndex * 3 + session.step;
  function update(fields: Partial<Session>) {
    onData((d) => ({
      ...d,
      session: d.session ? { ...d.session, ...fields } : null,
    }));
  }
  function next() {
    setFeedback(null);
    onData(advanceStudySession);
  }
  function check(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (feedback === 'correct' || session.graded) return;
    const correct =
      session.step === 1 ? choice === phrase.zh : isCorrect(phrase, answer);
    setFeedback(correct ? 'correct' : 'incorrect');
    if (!correct) {
      update({ mistakes: session.mistakes + 1 });
      return;
    }
    if (session.step === 2) onData(submitRecall);
    else update({ graded: true });
  }
  if (session.completed)
    return (
      <div className="lesson-finished">
        <DialogTitle className="sr-only">这一小步，完成了</DialogTitle>
        <DialogDescription className="sr-only">
          学习记录已保存，复习已安排。
        </DialogDescription>
        <span className="finished-icon">
          <Check size={36} />
        </span>
        <p className="eyebrow">A LITTLE PROGRESS IS STILL PROGRESS</p>
        <h2>这一小步，完成了。</h2>
        <p>
          {session.mode === 'review'
            ? '你又和这些表达见了一面。'
            : session.quick
              ? '一句也很好。你已经为今天迈出一步。'
              : '你已经完成今天的基础练习。'}
          <br />
          学过的内容已安排在以后的日子复习。
        </p>
        <div className="finished-phrases">
          {phrases.map((p) => (
            <div key={p.id}>
              <span>{p.en}</span>
              <small>{p.zh}</small>
            </div>
          ))}
        </div>
        <p className="field-help">
          今天答对是一个开始，隔几天还能想起来，记忆才更牢。
        </p>
        <button className="primary" onClick={onClose}>
          完成，回到学习空间
          <CheckCircle2 size={18} />
        </button>
        {session.quick && (
          <button
            className="text-button"
            onClick={() =>
              onData((d) => ({
                ...d,
                session: {
                  lessonId: session.lessonId,
                  phraseIndex: 0,
                  step: 0,
                  hinted: false,
                  mistakes: 0,
                  quick: false,
                  mode: 'lesson',
                  reviewIds: [],
                },
              }))
            }
          >
            还有精力，学完整一课
          </button>
        )}
      </div>
    );
  return (
    <>
      <div className="lesson-player-top">
        <span className="pill">
          {session.mode === 'review' ? '到期复习' : `第 ${lesson.id + 1} 课`}
        </span>
        <span>
          {session.phraseIndex + 1} / {phrases.length} 个表达
        </span>
      </div>
      <DialogTitle className="lesson-player-title">
        {session.mode === 'review' ? '试着自己想起来' : lesson.title}
      </DialogTitle>
      <DialogDescription>
        {session.mode === 'review'
          ? '不要急着看答案。先回忆，再检查。'
          : lesson.subtitle + ' · 一次学一句'}
      </DialogDescription>
      <Progress
        value={(done / total) * 100}
        aria-label="本次学习进度"
        className="lesson-progress"
      />
      <div className="lesson-stage">
        <div className="stage-label">
          <span>
            {session.step === 0 ? '01' : session.step === 1 ? '02' : '03'}
          </span>
          {session.step === 0
            ? '先听我讲'
            : session.step === 1
              ? '理解它的意思'
              : '现在，不看答案试一次'}
        </div>
        {session.step === 0 ? (
          <>
            <div className="teaching-expression">
              <h2>{phrase.en}</h2>
              <span>{phrase.pronunciation}</span>
              <p>{phrase.zh}</p>
              <SpeakButton
                text={phrase.en}
                label="听一遍，跟着读"
                notify={notify}
              />
            </div>
            <div className="teacher-explanation">
              <Lightbulb size={21} />
              <div>
                <b>Milo 帮你拆开看</b>
                <p>{phrase.note}</p>
                {session.phraseIndex === 0 && <p>{lesson.grammar}</p>}
              </div>
            </div>
            <p className="read-note">
              听完后自己读一遍就好，这里不进行录音或发音评分。
            </p>
            <button className="primary full-button" onClick={next}>
              读过了，带我练一练
              <ArrowRight size={18} />
            </button>
          </>
        ) : (
          <form onSubmit={check}>
            {session.step === 1 ? (
              <>
                <h2 className="question">“{phrase.en}” 是什么意思？</h2>
                <div className="answer-options">
                  {phrase.options.map((option, i) => (
                    <button
                      key={option}
                      type="button"
                      disabled={feedback === 'correct'}
                      className={`answer-option ${choice === option ? 'selected' : ''} ${feedback === 'correct' && choice === option ? 'right' : ''}`}
                      onClick={() => {
                        setChoice(option);
                        setFeedback(null);
                      }}
                    >
                      <span>{String.fromCharCode(65 + i)}</span>
                      {option}
                      {choice === option && <Check size={18} />}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <h2 className="question">{phrase.prompt}</h2>
                <p className="question-help">
                  用英语打出来。不确定也可以先试一试。
                </p>
                <label htmlFor="lesson-answer" className="sr-only">
                  输入英文回答
                </label>
                <input
                  id="lesson-answer"
                  className="answer-input"
                  value={answer}
                  onChange={(e) => {
                    setAnswer(e.target.value);
                    setFeedback(null);
                  }}
                  placeholder="在这里写下你的英语…"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  disabled={feedback === 'correct'}
                  maxLength={180}
                />
                <div className="answer-tools">
                  <button
                    type="button"
                    className="text-button"
                    disabled={feedback === 'correct'}
                    onClick={() => {
                      setHintVisible(true);
                      update({ hinted: true });
                    }}
                  >
                    <Lightbulb size={15} />
                    给我一点提示
                  </button>
                  <span>大小写和句末标点不影响判断</span>
                </div>
                {hintVisible && (
                  <div className="hint-box">
                    先看一句：<strong>{phrase.en}</strong>
                    <p>{phrase.note}</p>看懂后，再自己输入一次。
                  </div>
                )}
              </>
            )}
            {feedback && (
              <output className={`answer-feedback ${feedback}`}>
                {feedback === 'correct' ? (
                  <CheckCircle2 size={20} />
                ) : (
                  <CircleHelp size={20} />
                )}
                <div>
                  <b>
                    {feedback === 'correct'
                      ? '这次，表达对了。'
                      : '没关系，我们再试一下。'}
                  </b>
                  <p>
                    {feedback === 'correct'
                      ? session.hinted || session.mistakes
                        ? '这次有提示或重试，之后会多安排一次复习。'
                        : '这次独立答对，继续下一小步。'
                      : session.step === 1
                        ? '回想一下刚才的中文意思。也可以回去再看一遍。'
                        : `检查词语和顺序；可以点「给我一点提示」看示范。`}
                  </p>
                </div>
              </output>
            )}
            {feedback === 'correct' ? (
              <button
                className="primary full-button"
                type="button"
                onClick={next}
              >
                {session.step === 2 &&
                session.phraseIndex === phrases.length - 1
                  ? '完成这一小步'
                  : '继续下一步'}
                <ArrowRight size={18} />
              </button>
            ) : (
              <button
                className="primary full-button"
                type="submit"
                disabled={session.step === 1 ? !choice : !answer.trim()}
              >
                检查我的回答
                <ArrowRight size={18} />
              </button>
            )}
          </form>
        )}
      </div>
      <div className="lesson-player-footer">
        <button
          className="text-button"
          onClick={() => {
            if (!(session.step === 2 && session.graded))
              update({ hinted: true });
            onAsk(
              `我在练习 ${phrase.en}，请用更简单的方式讲解，并给我一道练习。`,
            );
          }}
        >
          <MessageCircle size={16} />
          还是不懂，问问 Milo
        </button>
        {session.step > 0 && feedback !== 'correct' && (
          <button
            className="text-button"
            onClick={() => {
              setFeedback(null);
              update({ step: 0, hinted: true, graded: false });
            }}
          >
            回看讲解
          </button>
        )}
        <button className="text-button" onClick={onClose}>
          先休息，进度已保存
        </button>
      </div>
    </>
  );
}
