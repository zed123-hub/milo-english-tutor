'use client';
import { useEffect, useLayoutEffect, useRef } from 'react';
import {
  type CaptionCue,
  type CaptionEvent,
  type CaptionMode,
  speechWords,
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
  const candidates = cues
    .filter((c) => c.started && c.turnId && !c.pairs && !c.translationError)
    .slice(-3);
  const needed = candidates.map((c) => `${c.id}|${c.turnId}`).join('\n');
  const epoch = client.snapshot?.epoch;
  useEffect(() => {
    if (mode !== 'bilingual' || !needed || !epoch) return;
    let cancelled = false;
    for (const line of needed.split('\n')) {
      const [id, turnId] = line.split('|');
      void client
        .request('subtitles', { turnId, epoch }, AbortSignal.timeout(9000))
        .then((result) => {
          if (!cancelled && client.snapshot?.epoch === epoch)
            dispatch({ type: 'translation', id, pairs: result.subtitles });
        })
        .catch(() => {
          if (!cancelled && client.snapshot?.epoch === epoch)
            dispatch({ type: 'translation', id, error: true });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [mode, needed, epoch, client, dispatch]);
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
