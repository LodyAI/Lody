import { validateSchema } from 'loro-mirror';
import { sessionDocSchema } from '../schema';
import { getMapFieldSchema, isMapSchema } from '../history-materializer';
import { HistoryWriteError } from '../history-write-schema';
import { SessionForkOperationSchema } from '../message-schemas';
import type { SessionDocMeta, MessageQueueItem, SessionAcpRuntimeConfigSnapshot } from '../index';
import type { RepoClient } from '@loro-dev/loro-repo-client';
import type { NativeSessionReader, NativeSessionReadView } from './native-session-reader';
import type { NativeSessionSdkCompatibility } from './native-session-compatibility';
import type { NativeSessionControlPort } from './native-session-document';
import {
  createNativeHistoryPatchPlan,
  NATIVE_SESSION_HISTORY_SCHEMA,
} from './native-history-patch';
import {
  prepareSessionQueueAppend,
  promoteSessionQueueImageReferences,
} from './native-session-queue-plan';
import { prepareSessionAcpRuntimeConfig } from './native-session-runtime-config-plan';
import { createNativeSessionQueuePort } from './native-session-control';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array);
const roots = [
  'session',
  'mq',
  'humanInputReceipts',
  'cancelRequest',
  'forkOperation',
  'notification',
  'preview',
  'externalHistoryCursor',
  'acpRuntimeConfig',
] as const;
type Root = (typeof roots)[number];
function queue(view: NativeSessionReadView): MessageQueueItem[] {
  const value = view.valueAt(['mq']);
  if (value === undefined) return [];
  const ids = new Set<string>();
  if (
    !Array.isArray(value) ||
    value.some(
      (row) =>
        !record(row) || typeof row.$cid !== 'string' || ids.has(row.$cid) || !ids.add(row.$cid)
    )
  )
    throw new Error('Invalid native Session queue identity');
  return value as MessageQueueItem[];
}
function preserveUnknown(root: Root, before: unknown, value: unknown) {
  const definition = sessionDocSchema.definition[root];
  if (!record(before) || !record(value) || !isMapSchema(definition)) return value;
  return {
    ...Object.fromEntries(
      Object.entries(before).filter(([key]) => !getMapFieldSchema(definition, key))
    ),
    ...value,
  };
}

/** Private Node control writer. It never writes history or imports a forked
 * document. Every guard and body patch shares the engine's room CAS. */
export function createNativeSessionDocumentControl(options: {
  readonly client: RepoClient;
  readonly namespace: string;
  readonly sessionId: string;
  readonly writer: string;
  readonly reader: NativeSessionReader;
  readonly compatibility?: NativeSessionSdkCompatibility;
  readonly now: () => number;
  readonly editingLeaseMs: number;
  assertCurrent(): void;
}) {
  const room = { kind: 'loro_doc' as const, id: `session-${options.sessionId}` };
  const transact = async <A>(
    prepare: (
      view: NativeSessionReadView,
      plan: ReturnType<typeof createNativeHistoryPatchPlan>
    ) => A
  ): Promise<A> =>
    options.client.transactCas(async () => {
      options.assertCurrent();
      const prepared = await options.reader.queryLossless((view) => {
        const plan = createNativeHistoryPatchPlan(
          view,
          NATIVE_SESSION_HISTORY_SCHEMA,
          options.compatibility
        );
        const value = prepare(view, plan);
        return { value, ...plan.finish() };
      });
      options.assertCurrent();
      if (prepared.value.patch.length)
        await options.client.applyDocPatch(options.namespace, room, prepared.value.patch, {
          writer: options.writer,
          docSchema: prepared.value.docSchema,
          precondition: { mode: 'cas', expected_room_tx_id: prepared.checkpoint.roomTxId },
        });
      return prepared.value.value;
    });
  const setRoot = (root: Root, value: unknown) =>
    transact((view, plan) => {
      if (
        value !== undefined &&
        !validateSchema(sessionDocSchema.definition[root], value, { ignoreUnknownProperties: true })
          .valid
      )
        throw new HistoryWriteError([{ path: [root], code: 'invalid_control_write' }]);
      const before = view.valueAt([root]);
      plan.control(root, before, value === undefined ? {} : preserveUnknown(root, before, value));
    });
  const projectControl = (view: NativeSessionReadView) => {
    const state = Object.fromEntries(
      roots.filter((root) => root !== 'mq').map((root) => [root, view.valueAt([root])])
    );
    const session = state.session;
    if (record(session) && session.id !== undefined && session.id !== options.sessionId)
      throw new Error('Native Session body identity mismatch');
    // A missing historical id is a projection of the bound room identity,
    // never an observation-time repair or body write.
    state.session = { ...(record(session) ? session : {}), id: options.sessionId };
    state.mq = queue(view);
    return state as Omit<SessionDocMeta, 'history'>;
  };
  const read = () => {
    options.assertCurrent();
    return options.reader.query(projectControl).value;
  };
  const queued = createNativeSessionQueuePort(options);
  const port: NativeSessionControlPort = {
    readDirectorySnapshot: () => {
      options.assertCurrent();
      return options.reader.query((view) => view.history.readDirectory(0, view.history.count()))
        .value;
    },
    frontiers: () => {
      options.assertCurrent();
      return options.reader.frontiers();
    },
    setCancelRequest: (value) => setRoot('cancelRequest', value),
    causalVersion: () => {
      options.assertCurrent();
      return options.reader.causalVersion();
    },
    hasCausalFrontiers: (frontiers) => {
      options.assertCurrent();
      return options.reader.hasCausalFrontiers(frontiers);
    },
    async read() {
      options.assertCurrent();
      return (await options.reader.queryLossless(projectControl)).value;
    },
    observe(listener) {
      options.assertCurrent();
      return options.reader.observeControl(listener);
    },
    getForkOperation() {
      const parsed = SessionForkOperationSchema.safeParse(read().forkOperation);
      return parsed.success ? parsed.data : undefined;
    },
    setForkOperation: (value) => setRoot('forkOperation', value),
    async recordHumanInputReceipt(inputId, userId) {
      if (!inputId || !userId) throw new Error('Human input receipt requires its exact identities');
      await transact((view, plan) => {
        const before = view.valueAt(['humanInputReceipts']);
        if (record(before) && record(before[inputId]) && before[inputId].userId === userId) return;
        plan.control('humanInputReceipts', before, {
          ...(record(before) ? before : {}),
          [inputId]: { userId },
        });
      });
    },
    setNotification: (value) => setRoot('notification', value),
    setPreview: (value) => setRoot('preview', value),
    setExternalHistoryCursor: (value) => setRoot('externalHistoryCursor', value),
    async applyAcpRuntimeConfigPatch(basedOnUserTurnId, patch) {
      return transact((view, plan) => {
        const users = new Map<string, number>();
        let latest = -1;
        for (const row of view.history.readDirectory(0, view.history.count()))
          if (row.state === 'ready' && row.scalars?.role === 'user' && row.turnId) {
            users.set(row.turnId, row.position);
            latest = row.position;
          }
        const before = view.valueAt(['acpRuntimeConfig']);
        const next = prepareSessionAcpRuntimeConfig({
          basedOnUserTurnId,
          patch,
          userTurnIndices: users,
          latestUserTurnIndex: latest,
          current: before as SessionAcpRuntimeConfigSnapshot | undefined,
        });
        if (!next) return false;
        plan.control('acpRuntimeConfig', before, preserveUnknown('acpRuntimeConfig', before, next));
        return true;
      });
    },
    async getMessageQueue() {
      options.assertCurrent();
      return options.reader.query((view) => queue(view)).value;
    },
    async peekReadyMessageQueue() {
      const first = (await port.getMessageQueue())[0];
      return !first ||
        (first.isEditing && options.now() - (first.editingStartedAt ?? 0) < options.editingLeaseMs)
        ? null
        : first;
    },
    async pushMessageQueue(item) {
      await transact((view, plan) => {
        const before = queue(view),
          next = prepareSessionQueueAppend(before, item);
        if (!next) return;
        if (
          !validateSchema(sessionDocSchema.definition.mq.itemSchema!, next, {
            ignoreUnknownProperties: true,
          }).valid
        )
          throw new HistoryWriteError([{ path: ['mq'], code: 'invalid_control_write' }]);
        plan.control('mq', before, [...before, next]);
      });
    },
    async updateMessageQueueItem(cid, patch) {
      await transact((view, plan) => {
        const before = queue(view);
        for (const [key, value] of Object.entries(patch)) {
          if (key === '$cid') continue;
          const schema = getMapFieldSchema(sessionDocSchema.definition.mq.itemSchema!, key);
          if (schema && !validateSchema(schema, value, { ignoreUnknownProperties: true }).valid)
            throw new HistoryWriteError([{ path: ['mq', key], code: 'invalid_control_write' }]);
        }
        plan.control(
          'mq',
          before,
          before.map((row) => (row.$cid === cid ? { ...row, ...patch, $cid: row.$cid } : row))
        );
      });
    },
    async removeMessageQueueItem(cid) {
      options.assertCurrent();
      await queued.removeMessageQueueItem(cid);
    },
    async reorderMessageQueue(cids) {
      options.assertCurrent();
      await queued.reorderMessageQueue(cids);
    },
    async promoteLocalImageReferences(image) {
      await transact((view, plan) => {
        const before = queue(view),
          next = structuredClone(before);
        promoteSessionQueueImageReferences(next, image);
        plan.control('mq', before, next);
      });
    },
  };
  return port;
}
