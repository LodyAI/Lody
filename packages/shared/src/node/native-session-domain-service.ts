import type { SessionHistoryInput } from '@lody/shared';
import { randomUUID } from 'node:crypto';
import type { NativeSessionRead, NativeSessionCommand } from '@lody/shared/native-session-domain';
import type { SessionDataChange, SessionDirectoryRow } from '@lody/shared/session-data';
import type { NativeSessionDocumentOwner } from './native-session-document';
import type { SessionBackendForkSnapshot } from './native-session-contract';

/** Registration-private provenance registry. Only writer-captured handles are
 * accepted. The renderer receives opaque tokens, never an authoring document. */
export class NativeSessionSnapshotRegistry {
  private readonly realms = new Map<
    string,
    { windowId: number; registrationId: string; workspaceId: string }
  >();
  bindRealm(
    realm: string,
    binding: { windowId: number; registrationId: string; workspaceId: string }
  ) {
    const previous = this.realms.get(realm);
    if (
      previous &&
      (previous.windowId !== binding.windowId ||
        previous.registrationId !== binding.registrationId ||
        previous.workspaceId !== binding.workspaceId)
    )
      throw new Error('Snapshot realm binding changed');
    this.realms.set(realm, { ...binding });
  }
  retireRegistration(registrationId: string) {
    for (const [realm, binding] of this.realms)
      if (binding.registrationId === registrationId) this.retireRealm(realm);
  }
  retireWindow(windowId: number) {
    for (const [realm, binding] of this.realms)
      if (binding.windowId === windowId) this.retireRealm(realm);
  }
  retireRealm(realm: string) {
    for (const [token, value] of this.values)
      if (value.generation === realm) this.values.delete(token);
    this.realms.delete(realm);
  }
  private readonly values = new Map<
    string,
    { generation: string; snapshot: SessionBackendForkSnapshot }
  >();
  capture(generation: string, snapshot: SessionBackendForkSnapshot, assertCurrent: () => void) {
    if (this.values.size >= 32) throw new Error('Native Session snapshot capacity exceeded');
    const token = randomUUID();
    assertCurrent();
    this.values.set(token, { generation, snapshot });
    return { token, history: snapshot.history };
  }
  get(token: string, generation: string) {
    const value = this.values.get(token);
    if (!value || value.generation !== generation)
      throw new Error('Native Session snapshot is unavailable');
    return value.snapshot;
  }
  release(token: string, generation: string) {
    const value = this.values.get(token);
    if (value && value.generation !== generation)
      throw new Error('Native Session snapshot realm mismatch');
    this.values.delete(token);
  }
  close() {
    this.values.clear();
    this.realms.clear();
  }
}
/** One trusted room grant. The main bridge must recheck window registration,
 * exact selected room and this generation before calling any method. This
 * domain service borrows its SessionDocument owner, and never disposes it. */
export function createNativeSessionDomainService(options: {
  readonly owner: NativeSessionDocumentOwner;
  readonly generation: string;
  readonly principalId: string;
  readonly snapshots: NativeSessionSnapshotRegistry;
  readonly snapshotRealm?: string;
  assertCurrent(): void;
}) {
  let closed = false;
  const stops = new Set<() => void>();
  const rollbacks = new Map<string, () => Promise<void>>();
  const assertCurrent = () => {
    if (closed) throw new Error('Native Session domain scope is retired');
    options.assertCurrent();
  };
  const backend = options.owner.backend;
  const snapshotRealm = options.snapshotRealm ?? options.generation;
  const range = (from: number, to: number) => {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from)
      throw new Error('Invalid bounded Session read');
  };
  return {
    generation: options.generation,
    assertCurrent,
    async read(query: NativeSessionRead, expectedGeneration?: string): Promise<unknown> {
      assertCurrent();
      if (expectedGeneration !== undefined && expectedGeneration !== options.generation)
        throw new Error('Native Session generation changed');
      let result: unknown;
      switch (query.kind) {
        case 'flush':
          await options.owner.flush();
          break;
        case 'directorySnapshot':
          result = options.owner.control.readDirectorySnapshot();
          break;
        case 'count':
          result = await backend.history.count();
          break;
        case 'control':
          result = await options.owner.control.read();
          break;
        case 'frontiers':
          result = options.owner.control.frontiers();
          break;
        case 'all':
          result = await backend.history.readAll();
          break;
        case 'at':
          if (!Number.isSafeInteger(query.position) || query.position < 0)
            throw new Error('Invalid Session position');
          result = await backend.history.readAt(query.position);
          break;
        case 'turn':
          result = await backend.history.readTurn(query.turnId);
          break;
        case 'display':
          result = await (backend.history.readTurnForDisplay?.(query.turnId) ??
            backend.history.readTurn(query.turnId));
          break;
        case 'output':
          result = await backend.history.readTurnOutput(query.turnId);
          break;
        case 'run':
          result = await backend.history.readSubagentRun?.(
            query.turnId,
            query.sessionId,
            query.runId
          );
          break;
        case 'range':
          range(query.from, query.to);
          result = await backend.history.readRange(query.from, query.to);
          break;
        case 'directory':
          range(query.from, query.to);
          result = await backend.history.readDirectory(query.from, query.to);
          break;
        default:
          throw new Error('Unknown native Session read');
      }
      assertCurrent();
      return result;
    },
    async execute(command: NativeSessionCommand, expectedGeneration: string): Promise<unknown> {
      assertCurrent();
      if (expectedGeneration !== options.generation)
        throw new Error('Native Session generation changed');
      let result: unknown;
      switch (command.kind) {
        case 'append':
          await backend.appendHistoryTurn(command.turn as unknown as SessionHistoryInput);
          break;
        case 'dispatchUserTurn':
          await backend.appendUserTurn(command.turn as unknown as SessionHistoryInput);
          break;
        case 'replace':
          if (command.turnId !== command.turn.id)
            throw new Error('Native replacement identity mismatch');
          if ((await backend.readTurn(command.turnId)).state !== 'ready')
            throw new Error('Native replacement turn is missing');
          result = await backend.applyHistoryAction({
            kind: 'upsert-turn',
            turn: command.turn as unknown as SessionHistoryInput,
          });
          break;
        case 'action':
          result = await backend.applyHistoryAction(command.action);
          break;
        case 'permission':
          result = await backend.respondPermission(
            command.requestId,
            command.outcome,
            command.options
          );
          break;
        case 'editableTail': {
          if (rollbacks.size >= 32)
            throw new Error('Native Session compensation capacity exceeded');
          const accepted = await backend.replaceEditableTail(command.input);
          if (accepted.status !== 'accepted') {
            result = accepted;
            break;
          }
          const token = randomUUID();
          rollbacks.set(token, accepted.rollback);
          result = {
            status: 'accepted',
            previousUserTurnId: accepted.previousUserTurnId,
            rollbackToken: token,
          };
          break;
        }
        case 'rollbackTail': {
          const rollback = rollbacks.get(command.token);
          if (!rollback) throw new Error('Native Session compensation is unavailable');
          await rollback();
          rollbacks.delete(command.token);
          break;
        }
        case 'releaseRollback':
          rollbacks.delete(command.token);
          break;
        case 'import':
          result = await backend.applyHistoryImport(command.input);
          break;
        case 'capture': {
          const captured = options.snapshots.capture(
            snapshotRealm,
            await backend.captureForkSnapshot(),
            assertCurrent
          );
          result = captured;
          break;
        }
        case 'copy':
          await backend.importForkHistory(
            options.snapshots.get(command.token, snapshotRealm),
            command.selection as readonly SessionHistoryInput[]
          );
          break;
        case 'releaseSnapshot':
          options.snapshots.release(command.token, snapshotRealm);
          break;
        case 'humanReceipt':
          await options.owner.control.recordHumanInputReceipt(command.inputId, options.principalId);
          break;
        case 'queuePush':
          await options.owner.control.pushMessageQueue(command.item);
          result = options.owner.control.frontiers();
          break;
        case 'queueUpdate':
          await options.owner.control.updateMessageQueueItem(command.cid, command.patch);
          result = options.owner.control.frontiers();
          break;
        case 'queueRemove':
          await options.owner.control.removeMessageQueueItem(command.cid);
          result = options.owner.control.frontiers();
          break;
        case 'queueReorder':
          await options.owner.control.reorderMessageQueue(command.cids);
          result = options.owner.control.frontiers();
          break;
        case 'cancel':
          await options.owner.control.setCancelRequest({ id: command.id, turnId: command.turnId });
          break;
        case 'preview':
          await options.owner.control.setPreview(command.value);
          break;
        case 'externalCursor':
          await options.owner.control.setExternalHistoryCursor(command.value);
          break;
        default:
          throw new Error('Unknown native Session command');
      }
      assertCurrent();
      return result;
    },
    observe(
      listener: (
        event: { kind: 'history'; change: SessionDataChange } | { kind: 'control' }
      ) => void,
      onError: (error: unknown) => void = () => {}
    ) {
      assertCurrent();
      let active = true;
      let history: ReturnType<typeof backend.history.observe> | undefined;
      let control: (() => void) | undefined;
      const stop = () => {
        if (!active) return;
        active = false;
        const failures: unknown[] = [];
        try {
          history?.unsubscribe();
        } catch (error) {
          failures.push(error);
        }
        try {
          control?.();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length) {
          active = true;
          throw new AggregateError(failures, 'Native Session observation detach failed');
        }
        stops.delete(stop);
      };
      const emit = (
        event: { kind: 'history'; change: SessionDataChange } | { kind: 'control' }
      ) => {
        if (closed || !active) return;
        try {
          assertCurrent();
          listener(event);
        } catch (error) {
          const failures = [error];
          try {
            stop();
          } catch (cleanup) {
            failures.push(cleanup);
          }
          try {
            onError(
              failures.length === 1
                ? error
                : new AggregateError(failures, 'Native Session observation failed')
            );
          } catch {}
        }
      };
      try {
        history = backend.history.observe((change) => emit({ kind: 'history', change }));
        control = options.owner.control.observe(() => emit({ kind: 'control' }));
        stops.add(stop);
        return {
          initial: history.initial as Promise<readonly SessionDirectoryRow[]>,
          control: options.owner.control.read(),
          close: stop,
        };
      } catch (error) {
        try {
          stop();
        } catch (cleanup) {
          stops.add(stop);
          throw new AggregateError(
            [error, cleanup],
            'Native Session partial observation cleanup failed'
          );
        }
        throw error;
      }
    },
    close() {
      closed = true;
      const errors: unknown[] = [];
      for (const stop of stops) {
        try {
          stop();
        } catch (error) {
          errors.push(error);
        }
      }
      rollbacks.clear();
      if (errors.length)
        throw new AggregateError(errors, 'Native Session local observation release failed');
    },
  };
}
export type NativeSessionDomainService = ReturnType<typeof createNativeSessionDomainService>;
