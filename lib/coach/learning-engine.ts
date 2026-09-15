import { containsPhrase, normalized, type LearningData } from './model';
export type Difficulty = {
  vocabulary: number;
  grammar: number;
  sentenceWords: number;
  speakingRate: number;
  answerWords: number;
  topicDepth: number;
  scaffolding: number;
  independence: number;
  steps: number;
  updatedAt: string;
  reason: string;
  evidenceTurnIds: string[];
};
export const scenes = [
  {
    id: 'greeting',
    name: '问候与认识彼此',
    role: 'a friendly new acquaintance',
  },
  { id: 'daily', name: '日常生活', role: 'a friend chatting about today' },
  {
    id: 'interests',
    name: '兴趣与周末',
    role: 'a friend making weekend plans',
  },
  {
    id: 'food',
    name: '吃饭与点单',
    role: 'a cafe server helping with a real order',
  },
  {
    id: 'shopping',
    name: '购物与询问',
    role: 'a shop assistant helping find an item',
  },
  {
    id: 'travel',
    name: '出行与问路',
    role: 'a local giving simple directions',
  },
  {
    id: 'work',
    name: '工作与合作',
    role: 'a colleague arranging a small task',
  },
  { id: 'social', name: '邀请与安排', role: 'a friend arranging a meeting' },
] as const;
export function initialDifficulty(at: string): Difficulty {
  return {
    vocabulary: 0,
    grammar: 0,
    sentenceWords: 7,
    speakingRate: 0.86,
    answerWords: 3,
    topicDepth: 0,
    scaffolding: 3,
    independence: 0,
    steps: 0,
    updatedAt: at,
    reason: '还没有足够的实际表达，先从一个容易接上的短句开始。',
    evidenceTurnIds: [],
  };
}
export function canonicalScene(value: string) {
  if (scenes.some((s) => s.id === value)) return value;
  const categories: [RegExp, string][] = [
    [/问候|介绍|greet/i, 'greeting'],
    [/点餐|吃饭|咖啡|food|cafe|餐厅/i, 'food'],
    [/兴趣|音乐|周末|interest|hobb/i, 'interests'],
    [/工作|同事|work/i, 'work'],
    [/出行|问路|旅游|travel/i, 'travel'],
    [/购物|shopping/i, 'shopping'],
    [/邀请|朋友|social/i, 'social'],
  ];
  return categories.find(([re]) => re.test(value))?.[1] ?? 'daily';
}
export function requestedChallenge(
  text: string,
): 'harder' | 'easier' | 'slower' | null {
  if (
    /\b(?:not|don't|doesn't|didn't|never|what does|what is|meaning|means|said)\b|不是|不要|别|什么意思|["“”]/i.test(
      text,
    )
  )
    return null;
  if (
    /too (?:easy|simple)|make (?:it|this) harder|more difficult|太简单|太容易|难一点/i.test(
      text,
    )
  )
    return 'harder';
  if (
    /too (?:hard|difficult|fast)|make (?:it|this) easier|太难|简单一点|跟不上/i.test(
      text,
    )
  )
    return 'easier';
  if (/slow(?:er| down)|慢一点|说慢/i.test(text)) return 'slower';
  return null;
}
export function effectiveDifficulty(
  data: LearningData,
  sessionId = data.activeSessionId,
) {
  const d = { ...data.plan.difficulty };
  // A conversation can match demonstrated fluency now without awarding mastery.
  // Ignore hints, echoed examples, legacy text, and unsupported long transcripts.
  const recent = data.turns
    .filter((t) => t.role === 'user' && t.source !== 'legacy-text')
    .slice(-8);
  const fluent = recent.some((t) => {
    if (t.hint || t.observation?.outcome === 'needs_support') return false;
    const words = t.text.toLowerCase().match(/[a-z]+(?:['’][a-z]+)?/g) ?? [];
    const preceding = data.turns
      .slice(0, data.turns.indexOf(t))
      .filter((p) => p.sessionId === t.sessionId && p.role === 'assistant')
      .at(-1);
    const previousWords = new Set(
      preceding?.text.toLowerCase().match(/[a-z]+/g) ?? [],
    );
    const letters = t.text.match(/\p{L}/gu)?.length ?? 0;
    const english = t.text.match(/[a-z]/gi)?.length ?? 0;
    return (
      words.length >= 22 &&
      new Set(words).size >= 16 &&
      english / Math.max(1, letters) > 0.9 &&
      /\b(because|although|despite|however|whereas|which|would|instead|whether|while|if|why)\b/i.test(
        t.text,
      ) &&
      !(
        preceding?.played &&
        words.filter((w) => !previousWords.has(w)).length / words.length < 0.25
      ) &&
      !(preceding?.played && containsPhrase(preceding.text, t.text))
    );
  });
  if (fluent) {
    d.sentenceWords = Math.max(16, d.sentenceWords);
    d.answerWords = Math.max(10, d.answerWords);
    d.scaffolding = Math.min(1, d.scaffolding);
    d.vocabulary = Math.max(2, d.vocabulary);
    d.grammar = Math.max(2, d.grammar);
    d.topicDepth = Math.max(2, d.topicDepth);
    d.speakingRate = Math.max(0.95, d.speakingRate);
    d.reason =
      '最近的自主回答已能连贯表达观点，这次直接用自然追问展开；长期掌握仍由实际证据判断。';
  }
  const preference = data.sessions.find((s) => s.id === sessionId)?.challenge;
  if (preference === 'harder') {
    d.sentenceWords = Math.min(24, d.sentenceWords + 3);
    d.answerWords = Math.min(18, d.answerWords + 2);
    d.reason =
      '你希望多一点挑战，这次交流稍微增加表达长度；长期判断仍看实际表现。';
  }
  if (preference === 'easier') {
    d.sentenceWords = Math.max(4, d.sentenceWords - 3);
    d.answerWords = Math.max(1, d.answerWords - 2);
    d.scaffolding = Math.min(3, d.scaffolding + 1);
    d.reason = '你觉得这次有点难，先缩短问题，给更多等待和逐步提示。';
  }
  if (preference === 'slower' || preference === 'easier')
    d.speakingRate = Math.max(0.7, d.speakingRate - 0.1);
  return d;
}
export function advanceDifficulty(data: LearningData, at: string): Difficulty {
  const old = data.plan.difficulty;
  const observed = data.turns.filter(
    (t) =>
      t.role === 'user' &&
      t.source !== 'legacy-text' &&
      t.observation &&
      (t.observation.observedAt ?? t.at) >= old.updatedAt &&
      !old.evidenceTurnIds.includes(t.id),
  );
  const window = observed
    .sort((a, b) =>
      (a.observation?.observedAt ?? a.at).localeCompare(
        b.observation?.observedAt ?? b.at,
      ),
    )
    .slice(-8);
  if (window.length < 6) return old;
  const usable = window.filter((t) => t.observation?.outcome !== 'uncertain');
  const difficult = usable.filter(
    (t) => t.observation?.outcome === 'needs_support' || t.hint > 0,
  );
  const independent = usable.filter(
    (t) =>
      t.observation?.outcome === 'success' &&
      t.observation.comprehension === 'clear' &&
      t.hint === 0 &&
      data.evidence.some(
        (e) => e.turnId === t.id && e.outcome === 'independent',
      ) &&
      normalized(t.text).split(' ').length >= old.answerWords,
  );
  const days = new Set(independent.map((t) => t.at.slice(0, 10)));
  const sessions = new Set(independent.map((t) => t.sessionId));
  const next = {
    ...old,
    evidenceTurnIds: window.map((t) => t.id),
    updatedAt: at,
  };
  if (
    difficult.length >= 4 &&
    new Set(difficult.map((t) => t.sessionId)).size >= 2
  ) {
    next.sentenceWords = Math.max(4, old.sentenceWords - 2);
    next.answerWords = Math.max(1, old.answerWords - 1);
    next.scaffolding = Math.min(3, old.scaffolding + 1);
    next.reason = '最近多个交流中反复需要帮助，先减少句子负担，保留表达机会。';
    return next;
  }
  if (
    independent.length < 6 ||
    days.size < 2 ||
    sessions.size < 2 ||
    difficult.length > 1 ||
    new Set(independent.map((t) => normalized(t.text))).size < 3
  )
    return old;
  // One small change after repeated independent evidence; no single answer can raise a level.
  const axis = old.steps % 6;
  next.steps = old.steps + 1;
  if (axis === 0) next.sentenceWords = Math.min(24, old.sentenceWords + 2);
  if (axis === 1) next.answerWords = Math.min(18, old.answerWords + 2);
  if (axis === 2) next.vocabulary = Math.min(4, old.vocabulary + 1);
  if (axis === 3) next.grammar = Math.min(4, old.grammar + 1);
  if (axis === 4) {
    next.scaffolding = Math.max(0, old.scaffolding - 1);
    next.independence = Math.min(3, old.independence + 1);
  }
  if (axis === 5) {
    next.topicDepth = Math.min(4, old.topicDepth + 1);
    next.speakingRate = Math.min(
      1,
      Number((old.speakingRate + 0.03).toFixed(2)),
    );
  }
  next.reason =
    '不同日期的多次交流中，你能独立完成表达，下一次只增加一点挑战。';
  return next;
}
export function skillProgress(
  data: LearningData,
  at = new Date().toISOString(),
) {
  const groups = new Map<
    string,
    {
      phrase: string;
      meaning: string;
      exposures: number;
      assisted: number;
      independent: number;
      days: Set<string>;
      contexts: Set<string>;
      last: string;
      lastIndependent: string | null;
      lastAttempt: string | null;
    }
  >();
  for (const e of data.evidence) {
    const key = normalized(e.phrase);
    const row = groups.get(key) ?? {
      phrase: e.phrase,
      meaning: e.meaning,
      exposures: 0,
      assisted: 0,
      independent: 0,
      days: new Set<string>(),
      contexts: new Set<string>(),
      last: e.at,
      lastIndependent: null,
      lastAttempt: null,
    };
    row.last = e.at > row.last ? e.at : row.last;
    if (e.outcome === 'exposed') row.exposures++;
    else if (e.outcome === 'assisted') {
      row.assisted++;
      row.lastAttempt =
        !row.lastAttempt || e.at > row.lastAttempt ? e.at : row.lastAttempt;
    } else {
      row.lastAttempt =
        !row.lastAttempt || e.at > row.lastAttempt ? e.at : row.lastAttempt;
      row.independent++;
      row.days.add(e.at.slice(0, 10));
      row.contexts.add(canonicalScene(e.context));
      row.lastIndependent =
        !row.lastIndependent || e.at > row.lastIndependent
          ? e.at
          : row.lastIndependent;
    }
    groups.set(key, row);
  }
  return [...groups.values()].map((row) => {
    const count = row.days.size;
    const interval = [1, 1, 3, 7, 14, 30][Math.min(5, count)];
    const dueAt = new Date(
      Date.parse(row.lastAttempt ?? row.last) + interval * 86400000,
    ).toISOString();
    return {
      phrase: row.phrase,
      meaning: row.meaning,
      exposures: row.exposures,
      assisted: row.assisted,
      independent: row.independent,
      days: [...row.days],
      contexts: [...row.contexts],
      dueAt,
      due: dueAt <= at,
      stage:
        count >= 3 && row.contexts.size >= 2
          ? '跨场景用过'
          : count >= 2
            ? '隔天仍能说'
            : row.independent
              ? '独立说过'
              : row.assisted
                ? '在帮助下说过'
                : '听过示范',
    };
  });
}
export function lessonContext(
  data: LearningData,
  at = new Date().toISOString(),
) {
  const recentContexts = data.turns
    .filter((t) => t.role === 'user' && t.observation)
    .slice(-8)
    .map((t) => t.observation!.context);
  const spoken = data.turns.filter(
    (t) => t.role === 'user' && t.source !== 'legacy-text',
  );
  const scene =
    spoken.length < 3
      ? scenes[0]
      : scenes
          .slice(1)
          .map((scene, index) => ({
            scene,
            weight:
              recentContexts.filter((c) => canonicalScene(c) === scene.id)
                .length *
                20 +
              ((index + data.sessions.length) % 7),
          }))
          .sort((a, b) => a.weight - b.weight)[0].scene;
  return {
    firstMeeting: spoken.length === 0,
    difficulty: effectiveDifficulty(data),
    scene,
    dueExpressions: skillProgress(data, at)
      .filter((p) => p.due)
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
      .slice(0, 3),
    recentCorrections: data.turns
      .filter((t) => t.observation?.correction)
      .slice(-3)
      .map((t) => ({
        original: t.observation!.correction!.original,
        better: t.observation!.correction!.better,
      })),
    englishRatio: 1,
  };
}
