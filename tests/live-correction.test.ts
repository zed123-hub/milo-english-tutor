import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoachService } from '../local/service';
import { SqliteRepository } from '../local/repository';
import { SettingsStore, defaultSettings } from '../local/settings';
import { exportBackup, parseBackup } from '../lib/coach/backup';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'milo-live-correction-'));
  const repo = new SqliteRepository(':memory:');
  const settings = new SettingsStore(directory);
  settings.save({
    ...defaultSettings,
    voiceMode: 'realtime',
    realtimeProvider: 'glm',
    realtimeModel: 'glm-realtime-air',
    realtimeKey: 'realtime-fixture-key',
    evaluatorKey: 'evaluation-fixture-key',
  });
  const service = new CoachService(repo, settings);
  t.after(() => {
    service.close();
    repo.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const command = (action: string, body: Record<string, unknown> = {}) => {
    const snapshot = repo.read();
    return service.command(action, {
      revision: snapshot.revision,
      epoch: snapshot.epoch,
      sessionId: snapshot.data.activeSessionId,
      commandId: crypto.randomUUID(),
      ...body,
    });
  };
  return { repo, service, command };
}

function modelResponse(value: unknown) {
  return new Response(
    JSON.stringify({
      choices: [
        { finish_reason: 'stop', message: { content: JSON.stringify(value) } },
      ],
    }),
  );
}

void test('live correction: one compact parallel check adds a visual suggestion without blocking speech or assessment', async (t) => {
  const { repo, service, command } = fixture(t);
  let complete!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => (complete = resolve));
  const previousFetch = globalThis.fetch;
  const requests: {
    messages: { content: string }[];
    max_tokens?: number;
  }[] = [];
  globalThis.fetch = async (_url, options) => {
    const body = options?.body;
    if (typeof body !== 'string') throw Error('Expected JSON request');
    requests.push(JSON.parse(body));
    return pending;
  };
  t.after(() => (globalThis.fetch = previousFetch));
  await command('start');
  const result = await command('turn', {
    role: 'user',
    source: 'realtime',
    text: 'I am agree with that idea.',
    hint: 0,
  });
  assert.ok(result.snapshot);
  assert.equal(repo.read().data.turns.at(-1)?.assessed, false);
  assert.equal(repo.read().data.turns.at(-1)?.liveCorrection, undefined);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(JSON.stringify(request).length < 1300);
  assert.equal(request.max_tokens, 256);
  assert.doesNotMatch(JSON.stringify(request), /fixture-key/);
  complete(
    modelResponse({
      original: 'I am agree',
      better: 'I agree',
      note: 'agree 是动词，不需要 am。',
    }),
  );
  await service.waitForLiveChecks();
  const turn = repo.read().data.turns.at(-1)!;
  assert.equal(turn.liveCorrection?.original, 'I am agree');
  assert.equal(turn.liveCorrection?.better, 'I agree');
  assert.equal(turn.assessed, false);
  const backup = await exportBackup(repo.read());
  const restored = await parseBackup(JSON.stringify(backup));
  assert.deepEqual(
    restored.data.turns.at(-1)?.liveCorrection,
    turn.liveCorrection,
  );
});

void test('live correction: invalid quotes and short utterances do not create cards', async (t) => {
  const { repo, service, command } = fixture(t);
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return modelResponse({
      original: 'not in the utterance',
      better: 'I agree',
      note: 'Do not invent learner words.',
    });
  };
  t.after(() => (globalThis.fetch = previousFetch));
  await command('start');
  await command('turn', {
    role: 'user',
    source: 'realtime',
    text: 'Yes.',
    hint: 0,
  });
  await command('turn', {
    role: 'user',
    source: 'realtime',
    text: 'I am agree with that.',
    hint: 0,
  });
  await service.waitForLiveChecks();
  assert.equal(calls, 1);
  assert.ok(repo.read().data.turns.every((turn) => !turn.liveCorrection));
});

void test('live correction: a result arriving after the conversation ends is discarded', async (t) => {
  const { repo, service, command } = fixture(t);
  let complete!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => (complete = resolve));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => pending;
  t.after(() => (globalThis.fetch = previousFetch));
  await command('start');
  await command('turn', {
    role: 'user',
    source: 'realtime',
    text: 'I am agree with that idea.',
    hint: 0,
  });
  await command('end');
  complete(
    modelResponse({
      original: 'I am agree',
      better: 'I agree',
      note: 'agree 是动词。',
    }),
  );
  await service.waitForLiveChecks();
  assert.equal(repo.read().data.activeSessionId, null);
  assert.equal(repo.read().data.turns[0].liveCorrection, undefined);
});
