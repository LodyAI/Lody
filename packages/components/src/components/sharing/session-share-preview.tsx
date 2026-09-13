import { useMemo, useState } from 'react';
import type { SessionHistory } from '@lody/shared';
import { readPreparedShareHistory, type PreparedSharePackage } from '@lody/shared/session-sharing';
import { resolveSharePanes } from '@/lib/session-share-navigation';
import { SessionShareSurface } from './session-share-page';
import { SessionShareErrorBoundary } from './session-share-error-boundary';

/** Exactly the frozen, unpublished bytes. This preview has no network or source adapter. */
export function SessionSharePreview({ prepared }: { prepared: PreparedSharePackage }) {
  const [selected, setSelected] = useState(prepared.manifest.rootConversationId);
  const panes = resolveSharePanes(prepared.manifest, selected);
  const snapshot = useMemo(
    () => ({
      status: 'ready' as const,
      history: readPreparedShareHistory(prepared, panes.main.id) as unknown as SessionHistory[],
    }),
    [prepared, panes.main.id]
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
          embedded
          manifest={prepared.manifest}
          sessionId={selected}
          status="ready"
          snapshot={snapshot}
          attachmentAccess={access}
          onSelect={setSelected}
        />
      </SessionShareErrorBoundary>
    </div>
  );
}
