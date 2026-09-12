import { describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';

import { createSessionControlPlaneMirror } from '../src/session-control-plane';
import type { MessageQueueItem } from '../src/schema';
import type { SessionId } from '../src/ids';

/**
 * loro-mirror stamps a NON-enumerable `$cid` on every nested container it
 * materializes, and queue edits match on it. `structuredClone` drops
 * non-enumerable properties, so a clone-based updater makes every item look new
 * — removals and reorders silently stop matching. The renderer's raw Mirror is
 * covered by `packages/components/tests/control-plane-mirror.test.ts`; this
 * covers the shared wrapper the CLI composes.
 */
const sessionId = 'session-control-plane-mirror' as SessionId;

const createMirror = () =>
  createSessionControlPlaneMirror({
    doc: new LoroDoc(),
    initialState: { session: { id: sessionId } },
  });

const queueItem = (task: string): MessageQueueItem =>
  ({
    task,
    userId: 'user-1',
    timestamp: '2026-09-09',
    acpSessionConfig: { prompt: task, cliType: 'builtin', agentType: 'codex' },
  }) as MessageQueueItem;

describe('createSessionControlPlaneMirror', () => {
  it('keeps the non-enumerable $cid queue identity across a function update', () => {
    const mirror = createMirror();
    mirror.setState((draft) => {
      draft.mq = [queueItem('first'), queueItem('second')];
    });

    const items = mirror.getState().mq ?? [];
    expect(items).toHaveLength(2);
    expect(items[0]?.$cid).toBeTypeOf('string');
    expect(items[1]?.$cid).toBeTypeOf('string');
    expect(items[0]?.$cid).not.toBe(items[1]?.$cid);

    const removedCid = items[0]!.$cid;
    mirror.setState((draft) => {
      draft.mq = (draft.mq ?? []).filter((item) => item.$cid !== removedCid);
    });

    const remaining = mirror.getState().mq ?? [];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.task).toBe('second');
    mirror.dispose();
  });
});
