import { useMemo, useState } from 'react';
import type { SessionHistory } from '@lody/shared';
import { readPreparedShareHistory, type PreparedSharePackage } from '@lody/shared/session-sharing';
import { resolveSharePanes } from '@/lib/session-share-navigation';
import { SessionShareSurface } from './session-share-page';
import { SessionShareErrorBoundary } from './session-share-error-boundary';

/** Exactly the frozen, unpublished bytes. This preview has no network or source adapter. */
export function SessionSharePreview({ prepared }: { prepared: PreparedSharePackage }) {
  const [selected, setSelected] = useState(prepared.manifest.rootConversationId);
  const [sideId, setSideId] = useState<string>();
  const panes = resolveSharePanes(prepared.manifest, selected, sideId);
  const sideConversationId = panes.side?.id;
  const snapshot = useMemo(
    () => ({
      status: 'ready' as const,
      history: readPreparedShareHistory(prepared, panes.main.id) as unknown as SessionHistory[],
    }),
    [prepared, panes.main.id]
  );
  const sideSnapshot = useMemo(
    () =>
      sideConversationId
        ? {
            status: 'ready' as const,
            history: readPreparedShareHistory(
              prepared,
              sideConversationId
            ) as unknown as SessionHistory[],
          }
        : undefined,
    [prepared, sideConversationId]
  );
  const access = useMemo(
    () => ({
      read: async (id: string, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        const attachment = prepared.manifest.attachments.find((entry) => entry.id === id);
        const descriptor =
          attachment && prepared.manifest.objects.find((entry) => entry.id === attachment.objectId);
        const bytes = descriptor && prepared.objects.get(descriptor.id);
        if (!bytes || !descriptor) throw new Error('Share attachment unavailable');
        return new Blob([bytes.slice().buffer], { type: descriptor.mediaType });
      },
    }),
    [prepared]
  );
  return (
    <div className="overflow-hidden rounded-md border border-border/60 [&_main]:h-[50vh]">
      <SessionShareErrorBoundary>
        <SessionShareSurface
          manifest={prepared.manifest}
          sessionId={selected}
          sideId={sideId}
          status="ready"
          snapshot={snapshot}
          sideSnapshot={sideSnapshot}
          attachmentAccess={access}
          onSelect={(id) => {
            const conversation = prepared.manifest.conversations.find((entry) => entry.id === id);
            if (conversation?.childSessionPlacement === 'side-panel') setSideId(id);
            else setSelected(id);
          }}
        />
      </SessionShareErrorBoundary>
    </div>
  );
}
