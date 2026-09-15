import test from 'node:test';
import assert from 'node:assert/strict';
import { QwenLifecycle } from '../lib/coach/qwen-lifecycle';
import { GLMLifecycle } from '../lib/coach/glm-lifecycle';
import { realtimeConfig } from '../lib/coach/realtime-providers';

function fixture(provider: 'qwen' | 'glm', opening = true) {
  const sent: Record<string, unknown>[] = [];
  const config = realtimeConfig({
    realtimeProvider: provider,
    realtimeModel:
      provider === 'qwen' ? 'qwen3.5-omni-flash-realtime' : 'glm-realtime-air',
  });
  const send = (event: unknown) => sent.push(event as Record<string, unknown>);
  const life =
    provider === 'qwen'
      ? new QwenLifecycle(config, 'A', [], send, opening)
      : new GLMLifecycle(config, 'A', [], send, opening);
  if (life instanceof QwenLifecycle) life.start();
  else life.accept({ type: 'session.created' });
  const ack = () => life.accept({ type: 'session.updated' });
  const created = (id: string) =>
    life.accept({ type: 'response.created', response_id: id });
  const done = (id: string) =>
    life.accept({
      type: 'response.done',
      response: { id, status: 'completed' },
    });
  const updates = () => sent.filter((event) => event.type === 'session.update');
  return { life, sent, ack, created, done, updates };
}

for (const provider of ['qwen', 'glm'] as const) {
  void test(`${provider} refresh: unchanged instructions do not resubmit configuration`, () => {
    const { life, ack, created, done, updates } = fixture(provider);
    life.policy('A');
    ack();
    created('opening');
    life.policy('A');
    done('opening');
    life.policy('A');
    assert.equal(updates().length, 1);
  });

  void test(`${provider} refresh: newest A replaces queued B while active without sending either`, () => {
    const { life, ack, created, done, updates } = fixture(provider);
    ack();
    created('opening');
    life.policy('B');
    life.policy('A');
    done('opening');
    assert.equal(updates().length, 1);
  });

  void test(`${provider} refresh: A to B to A during ACK retains the last A exactly once`, () => {
    const { life, ack, created, done, updates } = fixture(provider);
    ack();
    created('opening');
    done('opening');
    life.policy('B');
    life.policy('A');
    life.policy('A');
    assert.equal(updates().length, 2);
    ack();
    assert.deepEqual(
      updates().map(
        (event) => (event.session as { instructions: string }).instructions,
      ),
      ['A', 'B', 'A'],
    );
    life.policy('A');
    ack();
    assert.equal(updates().length, 3);
  });

  void test(`${provider} refresh: rotation suppresses only the opening and permits a later reply`, () => {
    const { life, sent, ack } = fixture(provider, false);
    ack();
    assert.equal(
      sent.filter((event) => event.type === 'response.create').length,
      0,
    );
    if (provider === 'glm') {
      const config = sent[0].session as {
        beta_fields: { greeting_config: { enable: boolean } };
      };
      assert.equal(config.beta_fields.greeting_config.enable, false);
    }
    life.requestResponse('tool');
    assert.equal(
      sent.filter((event) => event.type === 'response.create').length,
      1,
    );
  });
}
