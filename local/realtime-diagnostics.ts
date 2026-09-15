import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  safeRealtimeDiagnostic,
  type RealtimeDiagnostic,
} from '../lib/coach/realtime-diagnostics';

/** Latest connection per provider, separate from learning records and migration backups. */
export class RealtimeDiagnosticStore {
  private latest = new Map<string, RealtimeDiagnostic>();
  constructor(private directory: string) {}
  save(value: unknown) {
    const report = safeRealtimeDiagnostic(value);
    const previous = this.latest.get(report.provider);
    if (previous && previous.startedAt > report.startedAt) return;
    if (
      previous?.startedAt === report.startedAt &&
      previous.closeCategory &&
      !report.closeCategory
    )
      return;
    this.latest.set(report.provider, report);
    try {
      const dir = join(this.directory, 'realtime-diagnostics');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, report.provider + '.json');
      writeFileSync(path + '.tmp', JSON.stringify(report, null, 2), {
        mode: 0o600,
      });
      renameSync(path + '.tmp', path);
    } catch {
      /* Diagnostic storage must never stop a voice connection. */
    }
  }
  status() {
    return [...this.latest.values()].map(safeRealtimeDiagnostic);
  }
}
