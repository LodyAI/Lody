import { useEffect, useRef, useState } from 'react';
import { useAtomValue, useStore } from 'jotai';
import { useTranslation } from 'react-i18next';
import { useCloudMutation, useCloudQuery } from '@lody/platform/react';
import type { SessionShareView } from '@lody/cloud-api';
import type { SessionMeta, WorkspaceId } from '@lody/shared';
import {
  createSessionShareSecret,
  createSessionShareUrl,
  hashSessionShareSecret,
  uploadPreparedShare,
  type PreparedSharePackage,
} from '@lody/shared/session-sharing';
import { userAtom } from '@/atoms';
import { activeWorkspaceRuntimeAtom, authTokenAtom } from '@/atoms/runtime';
import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { captureSessionShare } from '@/lib/session-share-publisher';
import {
  readSessionShareSecret,
  removeSessionShareSecret,
  saveSessionShareSecret,
  sessionShareSecretKey,
} from '@/lib/session-share-secrets';
import { useResolvedWorkspaceScope } from './use-resolved-workspace-scope';

const operations = cloudOperations.sessionSharing;

/** Shared by the conversation dialog and Settings. Authority is checked server-side. */
export function useSessionShareLinkActions(workspaceId: WorkspaceId) {
  const { t } = useTranslation();
  const userId = useAtomValue(userAtom)?.id ?? null;
  const store = useStore();
  const scope = useResolvedWorkspaceScope({ workspaceId });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ephemeral, setEphemeral] = useState<{
    shareId: string;
    credentialVersion: number;
    secret: string;
  } | null>(null);
  const [, refresh] = useState(0);
  const reset = useCloudMutation(operations.resetCredential);
  const revoke = useCloudMutation(operations.revoke);
  useEffect(() => {
    mounted.current = true;
    const changed = () => refresh((value) => value + 1);
    window.addEventListener('storage', changed);
    return () => {
      mounted.current = false;
      window.removeEventListener('storage', changed);
    };
  }, []);
  const current = () =>
    mounted.current && scope.enabled && userId !== null && store.get(userAtom)?.id === userId;
  const remember = (entry: SessionShareView, secret: string) => {
    if (!current() || !userId) return;
    setEphemeral({ shareId: entry.shareId, credentialVersion: entry.credentialVersion, secret });
    try {
      saveSessionShareSecret(
        localStorage,
        sessionShareSecretKey(userId, workspaceId, entry.shareId),
        { secret, credentialVersion: entry.credentialVersion }
      );
    } catch {
      /* Keep the successful result in memory if storage is unavailable. */
    }
  };
  function secretFor(entry: SessionShareView): string | null {
    if (!userId || entry.publisherUserId !== userId || entry.status !== 'active') return null;
    try {
      const secret = readSessionShareSecret(
        localStorage,
        sessionShareSecretKey(userId, workspaceId, entry.shareId),
        entry.credentialVersion
      );
      if (secret) return secret;
    } catch {
      /* Storage may be unavailable. */
    }
    return ephemeral?.shareId === entry.shareId &&
      ephemeral.credentialVersion === entry.credentialVersion
      ? ephemeral.secret
      : null;
  }
  async function run(action: () => Promise<void>) {
    if (!current() || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch {
      if (current())
        setError(
          t(
            'sharing.manager.failed',
            'Could not update sharing. Check the current settings and try again.'
          )
        );
    } finally {
      busyRef.current = false;
      if (current()) setBusy(false);
    }
  }
  return {
    busy,
    error,
    notice,
    run,
    remember,
    secretFor,
    copy(entry: SessionShareView) {
      return run(async () => {
        const secret = secretFor(entry);
        if (!secret) throw new Error('Share credential unavailable');
        await navigator.clipboard.writeText(
          createSessionShareUrl(entry.shareId, secret, import.meta.env.VITE_SESSION_SHARE_ORIGIN)
        );
        if (current()) setNotice(t('settings.shares.copied', 'Share link copied'));
      });
    },
    reset(entry: SessionShareView) {
      return run(async () => {
        const secret = createSessionShareSecret();
        const updated = await reset({
          shareId: entry.shareId,
          expectedRevision: entry.revision,
          credentialHash: await hashSessionShareSecret(secret),
        });
        remember(updated, secret);
      });
    },
    revoke(entry: SessionShareView) {
      return run(async () => {
        await revoke({ shareId: entry.shareId, expectedRevision: entry.revision });
        if (current() && userId) {
          try {
            removeSessionShareSecret(
              localStorage,
              sessionShareSecretKey(userId, workspaceId, entry.shareId),
              entry.credentialVersion
            );
          } catch {
            /* Revocation remains effective. */
          }
          setEphemeral(null);
        }
      });
    },
  };
}

type PendingPublication = {
  deploymentId?: string;
  sealed?: boolean;
  prepared: PreparedSharePackage;
  requestId: string;
  uploadSecret: string;
  readerSecret: string | null;
  expected: SessionShareView | null;
};

/** Key the owner by account/workspace/root so an async publication cannot cross scopes. */
export function useSessionShareManagement(
  workspaceId: WorkspaceId,
  sessionId: string,
  candidateIds: string[],
  shareId?: string,
  confirmation?: { requestId: string; sessionIds: string[] }
) {
  const scope = useResolvedWorkspaceScope({ workspaceId });
  const userId = useAtomValue(userAtom)?.id;
  const store = useStore();
  const meta = useAtomValue(sessionMetaCacheAtom);
  const actions = useSessionShareLinkActions(workspaceId);
  const entry = useCloudQuery(
    operations.getManagement,
    scope.enabled && userId ? { workspaceId, rootSessionId: sessionId, shareId } : 'skip'
  );
  const begin = useCloudMutation(operations.beginDeployment);
  const publish = useCloudMutation(operations.publishDeployment);
  const [selectedDraft, setSelected] = useState<string[] | null>(null);
  const [pending, setPending] = useState<PendingPublication | null>(null);
  const [progress, setProgress] = useState(0);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
    };
  }, []);
  const selected =
    confirmation?.sessionIds ??
    selectedDraft ??
    (entry?.status === 'active' ? entry.selectedSourceIds : [sessionId]);
  const conflict =
    !!pending &&
    !(pending.deploymentId && entry?.currentDeploymentId === pending.deploymentId) &&
    (pending.expected?.shareId !== (entry?.status === 'active' ? entry.shareId : undefined) ||
      pending.expected?.revision !== (entry?.status === 'active' ? entry.revision : undefined));
  const prepare = () =>
    actions.run(async () => {
      const runtime = store.get(activeWorkspaceRuntimeAtom),
        token = store.get(authTokenAtom);
      if (!runtime || runtime.workspaceId !== workspaceId || !token || !lifetime.current)
        throw new Error('Share source unavailable');
      const byId = new Map(Object.values(meta).map((session) => [session.id as string, session]));
      const sessions = selected.map((id) => byId.get(id)).filter((s): s is SessionMeta => !!s);
      if (sessions.length !== selected.length || !selected.includes(sessionId))
        throw new Error('Share source unavailable');
      const signal = AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(120_000)]);
      const prepared = await captureSessionShare({
        runtime,
        token,
        sessions,
        rootSessionId: sessionId,
        previousSourceIds: entry?.sourceIds,
        signal,
      });
      signal.throwIfAborted();
      const expected = entry?.status === 'active' ? entry : null;
      setPending({
        prepared,
        expected,
        requestId: crypto.randomUUID(),
        uploadSecret: createSessionShareSecret(),
        readerSecret: expected ? null : createSessionShareSecret(),
      });
    });
  const confirm = () =>
    actions.run(async () => {
      if (!pending || conflict || !lifetime.current) throw new Error('Share confirmation changed');
      const { expected, prepared, uploadSecret, readerSecret, requestId } = pending;
      const result = pending.deploymentId
        ? { deploymentId: pending.deploymentId }
        : await begin({
            workspaceId,
            rootSessionId: sessionId,
            shareId: expected?.shareId,
            expectedRevision: expected?.revision,
            credentialHash: readerSecret ? await hashSessionShareSecret(readerSecret) : undefined,
            uploadCredentialHash: await hashSessionShareSecret(uploadSecret),
            requestId,
            confirmationRequestId: confirmation?.requestId,
            manifest: prepared.manifest,
            sourceIds: prepared.sourceIds,
          });
      setPending((value) =>
        value?.requestId === requestId ? { ...value, deploymentId: result.deploymentId } : value
      );
      lifetime.current.signal.throwIfAborted();
      if (!pending.sealed) {
        await uploadPreparedShare({
          origin: import.meta.env.VITE_SERVER_URL,
          deploymentId: result.deploymentId,
          secret: uploadSecret,
          prepared,
          signal: lifetime.current.signal,
          onProgress: (uploaded, total) =>
            setProgress(total ? Math.round((uploaded / total) * 100) : 100),
        });
        setPending((value) =>
          value?.requestId === requestId ? { ...value, sealed: true } : value
        );
      }
      const updated = await publish({ deploymentId: result.deploymentId });
      if (readerSecret) actions.remember(updated, readerSecret);
      if (!lifetime.current.signal.aborted) {
        setPending(null);
        setSelected(null);
        setProgress(0);
      }
    });
  return {
    entry,
    selected,
    pending: pending?.prepared ?? null,
    conflict,
    progress,
    canCapture: selected.every(
      (id) => candidateIds.includes(id) && Object.values(meta).some((session) => session.id === id)
    ),
    busy: actions.busy,
    error: actions.error,
    notice: actions.notice,
    hasSecret: !!entry && !!actions.secretFor(entry),
    onSelect(ids: string[]) {
      if (!actions.busy && !confirmation) {
        setSelected(ids);
        setPending(null);
      }
    },
    onPrepare: prepare,
    onConfirm: confirm,
    onDiscard: () => setPending(null),
    onCopy: () => entry && actions.copy(entry),
    onReset: () => entry && actions.reset(entry),
    onRevoke: () => entry && actions.revoke(entry),
  };
}
