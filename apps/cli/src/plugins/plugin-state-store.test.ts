import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PluginStateStore } from './plugin-state-store';

const event = (eventId: string) => ({
  type: 'event' as const,
  eventType: 'session.created',
  eventId,
  payload: null,
});

it('keeps replay events until every cursor consumed them and forgets a disabled plugin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lody-plugin-state-'));
  const store = new PluginStateStore(root);
  try {
    store.subscribe('p', 'session.created');
    store.record(event('a'));
    store.record(event('b'));
    const first = store.next('p', ['session.created']);
    if (!first) throw Error('Missing first event');
    expect(first.frame.eventId).toBe('a');
    store.ack('p', 'session.created', first.seq);
    const second = store.next('p', ['session.created']);
    if (!second) throw Error('Missing second event');
    expect(second.frame.eventId).toBe('b');
    store.ack('p', 'session.created', second.seq);
    expect(store.next('p', ['session.created'])).toBeUndefined();
    store.unsubscribe('p');
    store.record(event('c'));
    store.subscribe('p', 'session.created');
    expect(store.next('p', ['session.created'])).toBeUndefined();
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('bounds a replay cursor that stopped draining instead of growing the journal forever', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lody-plugin-state-'));
  const store = new PluginStateStore(root);
  try {
    store.subscribe('p', 'session.created');
    for (let i = 0; i < 4097; i++) store.record(event(String(i)));
    const next = store.next('p', ['session.created']);
    if (!next) throw Error('Missing retained event');
    expect(next.frame.eventId).toBe('1');
    expect(store.next('p', ['session.created'])?.seq).toBe(next.seq);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
