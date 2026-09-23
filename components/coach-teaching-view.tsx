'use client';
import {
  Ear,
  Compass,
  Route,
  Pause,
  Check,
  Circle,
  Sparkles,
} from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import {
  effectiveDifficulty,
  lessonContext,
} from '@/lib/coach/learning-engine';
import type { LearningData } from '@/lib/coach/model';
export function CoachTeachingView({
  open,
  onOpenChange,
  data,
  status,
  pause,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: LearningData;
  status: string;
  pause: () => void;
}) {
  const difficulty = effectiveDifficulty(data),
    lesson = lessonContext(data);
  const current = data.turns.filter(
    (t) => t.sessionId === data.activeSessionId,
  );
  const student = current.filter((t) => t.role === 'user').at(-1);
  const correctionSessionId = data.activeSessionId ?? data.sessions.at(-1)?.id;
  const corrections = data.turns
    .filter(
      (turn) =>
        turn.sessionId === correctionSessionId &&
        turn.role === 'user' &&
        turn.liveCorrection,
    )
    .slice(-4);
  const memory = data.memories
    .filter((m) => m.sessionId === data.activeSessionId)
    .at(-1);
  const live = [
    'listening',
    'thinking',
    'speaking',
    'connecting',
    'microphone',
    'audio',
  ].includes(status);
  const stages = [
    { id: 'listening', text: '听你表达' },
    { id: 'thinking', text: '调整带法' },
    { id: 'speaking', text: '陪你使用' },
  ];
  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent className="c-teaching-panel" side="right">
        <SheetHeader>
          <SheetTitle>教学思路</SheetTitle>
          <SheetDescription>
            从你的表现，到下一步怎么教。这里是面向你的教学摘要，会随着交流更新。
          </SheetDescription>
        </SheetHeader>
        <div className="c-teaching-body">
          <div className="c-teaching-stage" aria-label="当前交流状态">
            {stages.map((stage) => (
              <div
                key={stage.id}
                className={status === stage.id ? 'is-current' : ''}
              >
                <Circle />
                <span>{stage.text}</span>
              </div>
            ))}
          </div>
          <article className="c-teaching-step">
            <div>
              <Ear />
              <span>01 · 我观察到了什么</span>
            </div>
            <p>
              {student
                ? student.assessed
                  ? (memory?.text ?? '这次表达已记录，接着看看怎样用得更自然。')
                  : '刚听到了你的表达。先接着聊，结束后再整理这次表现。'
                : '我会先从最近的交流自然接话，留意你听懂和表达的节奏。'}
            </p>
            {student && (
              <blockquote>
                <small>你刚才说</small>
                <span>{student.text}</span>
              </blockquote>
            )}
          </article>
          {corrections.length > 0 && (
            <article className="c-teaching-step c-correction-history">
              <div>
                <Sparkles />
                <span>表达可以这样说</span>
              </div>
              {corrections.map((turn) => (
                <section className="c-correction-pair" key={turn.id}>
                  <p>
                    <small>刚才说</small> {turn.liveCorrection!.original}
                  </p>
                  <p>
                    <small>更自然</small> {turn.liveCorrection!.better}
                  </p>
                  {turn.liveCorrection!.note && (
                    <span>{turn.liveCorrection!.note}</span>
                  )}
                </section>
              ))}
              <small>这张卡片不会打断正在进行的语音对话。</small>
            </article>
          )}
          <article className="c-teaching-step">
            <div>
              <Compass />
              <span>02 · 现在要帮助你什么</span>
            </div>
            <h3>{data.plan.focus}</h3>
            <p>{data.plan.reason}</p>
            <p>{difficulty.reason}</p>
          </article>
          <article className="c-teaching-step">
            <div>
              <Route />
              <span>03 · 接下来怎么带你</span>
            </div>
            <ul>
              <li>
                <Check />
                顺着你刚才说的内容继续交流，难度随你的表达调整。
              </li>
              {data.hint > 0 && (
                <li>
                  <Check />
                  {data.hint === 3
                    ? '刚提供了完整示范，先让你尝试，再减少帮助。'
                    : data.hint === 2
                      ? '刚给了关键词，等你自己把意思说出来。'
                      : '先给一点方向，留出自己表达的空间。'}
                </li>
              )}
              <li>
                <Check />
                当前可自然聊到：{lesson.scene.name}。适时带回熟悉的表达。
              </li>
              {data.plan.review.length > 0 && (
                <li>
                  <Check />
                  把需要巩固的表达放进后面的聊天，让你再次用出来。
                </li>
              )}
            </ul>
            <small>
              安排更新于{' '}
              {new Date(data.plan.updatedAt).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </small>
          </article>
        </div>
        {live && (
          <div className="c-teaching-footer">
            <Button variant="outline" onClick={pause}>
              <Pause />
              暂停语音交流
            </Button>
            <span>打开此面板时，语音仍会继续。</span>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
