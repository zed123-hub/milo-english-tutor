import {
  initialDifficulty,
  skillProgress,
  type Difficulty,
} from './learning-engine';
export type VoiceSource = 'realtime' | 'asr' | 'browser-speech' | 'legacy-text';
export type Turn = {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  text: string;
  at: string;
  source: VoiceSource;
  seconds: number;
  hint: number;
  played: boolean;
  assessed: boolean;
  observation?: {
    observedAt?: string;
    outcome: 'success' | 'uncertain' | 'needs_support';
    context: string;
    comprehension: 'clear' | 'uncertain' | 'needs_support';
    correction?: { original: string; better: string; note: string };
  };
};
export type Fact = {
  id: string;
  kind: 'name' | 'interest' | 'goal' | 'difficulty' | 'context';
  text: string;
  quote: string;
  turnId: string;
  at: string;
};
export type Evidence = {
  id: string;
  turnId: string;
  phrase: string;
  meaning: string;
  context: string;
  outcome: 'independent' | 'assisted' | 'exposed';
  at: string;
};
export type Conversation = {
  id: string;
  startedAt: string;
  endedAt: string | null;
  summary: string;
  challenge?: 'harder' | 'easier' | 'slower';
};
export type TeachingPlan = {
  focus: string;
  reason: string;
  nextOpening: string;
  review: string[];
  suggestedMinutes: number;
  updatedAt: string;
  difficulty: Difficulty;
  sourceSessionId?: string;
};
export type LearningData = {
  schemaVersion: 4;
  analyses: {
    id: string;
    sessionId: string;
    turnIds: string[];
    cursor: number;
    status: 'queued' | 'running' | 'waiting' | 'failed' | 'complete';
    attempts: number;
    error: string | null;
    updatedAt: string;
  }[];
  createdAt: string;
  facts: Fact[];
  turns: Turn[];
  evidence: Evidence[];
  sessions: Conversation[];
  memories: { sessionId: string; text: string; at: string }[];
  plan: TeachingPlan;
  activeSessionId: string | null;
  hint: number;
  legacy: { importedAt: string; state: unknown } | null;
};
export type Snapshot = { revision: number; epoch: string; data: LearningData };
export type LearningRepository = {
  read(): Snapshot;
  commit(previous: Snapshot, data: LearningData, commandId: string): Snapshot;
  seen(commandId: string): boolean;
  replace(previous: Snapshot, data: LearningData): Snapshot;
  recovery(): LearningData | null;
};
export function freshData(at = new Date().toISOString()): LearningData {
  return {
    schemaVersion: 4,
    analyses: [],
    createdAt: at,
    facts: [],
    turns: [],
    evidence: [],
    sessions: [],
    memories: [],
    activeSessionId: null,
    hint: 0,
    legacy: null,
    plan: {
      difficulty: initialDifficulty(at),
      focus: '先用一句真实的问候认识彼此',
      reason: '还没有实际听说证据，先从轻松交流开始。',
      nextOpening: 'Hi, I’m Milo. Let’s speak English together. Say hello!',
      review: [],
      suggestedMinutes: 5,
      updatedAt: at,
    },
  };
}
export function normalized(text: string) {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}' ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
export function containsPhrase(text: string, phrase: string) {
  return ` ${normalized(text)} `.includes(` ${normalized(phrase)} `);
}
export function accomplishments(data: LearningData) {
  const spoken = data.turns.filter(
    (t) => t.role === 'user' && t.source !== 'legacy-text',
  );
  const phrases = skillProgress(data).filter(
    (p) => p.assisted || p.independent,
  );
  return {
    turns: spoken.length,
    seconds: Math.round(spoken.reduce((n, t) => n + t.seconds, 0)),
    days: new Set(spoken.map((t) => t.at.slice(0, 10))).size,
    sessions: data.sessions.filter((s) =>
      spoken.some((t) => t.sessionId === s.id),
    ).length,
    phrases,
  };
}
export function memoryContext(data: LearningData) {
  return {
    session: data.sessions.find((s) => s.id === data.activeSessionId),
    elapsedMinutes: data.activeSessionId
      ? Math.floor(
          (Date.now() -
            Date.parse(
              data.sessions.find((s) => s.id === data.activeSessionId)
                ?.startedAt ?? new Date().toISOString(),
            )) /
            60000,
        )
      : 0,
    facts: data.facts
      .slice(-30)
      .map((f) => ({ kind: f.kind, text: f.text, quote: f.quote })),
    memories: data.memories.slice(-5),
    plan: data.plan,
    progress: accomplishments(data).phrases.slice(-25),
    conversation: data.turns
      .filter((t) => t.sessionId === data.activeSessionId)
      .slice(-16)
      .map((t) => ({
        id: t.id,
        role: t.role,
        text: t.text,
        hint: t.hint,
        played: t.played,
      })),
  };
}

export function wantsToStop(text: string) {
  return /^(?:ok(?:ay)?[,.! ]*)?(?:bye(?: bye)?|goodbye|stop(?: please)?|let(?:'|’)s stop|that(?:'|’)s enough|i(?:'|’)m done|see you(?: later)?|结束(?:吧)?|再见|不学了|暂停(?:一下)?|休息(?:一下)?)[.!。！ ]*$/i.test(
    text.trim(),
  );
}

export function upgradeData(value: unknown): LearningData {
  const data = value as LearningData;
  if ((value as { schemaVersion?: number }).schemaVersion === 3)
    return {
      ...data,
      schemaVersion: 4,
      analyses: [],
      plan: { ...data.plan, difficulty: initialDifficulty(data.createdAt) },
    };
  return data;
}
