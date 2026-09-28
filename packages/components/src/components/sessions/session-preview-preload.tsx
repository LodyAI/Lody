import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { usePlatformCapability } from '@lody/platform/react';
import {
  formatPreviewTargetUrl,
  parseBrowserAddress,
  type SessionMeta,
  type SessionPreviewDocState,
} from '@lody/shared';

import { activeWorkspaceRuntimeAtom, userAtom } from '@/atoms';
import { isElectronRenderer } from '@/lib/electron';
import { hasUsableManagedPreviewUrl } from '@/lib/managed-preview-connection';
import { buildManagedViewerUrl, samePreviewTargetOrigin } from '@/lib/session-browser-url';
import {
  canPrepareManagedPreviewFrame,
  prepareManagedPreviewFrame,
} from './managed-preview-frame-cache';

/** Observes the visible conversation's existing document; no extra doc or polling. */
export function SessionPreviewPreload({
  session,
  preview,
}: {
  session: SessionMeta;
  preview: SessionPreviewDocState | undefined;
}) {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const user = useAtomValue(userAtom);
  const enabled = usePlatformCapability('remotePreview');
  const { t } = useTranslation();
  const title = t('sessions.browser.managedFrameTitle', 'Managed preview');
  const candidate = preview?.candidate;
  const candidateUrl =
    candidate?.status === 'available' && candidate.target
      ? formatPreviewTargetUrl(candidate.target)
      : null;
  const endpointId =
    preview?.connection?.status === 'active' ? preview.connection.endpointId : null;

  useEffect(() => {
    if (
      !enabled ||
      session.isArchived ||
      !runtime ||
      !user?.id ||
      !candidateUrl ||
      !endpointId ||
      !canPrepareManagedPreviewFrame(session.id)
    )
      return;
    let disposed = false;
    let started = false;
    let release: (() => void) | undefined;
    const prepare = async () => {
      if (started || disposed || document.hidden) return;
      started = true;
      try {
        // A persisted active flag is only a hint. Confirm the live endpoint once,
        // without renewal, and keep local desktop viewing on its local route.
        if (
          isElectronRenderer() &&
          (await runtime.resolveMachineTargetPlane?.(session.machineId)) !== 'cloud'
        )
          return;
        if (disposed) return;
        const response = await runtime.requestSessionPreviewStatus(
          session.machineId,
          session.id,
          user.id
        );
        const connection = response?.success ? response.connection : undefined;
        const address = parseBrowserAddress(candidateUrl);
        if (
          disposed ||
          document.hidden ||
          !hasUsableManagedPreviewUrl(connection) ||
          connection.endpointId !== endpointId ||
          address.engine !== 'managed-preview' ||
          !address.target ||
          !samePreviewTargetOrigin(connection.target, address.target)
        )
          return;
        release = prepareManagedPreviewFrame(
          session.id,
          buildManagedViewerUrl(connection.publicUrl, address.target),
          title
        );
      } catch {
        // Speculation is optional; opening Browser owns visible errors and recovery.
      }
    };
    const visibilityChanged = () => {
      if (document.hidden) {
        if (started) disposed = true;
        release?.();
      } else {
        void prepare();
      }
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    void prepare();
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', visibilityChanged);
      release?.();
    };
  }, [
    enabled,
    runtime,
    user?.id,
    session.id,
    session.machineId,
    session.isArchived,
    candidateUrl,
    endpointId,
    title,
  ]);

  return null;
}
