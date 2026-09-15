import { allPhrases, lessons } from './curriculum';
export type Review = {
  phraseId: string;
  due: string;
  successes: number;
  mistakes: number;
  lastSuccessDate?: string;
};
export type Session = {
  lessonId: number;
  phraseIndex: number;
  step: number;
  hinted: boolean;
  mistakes: number;
  quick: boolean;
  mode: 'lesson' | 'review';
  reviewIds: string[];
  completed?: boolean;
  graded?: boolean;
};
export type ProgressData = {
  version: 1;
  completedLessons: number[];
  reviews: Review[];
  days: Record<string, number>;
  attempts: number;
  correct: number;
  session: Session | null;
  reminder: string;
  dailyMinutes: number;
};
export const initialProgress: ProgressData = {
  version: 1,
  completedLessons: [],
  reviews: [],
  days: {},
  attempts: 0,
  correct: 0,
  session: null,
  reminder: '20:30',
  dailyMinutes: 5,
};
export function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function nextDate(days: number, now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  return dayKey(d);
}
export function dueReviews(p: ProgressData, now = new Date()) {
  return p.reviews
    .filter((r) => r.due <= dayKey(now))
    .sort((a, b) => a.due.localeCompare(b.due));
}
export function recordAnswer(
  p: ProgressData,
  id: string,
  independent: boolean,
  now = new Date(),
): ProgressData {
  const old = p.reviews.find((r) => r.phraseId === id);
  const today = dayKey(now);
  // Multiple same-day attempts never accelerate the spaced schedule.
  const successes = independent
    ? (old?.successes ?? 0) + (old?.lastSuccessDate === today ? 0 : 1)
    : 0;
  const intervals = [1, 1, 3, 7, 14, 30];
  const review: Review = {
    phraseId: id,
    successes,
    mistakes: (old?.mistakes ?? 0) + (independent ? 0 : 1),
    lastSuccessDate: independent ? today : old?.lastSuccessDate,
    due: nextDate(intervals[Math.min(successes, 5)], now),
  };
  return {
    ...p,
    reviews: [...p.reviews.filter((r) => r.phraseId !== id), review],
    attempts: p.attempts + 1,
    correct: p.correct + (independent ? 1 : 0),
    days: { ...p.days, [today]: (p.days[today] ?? 0) + 1 },
  };
}
export function parseProgress(raw: string | null): ProgressData {
  if (!raw) return structuredClone(initialProgress);
  try {
    const v = JSON.parse(raw);
    if (
      v.version !== 1 ||
      !Array.isArray(v.completedLessons) ||
      !Array.isArray(v.reviews) ||
      !v.days ||
      typeof v.days !== 'object' ||
      Array.isArray(v.days)
    )
      throw Error('shape');
    const validIds = new Set(allPhrases.map((p) => p.id));
    const reviews = v.reviews.filter(
      (r: Review) =>
        r &&
        validIds.has(r.phraseId) &&
        /^\d{4}-\d{2}-\d{2}$/.test(r.due) &&
        Number.isInteger(r.successes) &&
        r.successes >= 0 &&
        Number.isInteger(r.mistakes) &&
        r.mistakes >= 0,
    );
    const completedLessons = [
      ...new Set<number>(
        v.completedLessons.filter(
          (x: number) => Number.isInteger(x) && x >= 0 && x < lessons.length,
        ),
      ),
    ];
    let session: Session | null = v.session;
    if (
      session &&
      !(
        Number.isInteger(session.lessonId) &&
        session.lessonId >= 0 &&
        session.lessonId < lessons.length &&
        Number.isInteger(session.phraseIndex) &&
        session.phraseIndex >= 0 &&
        session.phraseIndex < 3 &&
        [0, 1, 2].includes(session.step) &&
        ['lesson', 'review'].includes(session.mode) &&
        typeof session.hinted === 'boolean' &&
        typeof session.quick === 'boolean' &&
        Number.isInteger(session.mistakes) &&
        session.mistakes >= 0 &&
        Array.isArray(session.reviewIds) &&
        session.reviewIds.length <= 3 &&
        session.reviewIds.every((id) => validIds.has(id)) &&
        (session.mode !== 'review' ||
          (session.reviewIds.length > 0 &&
            session.phraseIndex < session.reviewIds.length)) &&
        (!session.quick ||
          (session.mode === 'lesson' &&
            session.phraseIndex === 0 &&
            session.reviewIds.length === 1 &&
            lessons[session.lessonId].phrases.some(
              (p) => p.id === session?.reviewIds[0],
            )))
      )
    )
      session = null;
    return {
      ...initialProgress,
      completedLessons,
      reviews,
      days: Object.fromEntries(
        Object.entries(v.days).filter(
          (entry): entry is [string, number] =>
            /^\d{4}-\d{2}-\d{2}$/.test(entry[0]) &&
            typeof entry[1] === 'number' &&
            Number.isFinite(entry[1]) &&
            entry[1] >= 0,
        ),
      ),
      attempts:
        Number.isInteger(v.attempts) && v.attempts >= 0 ? v.attempts : 0,
      correct:
        Number.isInteger(v.correct) && v.correct >= 0
          ? Math.min(v.correct, v.attempts || 0)
          : 0,
      session,
      reminder: /^([01]\d|2[0-3]):[0-5]\d$/.test(v.reminder)
        ? v.reminder
        : '20:30',
      dailyMinutes: [2, 5, 10].includes(v.dailyMinutes) ? v.dailyMinutes : 5,
    };
  } catch {
    return structuredClone(initialProgress);
  }
}
export function calendarFile(time: string, now = new Date(), minutes = 5) {
  const [h, m] = time.split(':').map(Number);
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const stamp = (d: Date) =>
    d
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
  // Floating local time preserves the learner's selected hour across DST.
  const local = `${dayKey(next).replace(/-/g, '')}T${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}00`;
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Milo//English Tutor//ZH',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:milo-daily-${time.replace(':', '')}@milo.local`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${local}`,
    `DURATION:PT${minutes}M`,
    'RRULE:FREQ=DAILY',
    `SUMMARY:和 Milo 学 ${minutes} 分钟英语`,
    'DESCRIPTION:打开 Milo，继续今天的一小步。',
    'BEGIN:VALARM',
    'TRIGGER:-PT0M',
    'ACTION:DISPLAY',
    'DESCRIPTION:今天只学一点点也很好。',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

export function createStudySession(
  p: ProgressData,
  lessonId: number,
  quick = false,
): Session {
  const lesson = lessons[lessonId];
  const next =
    lesson.phrases.find(
      (phrase) => !p.reviews.some((r) => r.phraseId === phrase.id),
    ) ?? lesson.phrases[0];
  return {
    lessonId,
    phraseIndex: 0,
    step: 0,
    hinted: false,
    mistakes: 0,
    quick,
    mode: 'lesson',
    reviewIds: quick ? [next.id] : [],
  };
}
export function sessionPhrases(s: Session) {
  const lesson = lessons[s.lessonId];
  return s.mode === 'review'
    ? s.reviewIds.map((id) => allPhrases.find((p) => p.id === id)!)
    : s.quick
      ? [allPhrases.find((p) => p.id === s.reviewIds[0]) ?? lesson.phrases[0]]
      : lesson.phrases;
}
export function submitRecall(p: ProgressData, now = new Date()): ProgressData {
  const s = p.session;
  if (!s || s.completed || s.graded || s.step !== 2) return p;
  const phrase = sessionPhrases(s)[s.phraseIndex];
  return {
    ...recordAnswer(p, phrase.id, !s.hinted && s.mistakes === 0, now),
    session: { ...s, graded: true },
  };
}
export function advanceStudySession(p: ProgressData): ProgressData {
  const s = p.session;
  if (!s || s.completed) return p;
  if (s.step > 0 && !s.graded) return p;
  if (s.step < 2)
    return { ...p, session: { ...s, step: s.step + 1, graded: false } };
  const phrases = sessionPhrases(s);
  if (s.phraseIndex < phrases.length - 1)
    return {
      ...p,
      session: {
        ...s,
        phraseIndex: s.phraseIndex + 1,
        step: s.mode === 'review' ? 2 : 0,
        hinted: false,
        mistakes: 0,
        graded: false,
      },
    };
  const completesLesson =
    s.mode === 'lesson' &&
    (!s.quick ||
      lessons[s.lessonId].phrases.every((phrase) =>
        p.reviews.some((r) => r.phraseId === phrase.id),
      ));
  return {
    ...p,
    session: { ...s, completed: true },
    completedLessons: completesLesson
      ? [...new Set([...p.completedLessons, s.lessonId])]
      : p.completedLessons,
  };
}
