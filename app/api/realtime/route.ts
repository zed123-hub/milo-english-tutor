import { authenticatedUser, loadStudent } from '@/lib/tutor/storage';
import { readBody, response, safeError } from '@/lib/tutor/http';
import { validateKey } from '@/lib/tutor/evaluator';
import { currentTask } from '@/lib/tutor/domain';
import { realtimeConfig } from '@/lib/tutor/realtime-config';
export async function POST(req: Request) {
  try {
    const user = authenticatedUser(req);
    const body = await readBody(req, 128000);
    const { state } = await loadStudent(user);
    if (
      !state.session ||
      state.session.status !== 'active' ||
      state.session.id !== body.sessionId ||
      currentTask(state).id !== body.taskId ||
      state.session.index !== body.taskIndex ||
      state.session.retries !== body.attempt
    )
      throw Error('INVALID_ACTION');
    const key = validateKey(body.apiKey);
    if (
      typeof body.sdp !== 'string' ||
      !body.sdp.startsWith('v=0') ||
      body.sdp.length > 90000
    )
      throw Error('INVALID_BODY');
    const model =
      typeof body.model === 'string' && /^gpt-realtime[-\w.]*$/.test(body.model)
        ? body.model
        : 'gpt-realtime-mini';
    const form = new FormData();
    form.set('sdp', body.sdp);
    form.set('session', JSON.stringify(realtimeConfig(state, model)));
    const upstream = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      throw Error(
        upstream.status === 401 || upstream.status === 403
          ? 'MODEL_AUTH'
          : upstream.status === 429
            ? 'MODEL_LIMIT'
            : 'MODEL_FAILED',
      );
    }
    const sdp = await upstream.text();
    if (!sdp.startsWith('v=0') || sdp.length > 100000)
      throw Error('MODEL_OUTPUT');
    return response({ sdp });
  } catch (e) {
    return safeError(e);
  }
}
