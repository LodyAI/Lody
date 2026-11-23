import { useEffect, useRef } from 'react';
import type { SessionMeta } from '@lody/shared';
import { createDraftSessionTab, type DraftSessionTab } from '@/lib/session-draft-tabs';

/** Materialize the empty URL sentinel into a local draft, never a shared Session. */
export function useEmptySessionDraft({
  enabled,
  parent,
  drafts,
  onCreate,
  onSelect,
}: {
  enabled: boolean;
  parent: SessionMeta | null | undefined;
  drafts: readonly DraftSessionTab[];
  onCreate: (draft: DraftSessionTab) => void;
  onSelect: (id: DraftSessionTab['id']) => void;
}) {
  const pendingParentId = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !parent) {
      pendingParentId.current = null;
      return;
    }
    // Select only a committed draft: navigating before insertion makes URL
    // resolution treat it as a missing local draft and reopen the parent.
    const existing = drafts[0];
    if (existing) {
      onSelect(existing.id);
      return;
    }
    if (pendingParentId.current === parent.id) return;
    const draft = createDraftSessionTab({
      agentConfigId: parent.agentConfigId,
      cliType: parent.cliType,
      agentType: parent.agentType,
      modeId: null,
      modelId: null,
    });
    pendingParentId.current = parent.id;
    onCreate(draft);
  }, [enabled, parent, drafts, onCreate, onSelect]);
}
