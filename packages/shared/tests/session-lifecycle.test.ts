import { describe, expect, it } from 'vitest';
import type { SessionId } from '../src/ids';
import {
  compareSessionLifecycleOrder,
  encodeSessionLifecycleOperation,
  getEffectiveSessionArchivedState,
  parseSessionLifecycleOperation,
  resolveSessionLifecycleRevision,
  SessionLifecycleOperationConflictError,
  type SessionLifecycleOperation,
} from '../src/session-lifecycle';

const id = (value: string): SessionId => value as SessionId;
const operation = (
  operationId: string,
  counter: string,
  actorId: string,
  targetIds: string[],
  state: 'archived' | 'active' = 'archived',
  subjectId = targetIds[0] ?? ''
): SessionLifecycleOperation => ({
  version: 1,
  operationId,
  subjectId: id(subjectId),
  targetIds: targetIds.map(id),
  state,
  order: { counter, actorId },
});

describe('session lifecycle operation protocol', () => {
  it('parses a complete record and rejects unknown versions and non-canonical counters', () => {
    expect(parseSessionLifecycleOperation(operation('op-1', '12', 'actor-a', ['root']))).toEqual(
      operation('op-1', '12', 'actor-a', ['root'])
    );
    expect(() => parseSessionLifecycleOperation({ ...operation('op-1', '1', 'a', ['root']), version: 2 })).toThrow(
      /Unsupported/
    );
    expect(() => parseSessionLifecycleOperation(operation('op-1', '01', 'a', ['root']))).toThrow(
      /canonical/
    );
    expect(() => parseSessionLifecycleOperation(operation('op-1', '1', 'a', ['child'], 'active', 'root'))).toThrow(
      /include subjectId/
    );
  });

  it('uses numeric counters followed by stable actor and operation byte order', () => {
    expect(compareSessionLifecycleOrder(operation('z', '9', 'z', ['root']), operation('a', '10', 'a', ['root']))).toBeLessThan(0);
    expect(compareSessionLifecycleOrder(operation('z', '10', 'a', ['root']), operation('a', '10', 'b', ['root']))).toBeLessThan(0);
    expect(compareSessionLifecycleOrder(operation('a', '10', 'b', ['root']), operation('z', '10', 'b', ['root']))).toBeLessThan(0);
  });

  it('canonicalizes target order without changing frozen membership', () => {
    expect(JSON.parse(encodeSessionLifecycleOperation(operation('op', '1', 'a', ['root', 'b', 'a']))).targetIds).toEqual([
      'a',
      'b',
      'root',
    ]);
  });
});

describe('session lifecycle resolver', () => {
  it('makes a later root operation win for every frozen target regardless of delivery order', () => {
    const archive = operation('archive', '1', 'a', ['root', 'child']);
    const restore = operation('restore', '2', 'a', ['root', 'child'], 'active');
    const forward = resolveSessionLifecycleRevision([archive, restore]);
    const reverse = resolveSessionLifecycleRevision([restore, archive, restore]);
    expect(forward.revisionId).toBe(reverse.revisionId);
    expect(getEffectiveSessionArchivedState(forward, id('root'))).toBe(false);
    expect(getEffectiveSessionArchivedState(forward, id('child'))).toBe(false);
  });

  it('uses stable ties for concurrent root operations under duplicate reverse delivery', () => {
    const actorA = operation('operation-z', '5', 'actor-a', ['root', 'child']);
    const actorB = operation('operation-a', '5', 'actor-b', ['root', 'child'], 'active');
    const forward = resolveSessionLifecycleRevision([actorA, actorB, actorA]);
    const reverse = resolveSessionLifecycleRevision([actorB, actorA, actorB]);

    expect(reverse.revisionId).toBe(forward.revisionId);
    expect(forward.bySessionId.get(id('root'))?.operationId).toBe('operation-a');
    expect(forward.bySessionId.get(id('child'))?.operationId).toBe('operation-a');
  });

  it('allows a newer singleton Tab operation to override only that Tab', () => {
    const revision = resolveSessionLifecycleRevision([
      operation('root-archive', '5', 'a', ['root', 'tab']),
      operation('tab-restore', '6', 'a', ['tab'], 'active', 'tab'),
    ]);
    expect(getEffectiveSessionArchivedState(revision, id('root'))).toBe(true);
    expect(getEffectiveSessionArchivedState(revision, id('tab'))).toBe(false);
  });

  it('retains the last covering operation when later frozen sets differ', () => {
    const revision = resolveSessionLifecycleRevision([
      operation('first', '1', 'a', ['root', 'old-child']),
      operation('second', '2', 'a', ['root', 'new-child'], 'active'),
    ]);
    expect(getEffectiveSessionArchivedState(revision, id('root'))).toBe(false);
    expect(getEffectiveSessionArchivedState(revision, id('new-child'))).toBe(false);
    expect(getEffectiveSessionArchivedState(revision, id('old-child'))).toBe(true);
  });

  it('filters unknown and deleted targets without reviving them', () => {
    const revision = resolveSessionLifecycleRevision(
      [operation('archive', '1', 'a', ['root', 'missing'])],
      { existingSessionIds: new Set([id('root')]) }
    );
    expect(revision.bySessionId.has(id('root'))).toBe(true);
    expect(revision.bySessionId.has(id('missing'))).toBe(false);
  });

  it('rejects one operation id with different immutable payloads', () => {
    expect(() =>
      resolveSessionLifecycleRevision([
        operation('same', '1', 'a', ['root']),
        operation('same', '1', 'a', ['root'], 'active'),
      ])
    ).toThrow(SessionLifecycleOperationConflictError);
  });
});
