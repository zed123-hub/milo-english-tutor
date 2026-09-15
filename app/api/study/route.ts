import {
  authenticatedUser,
  loadStudent,
  saveStudent,
  hasEvent,
} from '@/lib/tutor/storage';
import { response, readBody, safeError } from '@/lib/tutor/http';
import {
  makePlan,
  startSession,
  currentTask,
  revealHint,
  reduceEvidence,
  continueSession,
  localDay,
  type StudentState,
  type Evidence,
  type Learner,
  type InputMode,
} from '@/lib/tutor/domain';
import { evaluateAnswer, validateModelConfig } from '@/lib/tutor/evaluator';
export async function GET(req: Request) {
  try {
    return response(await loadStudent(authenticatedUser(req)));
  } catch (e) {
    return safeError(e);
  }
}
export async function POST(req: Request) {
  try {
    const user = authenticatedUser(req);
    const body = await readBody(req);
    const previous = await loadStudent(user);
    let state: StudentState = previous.state;
    if (
      typeof body.eventId !== 'string' ||
      !/^[-a-zA-Z0-9_]{8,100}$/.test(body.eventId)
    )
      throw Error('INVALID_BODY');
    if (await hasEvent(user, body.eventId))
      return response(await loadStudent(user));
    if (body.revision !== previous.revision) throw Error('CONFLICT');
    let eventPayload: unknown = {};
    const at = new Date().toISOString();
    if (body.action === 'profile') {
      const p = body.profile as Learner;
      if (
        !p ||
        typeof p.name !== 'string' ||
        !['life', 'work', 'travel'].includes(p.goal) ||
        !['beginner', 'learned', 'unsure'].includes(p.background) ||
        ![5, 10, 15].includes(p.minutes) ||
        !['low', 'normal'].includes(p.energy)
      )
        throw Error('INVALID_BODY');
      state = {
        ...state,
        configured: true,
        profile: {
          name: p.name.trim().slice(0, 40),
          goal: p.goal,
          background: p.background,
          minutes: p.minutes,
          energy: p.energy,
        },
      };
      eventPayload = { profile: state.profile };
    } else if (body.action === 'start') {
      if (!state.configured) throw Error('INVALID_ACTION');
      if (!state.session || state.session.status === 'complete') {
        const plan = makePlan(
          state,
          at,
          body.eventId,
          body.mode === 'morning' ? 'morning' : 'practice',
        );
        state = { ...state, session: startSession(plan) };
        eventPayload = { plan };
      }
    } else {
      if (!state.session || state.session.id !== body.sessionId)
        throw Error('INVALID_ACTION');
      if (
        body.taskId !== currentTask(state).id ||
        body.taskIndex !== state.session.index ||
        body.attempt !== state.session.retries
      )
        throw Error('INVALID_ACTION');
      if (body.action === 'hint') {
        if (state.session.status !== 'active') throw Error('INVALID_ACTION');
        const target =
          body.level === undefined ? state.session.hintLevel + 1 : body.level;
        if (typeof target !== 'number' || ![1, 2, 3, 4].includes(target))
          throw Error('INVALID_BODY');
        while (state.session!.hintLevel < Math.min(target, 3))
          state = revealHint(state);
      } else if (body.action === 'reveal') {
        if (state.session.status !== 'active') throw Error('INVALID_ACTION');
        state = {
          ...state,
          session: { ...state.session, sourceExposed: true },
        };
      } else if (body.action === 'played') {
        if (state.session.status !== 'active') throw Error('INVALID_ACTION');
        state = { ...state, session: { ...state.session, audioPlayed: true } };
      } else if (body.action === 'continue') state = continueSession(state);
      else if (body.action === 'submit') {
        if (
          state.session.status !== 'active' ||
          typeof body.transcript !== 'string' ||
          !body.transcript.trim() ||
          body.transcript.length > 6000 ||
          !['typed', 'browser-speech', 'realtime'].includes(
            String(body.inputMode),
          )
        )
          throw Error('INVALID_BODY');
        const task = currentTask(state);
        const result = await evaluateAnswer(
          task,
          body.transcript,
          body.apiKey ? validateModelConfig(body.config) : undefined,
          typeof body.apiKey === 'string' ? body.apiKey : undefined,
        );
        let hintLevel = state.session.hintLevel;
        let sourceExposed = state.session.sourceExposed;
        // Realtime tutor reports any assistance in its own transcript; explicit client hint events remain authoritative and monotonic.
        if (
          typeof body.assistantTranscript === 'string' &&
          /示范|跟我说|repeat after me|you can say/i.test(
            body.assistantTranscript,
          )
        ) {
          hintLevel = Math.max(3, hintLevel);
          sourceExposed = true;
        }
        const inputMode = body.inputMode as InputMode;
        const event: Evidence = {
          id: body.eventId,
          sessionId: state.session.id,
          taskId: task.id,
          at,
          studyDay: localDay(at),
          inputMode,
          transcript: body.transcript.trim(),
          hintLevel,
          sourceExposed,
          audioPlayed: state.session.audioPlayed,
          retry: state.session.retries > 0,
          ...result,
          ...(inputMode !== 'typed' &&
          typeof body.latencyMs === 'number' &&
          body.latencyMs >= 0 &&
          body.latencyMs <= 120000
            ? { latencyMs: body.latencyMs }
            : {}),
          ...(inputMode !== 'typed' &&
          typeof body.durationMs === 'number' &&
          body.durationMs > 0 &&
          body.durationMs < 300000
            ? { durationMs: body.durationMs }
            : {}),
        };
        state = reduceEvidence(state, event);
        eventPayload = event;
      } else throw Error('INVALID_ACTION');
    }
    const snapshot = await saveStudent(user, previous, state, {
      id: body.eventId,
      kind: String(body.action),
      payload: eventPayload,
      sessionId: state.session?.id,
    });
    return response(snapshot);
  } catch (error) {
    return safeError(error);
  }
}
