import {
  getTask,
  inventory,
  taskLibrary,
  observedItems,
  type TaskTemplate,
  type ScenarioId,
} from './inventory';
export type InputMode = 'typed' | 'browser-speech' | 'realtime';
export type MasteryStage =
  | 'NOTICE'
  | 'UNDERSTAND'
  | 'RECALL'
  | 'GUIDED_USE'
  | 'INDEPENDENT_USE'
  | 'TRANSFER_USE';
export type Evidence = {
  id: string;
  sessionId: string;
  taskId: string;
  at: string;
  studyDay: string;
  inputMode: InputMode;
  transcript: string;
  hintLevel: number;
  sourceExposed: boolean;
  audioPlayed: boolean;
  retry: boolean;
  outcome: 'pass' | 'fail' | 'uncertain';
  verifiedItems: string[];
  feedback: string;
  error?: string;
  latencyMs?: number;
  durationMs?: number;
  assessment: 'model' | 'rules';
};
export type ItemState = {
  id: string;
  stage: MasteryStage;
  spokenDays: string[];
  spokenScenarios: ScenarioId[];
  textDays: string[];
  evidenceIds: string[];
  due: string;
  needsPractice: boolean;
  lastSeen: string;
};
export type Learner = {
  name: string;
  goal: 'life' | 'travel' | 'work';
  background: 'beginner' | 'learned' | 'unsure';
  minutes: 5 | 10 | 15;
  energy: 'low' | 'normal';
};
export type Plan = {
  id: string;
  kind: 'diagnostic' | 'practice' | 'morning';
  title: string;
  reason: string;
  taskIds: string[];
  minutes: number;
  createdAt: string;
};
export type StudySession = {
  id: string;
  plan: Plan;
  index: number;
  hintLevel: number;
  sourceExposed: boolean;
  audioPlayed: boolean;
  retries: number;
  turns: Evidence[];
  status: 'active' | 'review' | 'complete';
  lastFeedback?: string;
};
export type StudentState = {
  version: 2;
  configured: boolean;
  profile: Learner;
  items: Record<string, ItemState>;
  evidence: Evidence[];
  session: StudySession | null;
  history: {
    id: string;
    at: string;
    title: string;
    independent: number;
    assisted: number;
    unmeasured: number;
  }[];
  diagnosticCompleted: boolean;
};
export type Evaluation = {
  outcome: 'pass' | 'fail' | 'uncertain';
  feedback: string;
  verifiedItems: string[];
  error?: string;
  assessment: 'model' | 'rules';
};
export const emptyStudent = (): StudentState => ({
  version: 2,
  configured: false,
  profile: {
    name: '',
    goal: 'life',
    background: 'unsure',
    minutes: 10,
    energy: 'normal',
  },
  items: {},
  evidence: [],
  session: null,
  history: [],
  diagnosticCompleted: false,
});
export function localDay(at: string, timeZone = 'Asia/Tokyo') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at));
}
export function addDays(day: string, days: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export function makePlan(
  state: StudentState,
  at: string,
  id: string,
  mode: 'practice' | 'morning' = 'practice',
): Plan {
  const today = localDay(at);
  const low = state.profile.energy === 'low' || state.profile.minutes === 5;
  if (!state.diagnosticCompleted)
    return {
      id,
      kind: 'diagnostic',
      title: '先聊几句，让我认识你的英语',
      reason:
        '先分别观察表达、听懂和真实使用。不会的地方，我会直接教你；本次只建立初步画像。',
      taskIds: ['intro', 'listen-routine', 'coffee-simple'],
      minutes: low ? 5 : 10,
      createdAt: at,
    };
  if (mode === 'morning')
    return {
      id,
      kind: 'morning',
      title: '先聊聊今天',
      reason: '今天先轻松说一句；你的真实使用仍会成为我了解你的证据。',
      taskIds: ['morning-plan'],
      minutes: 3,
      createdAt: at,
    };
  const recent = state.evidence.slice(-12);
  const repeated = recent
    .filter((e) => e.outcome === 'fail' && e.error)
    .find((e) => recent.filter((x) => x.error === e.error).length >= 3);
  const due = Object.values(state.items)
    .filter((i) => i.due <= today)
    .sort(
      (a, b) =>
        Number(b.needsPractice) - Number(a.needsPractice) ||
        a.due.localeCompare(b.due) ||
        a.id.localeCompare(b.id),
    );
  const independent = Object.values(state.items)
    .filter((i) => i.stage === 'INDEPENDENT_USE')
    .sort((a, b) => a.id.localeCompare(b.id));
  const selected: string[] = [];
  const reasons: string[] = [];
  if (repeated) {
    selected.push(repeated.taskId);
    reasons.push('最近同类困难重复出现，先把这一处拆小练习。');
  }
  if (due.length) {
    const target = taskLibrary.find(
      (t) => t.targetIds.includes(due[0].id) && t.kind !== 'listen',
    );
    if (target && !selected.includes(target.id)) {
      selected.push(target.id);
      reasons.push(
        `「${inventory.find((i) => i.id === due[0].id)?.phrase}」到了再次使用的时间。`,
      );
    }
  }
  for (const item of independent) {
    const target = taskLibrary.find(
      (t) =>
        t.targetIds.includes(item.id) &&
        !item.spokenScenarios.includes(t.scenario) &&
        t.kind !== 'listen',
    );
    if (target && !selected.includes(target.id)) {
      selected.push(target.id);
      reasons.push('你已在熟悉的情境中独立使用，试着带到一个新场景。');
      break;
    }
  }
  const listeningAttempts = state.evidence.filter(
    (e) => getTask(e.taskId).kind === 'listen',
  );
  const lastListening = listeningAttempts.at(-1);
  if (
    !low &&
    selected.length < 2 &&
    (!lastListening || lastListening.studyDay !== today)
  ) {
    const listen = taskLibrary
      .filter((t) => t.kind === 'listen')
      .sort(
        (a, b) =>
          listeningAttempts.filter((e) => e.taskId === a.id).length -
            listeningAttempts.filter((e) => e.taskId === b.id).length ||
          a.id.localeCompare(b.id),
      );
    selected.push(listen[0].id);
    reasons.push('用一小段听力继续观察你是否能脱离字幕抓住信息。');
  }
  const spoken = state.evidence.filter(
    (e) =>
      e.inputMode !== 'typed' &&
      e.outcome === 'pass' &&
      getTask(e.taskId).kind !== 'listen' &&
      e.hintLevel === 0 &&
      !e.sourceExposed &&
      !e.retry,
  );
  const level =
    spoken.length >= 4 && new Set(spoken.map((e) => e.studyDay)).size >= 2
      ? 2
      : 1;
  const scenario: ScenarioId =
    state.profile.goal === 'work'
      ? 'office'
      : state.profile.goal === 'travel'
        ? 'airport'
        : 'friends';
  const candidates = taskLibrary
    .filter(
      (t) =>
        t.kind !== 'listen' && t.level <= level && !selected.includes(t.id),
    )
    .sort((a, b) => {
      const countA = state.evidence.filter(
        (e) => e.taskId === a.id && e.outcome === 'pass',
      ).length;
      const countB = state.evidence.filter(
        (e) => e.taskId === b.id && e.outcome === 'pass',
      ).length;
      return (
        countA - countB ||
        Number(b.scenario === scenario) - Number(a.scenario === scenario) ||
        a.id.localeCompare(b.id)
      );
    });
  if (selected.length < (low ? 1 : 2) && candidates[0]) {
    selected.push(candidates[0].id);
    reasons.push(
      low
        ? '今天精力有限，只完成一个小交流。'
        : '引入一点新表达，保持在目前能完成的难度。',
    );
  }
  if (!selected.length) selected.push('coffee-simple');
  return {
    id,
    kind: 'practice',
    title: low ? '今天，完成一件小事就好' : '我为你安排了下一段对话',
    reason: reasons.join(' '),
    taskIds: [...new Set(selected)].slice(
      0,
      low ? 1 : state.profile.minutes === 15 ? 3 : 2,
    ),
    minutes: low ? 5 : state.profile.minutes,
    createdAt: at,
  };
}
export function startSession(plan: Plan): StudySession {
  return {
    id: plan.id,
    plan,
    index: 0,
    hintLevel: 0,
    sourceExposed: false,
    audioPlayed: false,
    retries: 0,
    turns: [],
    status: 'active',
  };
}
export function currentTask(s: StudentState) {
  if (!s.session) throw new Error('请先开始一次会话。');
  return getTask(s.session.plan.taskIds[s.session.index]);
}
export function revealHint(s: StudentState): StudentState {
  if (!s.session || s.session.status !== 'active') return s;
  const level = Math.min(3, s.session.hintLevel + 1);
  return {
    ...s,
    session: {
      ...s.session,
      hintLevel: level,
      sourceExposed: s.session.sourceExposed || level === 3,
    },
  };
}
export function reduceEvidence(
  state: StudentState,
  event: Evidence,
): StudentState {
  if (state.evidence.some((e) => e.id === event.id)) return state;
  const task = getTask(event.taskId);
  const items = { ...state.items };
  const independent =
    event.outcome === 'pass' &&
    event.hintLevel === 0 &&
    !event.sourceExposed &&
    !event.retry;
  const speech = event.inputMode !== 'typed' && task.kind !== 'listen';
  const verified =
    task.kind === 'listen'
      ? []
      : observedItems(event.transcript, task.targetIds).filter((id) =>
          event.verifiedItems.includes(id),
        );
  // Listening comprehension updates target-item understanding without pretending the learner uttered the phrase.
  if (task.kind === 'listen' && independent && event.audioPlayed)
    verified.push(...task.targetIds.filter((id) => !verified.includes(id)));
  for (const id of new Set([
    ...verified,
    ...(event.outcome === 'fail' &&
    (task.kind !== 'listen' || (event.audioPlayed && !event.sourceExposed))
      ? task.targetIds
      : []),
  ])) {
    const previous = items[id] ?? {
      id,
      stage: 'NOTICE',
      spokenDays: [],
      spokenScenarios: [],
      textDays: [],
      evidenceIds: [],
      due: event.studyDay,
      needsPractice: false,
      lastSeen: event.at,
    };
    const item: ItemState = {
      ...previous,
      evidenceIds: [...previous.evidenceIds, event.id].slice(-30),
      spokenDays: [...previous.spokenDays],
      spokenScenarios: [...previous.spokenScenarios],
      textDays: [...previous.textDays],
      lastSeen: event.at,
    };
    let stage: MasteryStage = previous.stage;
    if (event.outcome === 'pass') {
      if (task.kind === 'listen' && independent && event.audioPlayed)
        stage = 'UNDERSTAND';
      else if (event.hintLevel > 0 || event.sourceExposed || event.retry)
        stage = 'GUIDED_USE';
      else if (speech) {
        item.spokenDays = [...new Set([...item.spokenDays, event.studyDay])];
        item.spokenScenarios = [
          ...new Set([...item.spokenScenarios, task.scenario]),
        ];
        stage =
          item.spokenDays.length >= 3 && item.spokenScenarios.length >= 2
            ? 'TRANSFER_USE'
            : item.spokenDays.length >= 2
              ? 'INDEPENDENT_USE'
              : 'RECALL';
      } else {
        item.textDays = [...new Set([...item.textDays, event.studyDay])];
        stage = 'RECALL';
      }
    }
    const ranks: MasteryStage[] = [
      'NOTICE',
      'UNDERSTAND',
      'RECALL',
      'GUIDED_USE',
      'INDEPENDENT_USE',
      'TRANSFER_USE',
    ];
    item.stage =
      ranks.indexOf(stage) > ranks.indexOf(previous.stage)
        ? stage
        : previous.stage;
    const newDay =
      speech && independent && !previous.spokenDays.includes(event.studyDay);
    const interval = !independent
      ? 1
      : [1, 1, 3, 7, 14][Math.min(item.spokenDays.length, 4)];
    item.due =
      newDay || !independent || !items[id]
        ? addDays(event.studyDay, interval)
        : previous.due;
    item.needsPractice = event.outcome === 'fail' || !independent;
    items[id] = item;
  }
  return {
    ...state,
    items,
    evidence: [...state.evidence, event].slice(-200),
    session: state.session
      ? {
          ...state.session,
          status: 'review',
          lastFeedback: event.feedback,
          turns: [...state.session.turns, event],
        }
      : null,
  };
}
export function continueSession(state: StudentState): StudentState {
  const session = state.session;
  if (!session || session.status !== 'review') return state;
  const last = session.turns.at(-1);
  if (last?.outcome === 'fail' && session.retries === 0)
    return {
      ...state,
      session: {
        ...session,
        status: 'active',
        hintLevel: Math.max(1, session.hintLevel),
        retries: session.retries + 1,
      },
    };
  if (session.index < session.plan.taskIds.length - 1)
    return {
      ...state,
      session: {
        ...session,
        index: session.index + 1,
        status: 'active',
        hintLevel: 0,
        sourceExposed: false,
        audioPlayed: false,
        retries: 0,
      },
    };
  return {
    ...state,
    diagnosticCompleted:
      state.diagnosticCompleted || session.plan.kind === 'diagnostic',
    session: { ...session, status: 'complete' },
    history: [
      {
        id: session.id,
        at: last?.at ?? session.plan.createdAt,
        title: session.plan.title,
        independent: session.turns.filter(
          (e) =>
            e.outcome === 'pass' &&
            e.hintLevel === 0 &&
            !e.retry &&
            !e.sourceExposed,
        ).length,
        assisted: session.turns.filter(
          (e) =>
            e.outcome === 'pass' &&
            (e.hintLevel > 0 || e.retry || e.sourceExposed),
        ).length,
        unmeasured: session.turns.filter((e) => e.outcome === 'uncertain')
          .length,
      },
      ...state.history,
    ].slice(0, 30),
  };
}
export function ruleEvaluation(task: TaskTemplate, text: string): Evaluation {
  const normalized = text.toLowerCase().replace(/[’‘]/g, "'");
  const english = /[a-z]{2}/i.test(text);
  let pass = false;
  if (task.id === 'listen-order')
    pass =
      /\btea\b|茶/.test(normalized) &&
      /without sugar|no sugar|unsweetened|不加糖|无糖|不要糖/.test(
        normalized,
      ) &&
      !/coffee|咖啡|加了糖|with sugar/.test(normalized);
  if (task.id === 'listen-work')
    pass =
      /tomorrow|明天/.test(normalized) &&
      /file|document|文件/.test(normalized) &&
      /send|发|寄/.test(normalized) &&
      !/today|今天|昨天|yesterday/.test(normalized);
  if (task.id === 'listen-routine')
    pass =
      /morning|早上|早晨|上午|清晨/.test(normalized) &&
      !/晚上|下午|evening|afternoon|not.*morning/.test(normalized);
  if (task.id === 'intro')
    pass =
      /\b(my name is|call me)\s+[a-z]{2,}/i.test(normalized) ||
      /\b(i am|i'm)\s+(?!(?:not|fine|good|tired|happy|hungry|sad|a|an|the|going|from)\b)[a-z]{2,}(?:[.!?]|$)/i.test(
        normalized.trim(),
      );
  if (task.id === 'coffee-simple')
    pass =
      /coffee/.test(normalized) &&
      /\b(?:can i|could i|i'd like|i would like)\b.*\bcoffee\b|^(?:a |one )?coffee,? please[.!]?$/i.test(
        normalized.trim(),
      ) &&
      !/don't|do not|not want|no coffee/.test(normalized);
  if (task.id === 'coffee-detail')
    pass =
      /iced? coffee/.test(normalized) &&
      /without sugar|no sugar|sugar free/.test(normalized) &&
      !/don't want|do not want|not.*coffee/.test(normalized);
  if (task.id === 'office-request')
    pass =
      /file|document/.test(normalized) &&
      /can i|could you|please|would you/.test(normalized) &&
      !/don't|do not/.test(normalized);
  if (task.id === 'airport-clarify')
    pass =
      /\b(again|repeat|slowly|slower)\b/.test(normalized) &&
      /\b(please|could|can|would)\b/.test(normalized) &&
      !/\b(not|never|don't|do not)\b/.test(normalized);
  if (task.id === 'office-clarify')
    pass = /what.*mean|explain|don't understand|do not understand/.test(
      normalized,
    );
  if (task.id === 'friends-preference')
    pass =
      /pizza|noodles/.test(normalized) &&
      /\bbecause\s+(?:[a-z]+[ ,']+){1,}[a-z]+/.test(normalized);
  if (task.id === 'cafe-preference')
    pass =
      /coffee|tea/.test(normalized) &&
      /\bbecause\s+(?:[a-z]+[ ,']+){1,}[a-z]+/.test(normalized);
  if (task.id === 'friends-past')
    pass =
      /went|visited|stayed/.test(normalized) && /was|felt/.test(normalized);
  if (task.id === 'morning-plan')
    pass =
      /\b(?:i'm going to|i am going to|i will|i plan to)\s+[a-z]{2,}|\bi'm not sure\b/.test(
        normalized,
      );
  if (task.id === 'friends-plan')
    pass = /weather/.test(normalized) && /depend|if|not sure/.test(normalized);
  const wrong = task.kind === 'listen' && !pass ? true : !english;
  return {
    outcome: pass ? 'pass' : wrong ? 'fail' : 'uncertain',
    feedback: pass
      ? task.kind === 'listen'
        ? '你抓住了时间信息。能否算独立听懂，还会结合音频和字幕使用情况记录。'
        : '你表达的意思完成了这次小任务。下一步会根据是否获得提示分别安排。'
      : wrong
        ? '先不用急。我们把问题拆小一点，再试一次。'
        : '这句话可能有合理的表达方式。内置检查无法可靠确认，请连接导师模型获得语义反馈；这次不会记成语言错误。',
    verifiedItems: pass ? observedItems(text, task.targetIds) : [],
    assessment: 'rules',
  };
}
export function studentSummary(s: StudentState) {
  const listening = s.evidence.filter(
    (e) =>
      getTask(e.taskId).kind === 'listen' &&
      e.audioPlayed &&
      !e.sourceExposed &&
      e.hintLevel === 0 &&
      e.outcome !== 'uncertain',
  );
  const speaking = s.evidence.filter(
    (e) =>
      getTask(e.taskId).kind !== 'listen' &&
      e.inputMode !== 'typed' &&
      e.outcome !== 'uncertain',
  );
  const independent = speaking.filter(
    (e) =>
      e.outcome === 'pass' && e.hintLevel === 0 && !e.sourceExposed && !e.retry,
  );
  return {
    listening: {
      samples: listening.length,
      successful: listening.filter((e) => e.outcome === 'pass').length,
    },
    speaking: { samples: speaking.length, independent: independent.length },
    typed: s.evidence.filter((e) => e.inputMode === 'typed').length,
    activeItems: Object.values(s.items).filter(
      (i) => i.stage === 'INDEPENDENT_USE' || i.stage === 'TRANSFER_USE',
    ).length,
    transferItems: Object.values(s.items).filter(
      (i) => i.stage === 'TRANSFER_USE',
    ).length,
    pronunciation: 'unmeasured' as const,
    confidence: s.evidence.length < 8 ? '初步观察' : '持续校准',
  };
}
