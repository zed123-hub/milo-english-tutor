import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
} from 'drizzle-orm/sqlite-core';
export const students = sqliteTable('tutor_students', {
  userId: text('user_id').primaryKey(),
  revision: integer('revision').notNull().default(0),
  stateJson: text('state_json').notNull(),
  updatedAt: text('updated_at').notNull(),
});
export const events = sqliteTable(
  'tutor_events',
  {
    userId: text('user_id').notNull(),
    eventId: text('event_id').notNull(),
    sessionId: text('session_id'),
    kind: text('kind').notNull(),
    sourceRevision: integer('source_revision').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.eventId] }),
    index('idx_tutor_events_user_session').on(t.userId, t.sessionId),
  ],
);
