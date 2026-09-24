'use client';
import { useEffect, useLayoutEffect, useRef } from 'react';
import {
  type CaptionCue,
  type CaptionEvent,
  type CaptionMode,
  speechWords,
  SubtitleRequestScheduler,
  subtitleRequests,
  visiblePairs,
} from '@/lib/coach/captions';
import type { CoachClient } from '@/lib/coach/client';
export function CoachCaptions({
  mode,
  cues,
  client,
  dispatch,
}: {
  mode: CaptionMode;
  cues: CaptionCue[];
  client: CoachClient;
  dispatch: (event: CaptionEvent) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null),
    flow = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const scheduler = useRef<SubtitleRequestScheduler | null>(null);
  scheduler.current ??= new SubtitleRequestScheduler((request, epoch) => {
    void client
      .request('subtitles', { ...request, epoch }, AbortSignal.timeout(17000))
      .then((result) => {
        if (mounted.current && client.snapshot?.epoch === epoch)
          dispatch({
            type: 'translation',
            id: request.id,
            pairs: result.subtitles,
          });
      })
      .catch(() => {
        if (mounted.current && client.snapshot?.epoch === epoch)
          dispatch({ type: 'translation', id: request.id, error: true });
      });
  });
  const epoch = client.snapshot?.epoch;
  useEffect(() => {
    scheduler.current?.update(cues, epoch, mode === 'bilingual');
  }, [mode, epoch, cues]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      scheduler.current?.stop();
    };
  }, []);
  useLayoutEffect(() => {
    const box = viewport.current,
      content = flow.current;
    if (!box || !content) return;
    const align = () => {
      box.dataset.overflow = String(content.scrollHeight > box.clientHeight);
      content.style.transform = `translateY(-${Math.max(0, content.scrollHeight - box.clientHeight)}px)`;
    };
    align();
    const observer = new ResizeObserver(align);
    observer.observe(box);
    observer.observe(content);
    return () => observer.disconnect();
  }, [cues, mode]);
  if (mode === 'off') return null;
  const spoken = cues.filter((c) => c.started && c.words > 0);
  return (
    <section
      className={`c-caption-dock c-caption-${mode}`}
      aria-label={mode === 'english' ? '导师英文字幕' : '导师中英字幕'}
      translate="no"
    >
      <div className="c-caption-surface">
        <div className="c-caption-meta">
          <span>
            MILO · {mode === 'english' ? 'ENGLISH' : 'ENGLISH / 中文'}
          </span>
          {spoken.at(-1)?.approximate && <small>随语音进度</small>}
        </div>
        <div className="c-caption-window" ref={viewport} aria-live="off">
          <div className="c-caption-flow" ref={flow}>
            {mode === 'english'
              ? spoken.map((c) => (
                  <p className="c-caption-en" key={c.id} lang="en">
                    {speechWords(c.text)
                      .slice(0, c.words)
                      .map((word, i) => (
                        <span className="c-caption-word" key={`${c.id}-${i}`}>
                          {word}{' '}
                        </span>
                      ))}
                  </p>
                ))
              : spoken.flatMap((c) =>
                  c.pairs
                    ? visiblePairs(c).map((pair, i) => (
                        <div className="c-caption-pair" key={`${c.id}-${i}`}>
                          <p lang="en">{pair.english}</p>
                          <p lang="zh-CN">{pair.chinese}</p>
                        </div>
                      ))
                    : [
                        <div className="c-caption-pair" key={c.id}>
                          <p lang="en">
                            {speechWords(c.text).slice(0, c.words).join(' ')}
                          </p>
                          <p lang="zh-CN" className="c-caption-pending">
                            {c.translationError
                              ? '这句暂时显示英文；对话继续'
                              : c.done && !subtitleRequests([c]).length
                                ? '这段语音太短或被打断，暂只显示英文'
                                : '翻译稍后显示；对话继续'}
                          </p>
                        </div>,
                      ],
                )}
            {!spoken.length && (
              <p className="c-caption-placeholder">
                老师开口时，字幕会出现在这里。
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
