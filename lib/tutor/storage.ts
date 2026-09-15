import { env } from 'cloudflare:workers';
import { emptyStudent, type StudentState } from './domain';
export type Snapshot = { revision: number; state: StudentState };
export function authenticatedUser(req: Request) {
  const id = req.headers.get('oai-authenticated-user-id');
  if (!id || id.length > 300) throw new Error('AUTH_REQUIRED');
  return id;
}
function database() {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new Error('DATABASE_UNAVAILABLE');
  return binding;
}
export async function loadStudent(user: string): Promise<Snapshot> {
  const db = database();
  const now = new Date().toISOString();
  await db
    .prepare(
      'INSERT INTO tutor_students (user_id,revision,state_json,updated_at) VALUES (?,0,?,?) ON CONFLICT(user_id) DO NOTHING',
    )
    .bind(user, JSON.stringify(emptyStudent()), now)
    .run();
  const row = await db
    .prepare('SELECT revision,state_json FROM tutor_students WHERE user_id=?')
    .bind(user)
    .first<{ revision: number; state_json: string }>();
  if (!row) throw Error('DATABASE_UNAVAILABLE');
  const state = JSON.parse(row.state_json) as StudentState;
  if (state.version !== 2) throw Error('STATE_VERSION');
  return { revision: row.revision, state };
}
export async function hasEvent(user: string, id: string) {
  return Boolean(
    await database()
      .prepare(
        'SELECT event_id FROM tutor_events WHERE user_id=? AND event_id=?',
      )
      .bind(user, id)
      .first(),
  );
}
export async function saveStudent(
  user: string,
  previous: Snapshot,
  state: StudentState,
  event: { id: string; kind: string; payload: unknown; sessionId?: string },
): Promise<Snapshot> {
  const now = new Date().toISOString();
  const db = database();
  // Both statements run in one transaction. Conditional insertion and revision matching prevent lost updates and duplicate submissions.
  const result = await db.batch([
    db
      .prepare(
        'INSERT INTO tutor_events (user_id,event_id,session_id,kind,source_revision,payload_json,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM tutor_students WHERE user_id=? AND revision=?) ON CONFLICT(user_id,event_id) DO NOTHING',
      )
      .bind(
        user,
        event.id,
        event.sessionId ?? null,
        event.kind,
        previous.revision,
        JSON.stringify(event.payload),
        now,
        user,
        previous.revision,
      ),
    db
      .prepare(
        'UPDATE tutor_students SET revision=revision+1,state_json=?,updated_at=? WHERE user_id=? AND revision=? AND EXISTS (SELECT 1 FROM tutor_events WHERE user_id=? AND event_id=? AND source_revision=?)',
      )
      .bind(
        JSON.stringify(state),
        now,
        user,
        previous.revision,
        user,
        event.id,
        previous.revision,
      ),
  ]);
  if (result[1].meta.changes !== 1) throw Error('CONFLICT');
  return { revision: previous.revision + 1, state };
}
