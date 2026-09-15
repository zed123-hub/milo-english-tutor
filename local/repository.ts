import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  freshData,
  upgradeData,
  type LearningData,
  type LearningRepository,
  type Snapshot,
} from '../lib/coach/model';
export class SqliteRepository implements LearningRepository {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:')
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS learning (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,epoch TEXT NOT NULL,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS recovery (id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL,at TEXT NOT NULL);',
    );
    this.db
      .prepare('INSERT OR IGNORE INTO learning VALUES (1,0,?,?)')
      .run(crypto.randomUUID(), JSON.stringify(freshData()));
    if (path !== ':memory:') chmodSync(path, 0o600);
  }
  read(): Snapshot {
    const row = this.db
      .prepare('SELECT revision,epoch,data FROM learning WHERE id=1')
      .get() as { revision: number; epoch: string; data: string };
    return {
      revision: row.revision,
      epoch: row.epoch,
      data: upgradeData(JSON.parse(row.data)),
    };
  }
  seen(id: string) {
    return Boolean(
      this.db.prepare('SELECT id FROM commands WHERE id=?').get(id),
    );
  }
  commit(previous: Snapshot, data: LearningData, commandId: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.seen(commandId)) {
        this.db.exec('ROLLBACK');
        return this.read();
      }
      const result = this.db
        .prepare(
          'UPDATE learning SET revision=revision+1,data=? WHERE id=1 AND revision=? AND epoch=?',
        )
        .run(JSON.stringify(data), previous.revision, previous.epoch);
      if (Number(result.changes) !== 1) throw Error('CONFLICT');
      this.db.prepare('INSERT INTO commands(id) VALUES (?)').run(commandId);
      this.db.exec('COMMIT');
      return this.read();
    } catch (e) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw e;
    }
  }
  replace(previous: Snapshot, data: LearningData) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.read();
      if (
        current.revision !== previous.revision ||
        current.epoch !== previous.epoch
      )
        throw Error('CONFLICT');
      this.db
        .prepare(
          'INSERT INTO recovery VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,at=excluded.at',
        )
        .run(JSON.stringify(current.data), new Date().toISOString());
      this.db
        .prepare(
          'UPDATE learning SET revision=revision+1,epoch=?,data=? WHERE id=1',
        )
        .run(crypto.randomUUID(), JSON.stringify(data));
      this.db.exec('DELETE FROM commands');
      this.db.exec('COMMIT');
      return this.read();
    } catch (e) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw e;
    }
  }
  recovery() {
    const row = this.db
      .prepare('SELECT data FROM recovery WHERE id=1')
      .get() as { data: string } | undefined;
    return row ? upgradeData(JSON.parse(row.data)) : null;
  }
  close() {
    this.db.close();
  }
}
