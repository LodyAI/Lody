import { useEffect, useRef, useState } from 'react';
import { useAtomValue, useStore } from 'jotai';
import { useTranslation } from 'react-i18next';
import { useCloudMutation, useCloudQuery } from '@lody/platform/react';
import type { SessionShareManagementEntry, SessionShareView } from '@lody/cloud-api';
import type { WorkspaceId } from '@lody/shared';
import {
  createSessionShareSecret,
  createSessionShareUrl,
  hashSessionShareSecret,
} from '@lody/shared/session-sharing';
import { userAtom } from '@/atoms';
import { cloudOperations } from '@/lib/cloud-api-operations';
import {
  readSessionShareSecret,
  removeSessionShareSecret,
  saveSessionShareSecret,
  sessionShareSecretKey,
} from '@/lib/session-share-secrets';
import { useResolvedWorkspaceScope } from './use-resolved-workspace-scope';

const operations = cloudOperations.sessionSharing;
const versionKey = (entry: SessionShareView | null | undefined) =>
  entry ? `${entry.shareId}:${entry.scopeVersion}:${entry.credentialVersion}` : 'new';
const expected = (entry: SessionShareView) => ({
  scopeVersion: entry.scopeVersion,
  credentialVersion: entry.credentialVersion,
});

/** Mount keyed by user/workspace/session so in-flight actions cannot cross editors. */
export function useSessionShareManagement(
  workspaceId: WorkspaceId,
  sessionId: string,
  candidateIds: string[]
) {
  const { t } = useTranslation();
  const userId = useAtomValue(userAtom)?.id ?? null;
  const store = useStore();
  const scope = useResolvedWorkspaceScope({ workspaceId });
  const [draft, setDraft] = useState<{ baseline: string; ids: string[] } | null>(null);
  const [ephemeral, setEphemeral] = useState<{
    shareId: string;
    credentialVersion: number;
    secret: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const [, refreshSecrets] = useState(0);
  const state = useCloudQuery(
    operations.getManagement,
    scope.enabled && userId !== null
      ? {
          workspaceId,
          sessionId,
          candidateSessionIds: [...new Set([...(draft?.ids ?? []), ...candidateIds])].slice(0, 128),
        }
      : 'skip'
  );
  const requestVerification = useCloudMutation(operations.requestVerification);
  const verificationRef = useRef(requestVerification);
  verificationRef.current = requestVerification;
  const create = useCloudMutation(operations.create);
  const reset = useCloudMutation(operations.reset);
  const updateTargets = useCloudMutation(operations.updateTargets);
  const revoke = useCloudMutation(operations.revoke);
  const selected = draft?.ids ?? state?.root?.sessionIds ?? [sessionId];
  const conflict = draft !== null && draft.baseline !== versionKey(state?.root);

  const verificationIds = JSON.stringify(
    [...new Set([sessionId, ...selected, ...candidateIds])].slice(0, 128)
  );
  useEffect(() => {
    if (!scope.enabled || userId === null) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const verify = async () => {
      if (stopped || store.get(userAtom)?.id !== userId) return;
      try {
        await verificationRef.current({
          workspaceId,
          sessionIds: JSON.parse(verificationIds) as string[],
        });
      } catch {
        // The reactive management query retains its unavailable/expired state.
        // This retry is discovery only and must never claim that a source synced.
      } finally {
        if (!stopped)
          timer = setTimeout(() => {
            void verify();
          }, 60_000);
      }
    };
    void verify();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [scope.enabled, userId, workspaceId, verificationIds, store]);

  useEffect(() => {
    alive.current = true;
    const changed = () => refreshSecrets((value) => value + 1);
    window.addEventListener('storage', changed);
    return () => {
      alive.current = false;
      window.removeEventListener('storage', changed);
    };
  }, []);
  useEffect(() => {
    // Reactive queries do not rerun just because a lease expires.
    const deadlines = [...(state?.sources ?? []), ...(state?.candidates ?? [])].flatMap((entry) =>
      entry.validUntil !== null && entry.validUntil > now ? [entry.validUntil] : []
    );
    if (!deadlines.length) return undefined;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Math.min(...deadlines) - Date.now() + 1)
    );
    return () => clearTimeout(timer);
  }, [state, now]);

  const secretFor = (entry: SessionShareView): string | null => {
    if (userId === null || entry.authorUserId !== userId || entry.status !== 'active') return null;
    try {
      const stored = readSessionShareSecret(
        localStorage,
        sessionShareSecretKey(userId, workspaceId, entry.shareId),
        entry.credentialVersion
      );
      if (stored !== null) return stored;
    } catch {
      /* Storage itself may be unavailable. Keep the just-created secret in memory. */
    }
    return ephemeral?.shareId === entry.shareId &&
      ephemeral.credentialVersion === entry.credentialVersion
      ? ephemeral.secret
      : null;
  };

  const run = async (action: () => Promise<void>) => {
    if (busyRef.current || !scope.enabled || userId === null) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch {
      // Never log mutation inputs, link secrets, or raw provider errors.
      if (alive.current)
        setError(
          t(
            'sharing.manager.failed',
            'Could not update sharing. Check the current settings and try again.'
          )
        );
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };

  const issueLink = () =>
    run(async () => {
      if (!state || userId === null || conflict) return;
      const secret = createSessionShareSecret();
      const credentialHash = await hashSessionShareSecret(secret);
      const entry = state.root
        ? await reset({
            shareId: state.root.shareId,
            expected: expected(state.root),
            sessionIds: selected,
            credentialHash,
          })
        : await create({
            workspaceId,
            rootSessionId: sessionId,
            sessionIds: selected,
            credentialHash,
          });
      // Closing an editor still saves its successful result. Signing out or
      // switching accounts must not reintroduce secrets after a local wipe.
      if (store.get(userAtom)?.id !== userId) return;
      let persistence: 'stored' | 'superseded' | 'unavailable' = 'unavailable';
      try {
        persistence = saveSessionShareSecret(
          localStorage,
          sessionShareSecretKey(userId, workspaceId, entry.shareId),
          { credentialVersion: entry.credentialVersion, secret }
        );
      } catch {
        /* Reading localStorage may itself throw. */
      }
      if (!alive.current) return;
      if (persistence === 'superseded') {
        setError(
          t(
            'sharing.manager.conflict',
            'Sharing changed on another device. Reload the selection before making changes.'
          )
        );
        return;
      }
      setEphemeral({ shareId: entry.shareId, credentialVersion: entry.credentialVersion, secret });
      setDraft(null);
      setNotice(
        persistence === 'stored'
          ? t('sharing.manager.created', 'Link ready. Copy it to share.')
          : t(
              'sharing.manager.storageUnavailable',
              'Link ready, but this device could not save its secret. Copy it now; after closing this page you may need to reset the link.'
            )
      );
    });

  return {
    state,
    selected,
    busy,
    error,
    notice,
    now,
    conflict,
    copyableShareIds:
      state?.sources.filter((entry) => secretFor(entry) !== null).map((entry) => entry.shareId) ??
      [],
    onSelect: (ids: string[]) =>
      setDraft({ baseline: draft?.baseline ?? versionKey(state?.root), ids }),
    onReload: () => {
      setDraft(null);
      setError(null);
    },
    onCreate: () => {
      void issueLink();
    },
    onReset: () => {
      void issueLink();
    },
    onSave: () => {
      void run(async () => {
        if (!state?.root || conflict) return;
        await updateTargets({
          shareId: state.root.shareId,
          expected: expected(state.root),
          sessionIds: selected,
        });
        if (alive.current) {
          setDraft(null);
          setNotice(t('sharing.manager.saved', 'Selection saved.'));
        }
      });
    },
    onCopy: (entry: SessionShareManagementEntry) => {
      void run(async () => {
        const secret = secretFor(entry);
        if (secret === null || (entry.validUntil ?? 0) <= Date.now())
          throw new Error('Share unavailable');
        await navigator.clipboard.writeText(
          createSessionShareUrl(entry.shareId, secret, import.meta.env.VITE_SESSION_SHARE_ORIGIN)
        );
        if (alive.current) setNotice(t('sharing.manager.copied', 'Share link copied.'));
      });
    },
    onRevoke: (entry: SessionShareManagementEntry) => {
      void run(async () => {
        await revoke({ shareId: entry.shareId, expected: expected(entry) });
        if (userId !== null) {
          try {
            removeSessionShareSecret(
              localStorage,
              sessionShareSecretKey(userId, workspaceId, entry.shareId),
              entry.credentialVersion
            );
          } catch {
            /* Best effort. */
          }
        }
        if (alive.current) {
          setEphemeral((value) => (value?.shareId === entry.shareId ? null : value));
          if (entry.shareId === state?.root?.shareId) setDraft(null);
          setNotice(
            t(
              'sharing.manager.revokedNotice',
              'Link revoked. In-progress reads may take a short time to stop.'
            )
          );
        }
      });
    },
  };
}
