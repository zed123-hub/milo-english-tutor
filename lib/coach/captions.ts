export type CaptionMode = 'off' | 'english' | 'bilingual';
export type SubtitlePair = { english: string; chinese: string };
export type CaptionCue = {
  id: string;
  text: string;
  words: number;
  started: boolean;
  done: boolean;
  interrupted: boolean;
  approximate: boolean;
  turnId?: string;
  pairs?: SubtitlePair[];
  translationError?: boolean;
};
export type CaptionEvent =
  | {
      type: 'text';
      id: string;
      text: string;
      turnId?: string;
      pairs?: SubtitlePair[];
    }
  | { type: 'progress'; id: string; words: number; approximate?: boolean }
  | { type: 'end'; id: string; interrupted: boolean }
  | { type: 'translation'; id: string; pairs?: SubtitlePair[]; error?: boolean }
  | { type: 'clear' };
export type SubtitleRequest = { id: string; turnId?: string; text?: string };
export function subtitleRequests(cues: CaptionCue[]): SubtitleRequest[] {
  return cues
    .filter(
      (cue) =>
        cue.started && cue.words > 0 && !cue.pairs && !cue.translationError,
    )
    .flatMap((cue): SubtitleRequest[] => {
      if (cue.turnId) return [{ id: cue.id, turnId: cue.turnId }];
      if (!cue.done || (cue.interrupted && cue.words < 4)) return [];
      const text = speechWords(cue.text).slice(0, cue.words).join(' ');
      return text.length >= (cue.interrupted ? 18 : 2) &&
        text.length <= 1200 &&
        isEnglishSpeech(text)
        ? [{ id: cue.id, text }]
        : [];
    })
    .slice(-3);
}

/** One request per audible cue; a late saved turn replaces a pending fallback. */
export class SubtitleRequestScheduler {
  private requested = new Set<string>();
  private delayed = new Map<string, ReturnType<typeof setTimeout>>();
  private cues: CaptionCue[] = [];
  private epoch?: string;
  private enabled = false;
  constructor(
    private issue: (request: SubtitleRequest, epoch: string) => void,
  ) {}
  update(cues: CaptionCue[], epoch: string | undefined, enabled: boolean) {
    if (this.epoch !== epoch) {
      this.clearTimers();
      this.requested.clear();
      this.epoch = epoch;
    }
    this.cues = cues;
    this.enabled = enabled;
    if (!enabled || !epoch) return;
    for (const request of subtitleRequests(cues)) {
      const key = `${epoch}:${request.id}`;
      if (this.requested.has(key)) continue;
      if (request.turnId) {
        this.clearTimer(key);
        this.send(request, epoch);
      } else if (!this.delayed.has(key)) {
        this.delayed.set(
          key,
          setTimeout(() => {
            this.delayed.delete(key);
            if (!this.enabled || this.epoch !== epoch) return;
            const latest = subtitleRequests(this.cues).find(
              (item) => item.id === request.id,
            );
            if (latest) this.send(latest, epoch);
          }, 800),
        );
      }
    }
    if (this.requested.size > 96)
      this.requested = new Set([...this.requested].slice(-64));
  }
  stop() {
    this.clearTimers();
    this.enabled = false;
  }
  private send(request: SubtitleRequest, epoch: string) {
    const key = `${epoch}:${request.id}`;
    if (this.requested.has(key)) return;
    this.requested.add(key);
    this.issue(request, epoch);
  }
  private clearTimer(key: string) {
    clearTimeout(this.delayed.get(key));
    this.delayed.delete(key);
  }
  private clearTimers() {
    for (const key of this.delayed.keys()) this.clearTimer(key);
  }
}
export function nextCaptionMode(mode: CaptionMode): CaptionMode {
  return mode === 'off' ? 'english' : mode === 'english' ? 'bilingual' : 'off';
}
export function speechWords(text: string) {
  return text.trim().split(/\s+/).filter(Boolean);
}
export function isEnglishSpeech(text: string) {
  return (
    /[a-z]/i.test(text) &&
    !(text.match(/\p{L}/gu) ?? []).some(
      (letter) => !/[\p{Script=Latin}\p{M}]/u.test(letter),
    )
  );
}
export function assertEnglishSpeech(text: string) {
  if (!isEnglishSpeech(text)) throw Error('ENGLISH_ONLY');
}
export function validateSubtitlePairs(
  value: unknown,
  text: string,
): SubtitlePair[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 40) return;
  const pairs: SubtitlePair[] = [];
  for (const pair of value) {
    const p = pair as SubtitlePair;
    if (
      !p ||
      typeof p.english !== 'string' ||
      !isEnglishSpeech(p.english) ||
      p.english.length > 300 ||
      typeof p.chinese !== 'string' ||
      !/[\u3400-\u9fff]/.test(p.chinese) ||
      p.chinese.length > 250
    )
      return;
    pairs.push({ english: p.english.trim(), chinese: p.chinese.trim() });
  }
  // Translation may segment the text, but cannot add, omit, or rewrite what the teacher said.
  const compact = (s: string) => s.replace(/\s+/g, '');
  if (compact(pairs.map((p) => p.english).join(' ')) !== compact(text)) return;
  return pairs;
}
export function subtitleSourceSegments(text: string) {
  return text
    .trim()
    .split(/(?<=[.!?;,])\s+/)
    .filter(Boolean);
}
export function translatedSubtitlePairs(
  value: unknown,
  text: string,
): SubtitlePair[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 40) return;
  const chinese = value.map((item) =>
    typeof item === 'string' ? item : item?.chinese,
  );
  if (
    chinese.some(
      (line) =>
        typeof line !== 'string' ||
        !/[\u3400-\u9fff]/.test(line) ||
        line.length > 250,
    )
  )
    return;
  const source = subtitleSourceSegments(text);
  const english = source.length === chinese.length ? source : [text.trim()];
  const translations =
    source.length === chinese.length ? chinese : [chinese.join('')];
  return validateSubtitlePairs(
    english.map((segment, index) => ({
      english: segment,
      chinese: translations[index],
    })),
    text,
  );
}
export function captionReducer(
  cues: CaptionCue[],
  event: CaptionEvent,
): CaptionCue[] {
  if (event.type === 'clear') return [];
  let cue = cues.find((c) => c.id === event.id);
  if (!cue) {
    if (event.type !== 'text') return cues;
    cue = {
      id: event.id,
      text: '',
      words: 0,
      started: false,
      done: false,
      interrupted: false,
      approximate: false,
    };
  }
  const next = { ...cue };
  if (event.type === 'text') {
    next.text = event.text;
    next.turnId = event.turnId ?? next.turnId;
    next.pairs = event.pairs ?? next.pairs;
    if (next.done && !next.interrupted)
      next.words = speechWords(next.text).length;
  }
  if (event.type === 'progress' && !next.done) {
    next.started = true;
    next.words = Math.max(
      next.words,
      Math.min(speechWords(next.text).length, Math.max(0, event.words)),
    );
    next.approximate = event.approximate ?? next.approximate;
  }
  if (event.type === 'end') {
    next.done = true;
    next.interrupted = event.interrupted;
    if (!event.interrupted && next.started)
      next.words = speechWords(next.text).length;
  }
  if (event.type === 'translation') {
    next.pairs = event.pairs;
    next.translationError = event.error;
  }
  return [...cues.filter((c) => c.id !== next.id), next]
    .sort((a, b) => {
      const ai = cues.findIndex((c) => c.id === a.id),
        bi = cues.findIndex((c) => c.id === b.id);
      return (ai < 0 ? cues.length : ai) - (bi < 0 ? cues.length : bi);
    })
    .slice(-8);
}
export function wordsAtBoundary(text: string, charIndex: number) {
  const starts = [...text.matchAll(/\S+/g)].map((m) => m.index);
  return starts.filter((start) => start <= charIndex).length;
}
export function estimatedWords(
  text: string,
  elapsed: number,
  duration?: number,
) {
  const words = speechWords(text);
  if (elapsed <= 0 || !words.length) return 0;
  const weights = words.map(
    (w) =>
      Math.max(0.65, w.replace(/[^a-z]/gi, '').length / 4.5) +
      (/[,.!?;:]$/.test(w) ? 0.45 : 0),
  );
  const total = weights.reduce((a, b) => a + b, 0);
  const seconds =
    duration && Number.isFinite(duration) && duration > 0
      ? duration
      : total * 0.48;
  const target = (elapsed / seconds) * total;
  let used = 0,
    count = 0;
  for (const weight of weights) {
    if (used > target) break;
    count++;
    used += weight;
  }
  return Math.min(words.length, count);
}
export function visiblePairs(cue: CaptionCue) {
  let offset = 0;
  return (cue.pairs ?? []).filter((pair) => {
    const start = offset;
    offset += speechWords(pair.english).length;
    return cue.started && cue.words > start;
  });
}
