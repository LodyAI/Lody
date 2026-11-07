import type { Session } from '../../models/catalog.ts';
import type {
  ShareEntry,
  ShareRequest,
  ShareState,
  ShareProgress,
} from '../../models/session-sharing.ts';
import {
  prepareSharePackage,
  type PreparedSharePackage,
} from './session-share-export.ts';
import { SHARE_LIMITS, ShareResourceId } from './session-share-package.ts';
import { mapShareConcurrent } from './session-share-concurrency.ts';
import {
  createSessionShareSecret,
  createSessionShareUrl,
  hashSessionShareSecret,
} from './session-share-credentials.ts';

export function shareCandidates(root: string, sessions: readonly Session[]) {
  const ids = new Set([root]);
  const result: Session[] = [];
  const queue = [root];
  for (let index = 0; index < queue.length; index++) {
    for (const session of sessions) {
      if (
        ids.has(session.id) ||
        (session.parentSessionId !== queue[index] &&
          session.openedBySessionId !== queue[index])
      )
        continue;
      ids.add(session.id);
      queue.push(session.id);
      result.push(session);
    }
  }
  return result;
}

type Broker = (
  operation: string,
  args: Record<string, unknown>,
) => Promise<any>;
type Pending = {
  prepared: PreparedSharePackage;
  requestId: string;
  uploadSecret: string;
  readerSecret: string | null;
  expected: ShareEntry | null;
  deployment?: ShareEntry & { deploymentId: string };
  sealed?: boolean;
};
type Editor = {
  workspaceId: string;
  sessionId: string;
  controller: AbortController;
  busy: boolean;
  visibleEntry?: ShareEntry | null;
  pending?: Pending;
};

export function createSharingRuntime(deps: {
  sessions: () => Session[];
  broker: Broker;
  history: (id: string, signal: AbortSignal) => Promise<unknown>;
  progress: (progress: ShareProgress) => void;
  fetch?: typeof fetch;
}) {
  const editors = new Map<string, Editor>();
  const api = (method: string, args: Record<string, unknown>) =>
    deps.broker('api', { method, args });
  const save = async (entry: ShareEntry, secret: string) => {
    await deps.broker('saveSecret', {
      shareId: entry.shareId,
      version: entry.credentialVersion,
      secret,
    });
    if (
      (await deps.broker('readSecret', {
        shareId: entry.shareId,
        version: entry.credentialVersion,
      })) !== secret
    )
      throw new Error('share_storage_failed');
  };
  const management = async (args: ShareRequest): Promise<ShareEntry | null> => {
    const entry = await api('getManagement', {
      workspaceId: args.workspaceId,
      rootSessionId: args.sessionId,
    });
    if (entry === null) return null;
    if (
      !entry ||
      entry.rootSessionId !== args.sessionId ||
      !['draft', 'active', 'revoked'].includes(entry.status) ||
      !Number.isSafeInteger(entry.revision) ||
      !Number.isSafeInteger(entry.credentialVersion)
    )
      throw new Error('share_invalid_response');
    ShareResourceId.parse(entry.shareId);
    return entry;
  };
  async function state(
    args: ShareRequest,
    editor: Editor,
  ): Promise<ShareState> {
    const entry = await management(args);
    const secret =
      entry?.status === 'active'
        ? await deps.broker('readSecret', {
            shareId: entry.shareId,
            version: entry.credentialVersion,
          })
        : null;
    const all = deps.sessions();
    const root = all.find((s) => s.id === args.sessionId);
    editor.visibleEntry = entry;
    return {
      entry,
      url:
        secret && entry
          ? createSessionShareUrl(
              entry.shareId,
              secret,
              'https://share.lody.ai',
            )
          : null,
      candidates: root
        ? [root, ...shareCandidates(root.id, all)].map(({ id, title }) => ({
            id,
            title,
          }))
        : [],
      selected: editor.pending?.prepared.sourceIds
        .filter((s) =>
          editor.pending?.prepared.manifest.conversations.some(
            (c) => c.id === s.conversationId,
          ),
        )
        .map((s) => s.sourceId) ??
        (entry?.status === 'active' ? entry.selectedSourceIds : undefined) ?? [
          args.sessionId,
        ],
      pending: !!editor.pending,
    };
  }
  return async (args: ShareRequest): Promise<ShareState | null> => {
    ShareResourceId.parse(args.sessionId);
    let editor = editors.get(args.editorId);
    if (args.action === 'close') {
      editor?.controller.abort();
      editors.delete(args.editorId);
      return null;
    }
    if (!editor) {
      editor = {
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
        controller: new AbortController(),
        busy: false,
      };
      editors.set(args.editorId, editor);
    }
    if (
      editor.workspaceId !== args.workspaceId ||
      editor.sessionId !== args.sessionId ||
      editor.busy
    )
      throw new Error('share_busy');
    editor.busy = true;
    const signal = AbortSignal.any([
      editor.controller.signal,
      AbortSignal.timeout(120000),
    ]);
    try {
      if (args.action === 'discard') editor.pending = undefined;
      if (args.action === 'reset' || args.action === 'revoke') {
        const entry = editor.visibleEntry;
        signal.throwIfAborted();
        if (!entry) throw new Error('share_unavailable');
        if (args.action === 'reset') {
          if (!entry.canManage || entry.status !== 'active')
            throw new Error('share_forbidden');
          const secret =
            (await deps.broker('readSecret', {
              shareId: entry.shareId,
              version: entry.credentialVersion + 1,
            })) ?? createSessionShareSecret();
          await save(
            { ...entry, credentialVersion: entry.credentialVersion + 1 },
            secret,
          );
          signal.throwIfAborted();
          const updated = await api('resetCredential', {
            shareId: entry.shareId,
            expectedRevision: entry.revision,
            credentialHash: await hashSessionShareSecret(secret),
          });
          await save(updated, secret);
        } else {
          if (!entry.canRevoke) throw new Error('share_forbidden');
          await api('revoke', {
            shareId: entry.shareId,
            expectedRevision: entry.revision,
          });
        }
        editor.pending = undefined;
      }
      if (args.action === 'publish') {
        let entry = await management(args);
        signal.throwIfAborted();
        let pending = editor.pending;
        if (
          pending?.deployment &&
          entry?.currentDeploymentId === pending.deployment.deploymentId &&
          entry.status === 'active'
        ) {
          editor.pending = undefined;
          return await state(args, editor);
        }
        if (pending) {
          const expected = entry?.status === 'active' ? entry : null;
          if (
            pending.expected?.shareId !== expected?.shareId ||
            pending.expected?.revision !== expected?.revision
          )
            throw new Error('share_conflict');
        } else {
          if (
            editor.visibleEntry !== undefined &&
            (editor.visibleEntry?.shareId !== entry?.shareId ||
              editor.visibleEntry?.revision !== entry?.revision ||
              editor.visibleEntry?.status !== entry?.status)
          )
            throw new Error('share_conflict');
          if (entry?.status === 'active' && !entry.canManage)
            throw new Error('share_forbidden');
          const all = deps.sessions();
          const root = all.find((s) => s.id === args.sessionId);
          const candidates = root
            ? [root, ...shareCandidates(root.id, all)]
            : [];
          const selected = args.selected ?? [args.sessionId];
          if (
            !root ||
            !selected.includes(root.id) ||
            new Set(selected).size !== selected.length ||
            selected.length > SHARE_LIMITS.conversations ||
            selected.some((id) => !candidates.some((s) => s.id === id))
          )
            throw new Error('share_selection_unavailable');
          const sessions = selected.map((id) =>
            candidates.find((s) => s.id === id)!,
          );
          deps.progress({ editorId: args.editorId, phase: 'capturing' });
          const histories = await mapShareConcurrent(
            sessions,
            (s, _, signal) => deps.history(s.id, signal),
            signal,
          );
          const prepared = await prepareSharePackage({
            rootSourceId: root.id,
            previousSourceIds: entry?.sourceIds,
            capturedAt: new Date().toISOString(),
            fileAttachmentOmissionText: args.omissionText,
            signal,
            conversations: sessions.map((s, i) => ({
              sourceId: s.id,
              title: s.title,
              history: histories[i],
              parentSourceId: s.parentSessionId,
              openedBySourceId: s.openedBySessionId,
            })),
            readAttachment: async ({
              conversationSourceId,
              kind,
              reference,
            }) => {
              signal.throwIfAborted();
              if (kind !== 'image') throw new Error('share_file_disabled');
              const value = await deps.broker('image', {
                sessionId: ShareResourceId.parse(
                  reference.storageSessionId ?? conversationSourceId,
                ),
                imageId: ShareResourceId.parse(reference.imageId),
              });
              signal.throwIfAborted();
              return {
                bytes: Uint8Array.from(atob(value.base64), (c) =>
                  c.charCodeAt(0),
                ),
                mediaType: value.mediaType,
              };
            },
          });
          signal.throwIfAborted();
          if (entry?.status === 'draft') {
            if (!entry.canManage) throw new Error('share_forbidden');
            await api('revoke', {
              shareId: entry.shareId,
              expectedRevision: entry.revision,
            });
            entry = null;
          }
          const expected = entry?.status === 'active' ? entry : null;
          pending = {
            prepared,
            requestId: crypto.randomUUID(),
            uploadSecret: createSessionShareSecret(),
            readerSecret: expected ? null : createSessionShareSecret(),
            expected,
          };
          editor.pending = pending;
        }
        signal.throwIfAborted();
        deps.progress({
          editorId: args.editorId,
          phase: 'uploading',
          percent: 0,
        });
        const { prepared, readerSecret, uploadSecret, expected } = pending;
        if (!pending.deployment)
          pending.deployment = await api('beginDeployment', {
            workspaceId: args.workspaceId,
            rootSessionId: args.sessionId,
            ...(expected
              ? {
                  shareId: expected.shareId,
                  expectedRevision: expected.revision,
                }
              : {}),
            ...(readerSecret
              ? { credentialHash: await hashSessionShareSecret(readerSecret) }
              : {}),
            uploadCredentialHash: await hashSessionShareSecret(uploadSecret),
            requestId: pending.requestId,
            manifest: prepared.manifest,
            sourceIds: prepared.sourceIds,
          });
        const deployment = pending.deployment!;
        ShareResourceId.parse(deployment.deploymentId);
        signal.throwIfAborted();
        if (readerSecret) await save(deployment, readerSecret);
        const request = async (
          path: string,
          body: Uint8Array,
          method: string,
        ) => {
          signal.throwIfAborted();
          const response = await (deps.fetch ?? fetch)(
            `https://api.lody.ai/api/share-deployments/${deployment.deploymentId}${path}`,
            {
              method,
              signal,
              credentials: 'omit',
              redirect: 'error',
              cache: 'no-store',
              headers: {
                Authorization: `Bearer ${uploadSecret}`,
                'Content-Type':
                  method === 'PUT'
                    ? 'application/octet-stream'
                    : 'application/json',
              },
              body: body.slice().buffer,
            },
          );
          await response.body?.cancel();
          if (!response.ok) throw new Error('share_upload_failed');
        };
        if (!pending.sealed) {
          let uploaded = 0;
          const total = prepared.manifest.objects.reduce(
            (sum, o) => sum + o.sizeBytes,
            0,
          );
          // Sequential uploads bound the mobile working set; retry reuses the frozen package.
          for (const object of prepared.manifest.objects) {
            await request(
              `/objects/${object.id}`,
              prepared.objects.get(object.id)!,
              'PUT',
            );
            uploaded += object.sizeBytes;
            deps.progress({
              editorId: args.editorId,
              phase: 'uploading',
              percent: total ? Math.round((uploaded / total) * 100) : 100,
            });
          }
          await request('/seal', prepared.manifestBytes, 'POST');
          pending.sealed = true;
        }
        if (readerSecret) await save(deployment, readerSecret);
        signal.throwIfAborted();
        deps.progress({ editorId: args.editorId, phase: 'publishing' });
        const published = await api('publishDeployment', {
          deploymentId: deployment.deploymentId,
        });
        if (
          published.status !== 'active' ||
          published.currentDeploymentId !== deployment.deploymentId
        )
          throw new Error('share_not_published');
        editor.pending = undefined;
      }
      signal.throwIfAborted();
      return await state(args, editor);
    } finally {
      editor.busy = false;
    }
  };
}
