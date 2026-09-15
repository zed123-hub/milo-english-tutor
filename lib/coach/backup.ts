import { initialDifficulty, scenes, type Difficulty } from './learning-engine';
import {
  containsPhrase,
  normalized,
  freshData,
  type LearningData,
  type Snapshot,
} from './model';
export const BACKUP_LIMIT = 20 * 1024 * 1024;
type Obj = Record<string, unknown>;
function object(v: unknown): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw Error('备份结构不正确。');
  return v as Obj;
}
function text(v: unknown, max = 6000): string {
  if (typeof v !== 'string' || v.length > max)
    throw Error('备份文字字段不正确。');
  return v;
}
function id(v: unknown) {
  const s = text(v, 160);
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) throw Error('备份标识不正确。');
  return s;
}
function date(v: unknown) {
  const s = text(v, 40);
  if (!/^\d{4}-\d\d-\d\dT/.test(s) || !Number.isFinite(Date.parse(s)))
    throw Error('备份时间不正确。');
  return s;
}
function array(v: unknown, max = 100000): unknown[] {
  if (!Array.isArray(v) || v.length > max)
    throw Error('备份列表不正确或过大。');
  return v;
}
function number(v: unknown, min: number, max: number) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
    throw Error('备份数字不正确。');
  return v;
}
function bool(v: unknown) {
  if (typeof v !== 'boolean') throw Error('备份状态不正确。');
  return v;
}
function one<T extends string>(v: unknown, values: T[]): T {
  if (typeof v !== 'string' || !values.includes(v as T))
    throw Error('备份包含未知类型。');
  return v as T;
}
function keys(o: Obj, allowed: string[]) {
  if (Object.keys(o).some((k) => !allowed.includes(k)))
    throw Error('备份含有不支持的字段。');
}
function unique(values: string[]) {
  if (new Set(values).size !== values.length) throw Error('备份中有重复记录。');
}
function validateObservation(
  value: unknown,
  source: string,
): NonNullable<LearningData['turns'][number]['observation']> {
  const o = object(value);
  keys(o, ['outcome', 'context', 'comprehension', 'correction', 'observedAt']);
  let correction;
  if (o.correction !== undefined) {
    const c = object(o.correction);
    keys(c, ['original', 'better', 'note']);
    correction = {
      original: text(c.original, 1000),
      better: text(c.better, 1000),
      note: text(c.note, 500),
    };
    if (!correction.original.trim() || !source.includes(correction.original))
      throw Error('纠错缺少学生原话。');
  }
  return {
    ...(o.observedAt === undefined ? {} : { observedAt: date(o.observedAt) }),
    outcome: one(o.outcome, ['success', 'uncertain', 'needs_support']),
    context: one(
      o.context,
      scenes.map((s) => s.id),
    ),
    comprehension: one(o.comprehension, [
      'clear',
      'uncertain',
      'needs_support',
    ]),
    ...(correction ? { correction } : {}),
  };
}
function validateDifficulty(value: unknown): Difficulty {
  const o = object(value);
  keys(o, [
    'vocabulary',
    'grammar',
    'sentenceWords',
    'speakingRate',
    'answerWords',
    'topicDepth',
    'scaffolding',
    'independence',
    'steps',
    'updatedAt',
    'reason',
    'evidenceTurnIds',
  ]);
  const d = {
    vocabulary: number(o.vocabulary, 0, 4),
    grammar: number(o.grammar, 0, 4),
    sentenceWords: number(o.sentenceWords, 4, 24),
    speakingRate: number(o.speakingRate, 0.7, 1),
    answerWords: number(o.answerWords, 1, 18),
    topicDepth: number(o.topicDepth, 0, 4),
    scaffolding: number(o.scaffolding, 0, 3),
    independence: number(o.independence, 0, 3),
    steps: number(o.steps, 0, 1000000),
    updatedAt: date(o.updatedAt),
    reason: text(o.reason, 1000),
    evidenceTurnIds: array(o.evidenceTurnIds, 100).map(id),
  };
  for (const k of [
    'vocabulary',
    'grammar',
    'sentenceWords',
    'answerWords',
    'topicDepth',
    'scaffolding',
    'independence',
    'steps',
  ] as const)
    if (!Number.isInteger(d[k])) throw Error('难度数值不正确。');
  unique(d.evidenceTurnIds);
  return d;
}
export function validateData(value: unknown): LearningData {
  const d = object(value);
  keys(d, [
    'schemaVersion',
    'analyses',
    'createdAt',
    'facts',
    'turns',
    'evidence',
    'sessions',
    'memories',
    'plan',
    'activeSessionId',
    'hint',
    'legacy',
  ]);
  if (![3, 4].includes(Number(d.schemaVersion)))
    throw Error('暂不支持这个数据版本，请使用兼容版本的软件。');
  const sessions = array(d.sessions, 20000).map((v) => {
    const o = object(v);
    keys(o, ['id', 'startedAt', 'endedAt', 'summary', 'challenge']);
    return {
      id: id(o.id),
      startedAt: date(o.startedAt),
      endedAt: o.endedAt === null ? null : date(o.endedAt),
      summary: text(o.summary, 4000),
      ...(o.challenge === undefined
        ? {}
        : { challenge: one(o.challenge, ['harder', 'easier', 'slower']) }),
    };
  });
  unique(sessions.map((s) => s.id));
  const sessionIds = new Set(sessions.map((s) => s.id));
  const turns = array(d.turns).map((v) => {
    const o = object(v);
    keys(o, [
      'id',
      'sessionId',
      'role',
      'text',
      'at',
      'source',
      'seconds',
      'hint',
      'played',
      'assessed',
      'observation',
    ]);
    const turn = {
      id: id(o.id),
      sessionId: id(o.sessionId),
      role: one(o.role, ['user', 'assistant']),
      text: text(o.text),
      at: date(o.at),
      source: one(o.source, [
        'realtime',
        'asr',
        'browser-speech',
        'legacy-text',
      ]),
      seconds: number(o.seconds, 0, 3600),
      hint: number(o.hint, 0, 3),
      played: bool(o.played),
      assessed: bool(o.assessed),
      ...(o.observation === undefined
        ? {}
        : { observation: validateObservation(o.observation, text(o.text)) }),
    };
    if (
      !Number.isInteger(turn.hint) ||
      !sessionIds.has(turn.sessionId) ||
      (turn.observation &&
        (turn.role !== 'user' ||
          !turn.assessed ||
          turn.source === 'legacy-text'))
    )
      throw Error('备份对话关联不正确。');
    return turn;
  });
  unique(turns.map((t) => t.id));
  const byTurn = new Map(turns.map((t) => [t.id, t]));
  const facts = array(d.facts, 10000).map((v) => {
    const o = object(v);
    keys(o, ['id', 'kind', 'text', 'quote', 'turnId', 'at']);
    const f = {
      id: id(o.id),
      kind: one(o.kind, ['name', 'interest', 'goal', 'difficulty', 'context']),
      text: text(o.text, 500),
      quote: text(o.quote, 1000),
      turnId: id(o.turnId),
      at: date(o.at),
    };
    const turn = byTurn.get(f.turnId);
    if (
      !turn ||
      turn.role !== 'user' ||
      !turn.text.includes(f.quote) ||
      !f.quote.trim()
    )
      throw Error('画像缺少对应的学生原话。');
    return f;
  });
  unique(facts.map((f) => f.id));
  const evidence = array(d.evidence).map((v) => {
    const o = object(v);
    keys(o, ['id', 'turnId', 'phrase', 'meaning', 'context', 'outcome', 'at']);
    const e = {
      id: id(o.id),
      turnId: id(o.turnId),
      phrase: text(o.phrase, 120),
      meaning: text(o.meaning, 200),
      context: text(o.context, 200),
      outcome: one(o.outcome, ['independent', 'assisted', 'exposed']),
      at: date(o.at),
    };
    const turn = byTurn.get(e.turnId);
    if (
      !turn ||
      (e.outcome === 'exposed'
        ? turn.role !== 'assistant' || !turn.played
        : turn.role !== 'user') ||
      turn.source === 'legacy-text' ||
      !/[a-z]{2}/i.test(e.phrase) ||
      !containsPhrase(turn.text, e.phrase) ||
      e.at !== turn.at ||
      (e.outcome === 'independent' && turn.hint > 0)
    )
      throw Error('学习证据缺少对应的真实语音尝试。');
    return e;
  });
  unique(evidence.map((e) => e.id));
  unique(evidence.map((e) => e.turnId + ':' + normalized(e.phrase)));
  const p = object(d.plan);
  keys(p, [
    'difficulty',
    'sourceSessionId',
    'focus',
    'reason',
    'nextOpening',
    'review',
    'suggestedMinutes',
    'updatedAt',
  ]);
  const plan = {
    focus: text(p.focus, 500),
    reason: text(p.reason, 1000),
    nextOpening: text(p.nextOpening, 1000),
    review: array(p.review, 30).map((v) => text(v, 120)),
    suggestedMinutes: number(p.suggestedMinutes, 1, 60),
    updatedAt: date(p.updatedAt),
    difficulty:
      d.schemaVersion === 3
        ? initialDifficulty(date(d.createdAt))
        : validateDifficulty(p.difficulty),
    ...(p.sourceSessionId === undefined
      ? {}
      : { sourceSessionId: id(p.sourceSessionId) }),
  };
  if (plan.sourceSessionId && !sessionIds.has(plan.sourceSessionId))
    throw Error('教学安排关联不正确。');
  for (const turnId of plan.difficulty.evidenceTurnIds) {
    const t = byTurn.get(turnId);
    if (!t || t.role !== 'user' || !t.observation)
      throw Error('难度依据不存在。');
  }
  const analyses: LearningData['analyses'] =
    d.schemaVersion === 3
      ? []
      : array(d.analyses, 20000).map((v) => {
          const o = object(v);
          keys(o, [
            'id',
            'sessionId',
            'turnIds',
            'cursor',
            'status',
            'attempts',
            'error',
            'updatedAt',
          ]);
          const j = {
            id: id(o.id),
            sessionId: id(o.sessionId),
            turnIds: array(o.turnIds).map(id),
            cursor: number(o.cursor, 0, 100000),
            status: one(o.status, [
              'queued',
              'running',
              'waiting',
              'failed',
              'complete',
            ]),
            attempts: number(o.attempts, 0, 1000000),
            error:
              o.error === null
                ? null
                : one(o.error, [
                    'KEY_REQUIRED',
                    'MODEL_AUTH',
                    'MODEL_LIMIT',
                    'MODEL_FAILED',
                    'MODEL_OUTPUT',
                  ]),
            updatedAt: date(o.updatedAt),
          };
          unique(j.turnIds);
          const session = sessions.find((s) => s.id === j.sessionId);
          if (
            !session?.endedAt ||
            !Number.isInteger(j.cursor) ||
            !Number.isInteger(j.attempts) ||
            j.cursor > j.turnIds.length ||
            j.turnIds.some((turnId) => {
              const t = byTurn.get(turnId);
              return (
                !t ||
                t.sessionId !== j.sessionId ||
                t.role !== 'user' ||
                t.source === 'legacy-text'
              );
            }) ||
            j.turnIds
              .slice(0, j.cursor)
              .some((turnId) => !byTurn.get(turnId)?.assessed) ||
            (j.status === 'complete' && j.cursor !== j.turnIds.length)
          )
            throw Error('分析进度关联不正确。');
          return j;
        });
  unique(analyses.map((j) => j.id));
  unique(analyses.map((j) => j.sessionId));
  const memories = array(d.memories, 20000).map((v) => {
    const o = object(v);
    keys(o, ['sessionId', 'text', 'at']);
    const m = {
      sessionId: id(o.sessionId),
      text: text(o.text, 4000),
      at: date(o.at),
    };
    if (!sessionIds.has(m.sessionId)) throw Error('记忆关联的对话不存在。');
    return m;
  });
  const activeSessionId =
    d.activeSessionId === null ? null : id(d.activeSessionId);
  if (activeSessionId && !sessionIds.has(activeSessionId))
    throw Error('当前对话不存在。');
  let legacy: LearningData['legacy'] = null;
  if (d.legacy !== null) {
    const o = object(d.legacy);
    keys(o, ['importedAt', 'state']);
    const old = object(o.state);
    if (old.version !== 2) throw Error('旧版数据不正确。');
    legacy = {
      importedAt: date(o.importedAt),
      state: JSON.parse(JSON.stringify(old)),
    };
  }
  if (!Number.isInteger(d.hint)) throw Error('备份帮助程度不正确。');
  return {
    schemaVersion: 4,
    analyses,
    createdAt: date(d.createdAt),
    facts,
    turns,
    evidence,
    sessions,
    memories,
    plan,
    activeSessionId,
    hint: number(d.hint, 0, 3),
    legacy,
  };
}
function rejectSecrets(value: unknown, depth = 0) {
  if (depth > 25) throw Error('备份嵌套过深。');
  if (value && typeof value === 'object')
    for (const [key, v] of Object.entries(value)) {
      if (
        /^(?:__proto__|constructor|prototype|(?:api|teacher|voice|analysis|evaluator|realtime)[_-]?key|authorization|access[_-]?token|refresh[_-]?token|secret|password|keys)$/i.test(
          key,
        )
      )
        throw Error('备份包含密钥或危险字段，已拒绝导入。');
      rejectSecrets(v, depth + 1);
    }
}
async function digest(data: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
export async function exportBackup(snapshot: Snapshot) {
  validateData(snapshot.data);
  const pack = {
    format: 'milo-learning-backup',
    formatVersion: 1,
    dataSchemaVersion: 4,
    exportedAt: new Date().toISOString(),
    checksum: await digest(snapshot.data),
    data: snapshot.data,
  };
  if (new TextEncoder().encode(JSON.stringify(pack)).byteLength > BACKUP_LIMIT)
    throw Error('BACKUP_TOO_LARGE');
  return pack;
}
export async function parseBackup(
  raw: string,
): Promise<{ data: LearningData; legacy: boolean }> {
  if (new TextEncoder().encode(raw).byteLength > BACKUP_LIMIT)
    throw Error('备份不能超过 20 MB。');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw Error('文件不是有效的 JSON 备份。');
  }
  rejectSecrets(value);
  const o = object(value);
  if (o.format === 'milo-learning-backup') {
    keys(o, [
      'format',
      'formatVersion',
      'dataSchemaVersion',
      'exportedAt',
      'checksum',
      'data',
    ]);
    if (
      o.formatVersion !== 1 ||
      ![3, 4].includes(Number(o.dataSchemaVersion)) ||
      object(o.data).schemaVersion !== o.dataSchemaVersion
    )
      throw Error('备份来自不兼容版本。');
    date(o.exportedAt);
    if ((await digest(o.data)) !== o.checksum)
      throw Error('备份校验失败，文件可能已损坏。');
    return { data: validateData(o.data), legacy: false };
  }
  const previous = object(o.state ?? o);
  if (previous.version !== 2) throw Error('这不是 Milo 学习备份。');
  // Legacy content is preserved as historical data, never promoted into new speech evidence.
  if (!Array.isArray(previous.evidence) || !previous.profile || !previous.items)
    throw Error('旧版学情不完整。');
  const data = freshData();
  data.legacy = { importedAt: new Date().toISOString(), state: previous };
  data.plan.reason = '已带入旧版实际保存的学情。先通过交流重新了解听说表现。';
  return { data, legacy: true };
}
