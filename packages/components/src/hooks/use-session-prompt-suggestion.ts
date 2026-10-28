import { useEffect, useMemo, useState } from 'react';
import { atom, useAtomValue } from 'jotai';
import { getSessionRoomId, type SessionId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import { useResolvedWorkspaceScope } from './use-resolved-workspace-scope';

const noSessionMeta = atom(undefined);

/** Advisory text is independent of the draft. Typing, clearing and accepting never consume it. */
export function useSessionPromptSuggestion(sessionId: SessionId | null | undefined): string | null {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const scope = useResolvedWorkspaceScope();
  const metaAtom = useMemo(
    () => (sessionId ? sessionMetaAtomFamily(getSessionRoomId(sessionId)) : noSessionMeta),
    [sessionId]
  );
  const meta = useAtomValue(metaAtom);
  const machineId = meta?.machineId;
  const enabled = scope.enabled && runtime?.workspaceId === scope.workspaceId;
  const [snapshot, setSnapshot] = useState<{
    runtime: WorkspaceRuntime;
    sessionId: SessionId;
    machineId: string;
    text: string | null;
  } | null>(null);

  useEffect(() => {
    // TEMP prompt-suggestion-debug
    console.info('[prompt-suggestion-debug] ui-subscribe', {
      sessionId,
      machineId,
      enabled,
      hasRuntime: !!runtime,
    });
    if (!enabled || !runtime || !sessionId || !machineId) return undefined;
    return runtime.subscribePromptSuggestion(machineId, sessionId, (text) => {
      // TEMP prompt-suggestion-debug
      console.info('[prompt-suggestion-debug] ui-received', {
        sessionId,
        machineId,
        textLength: text?.length ?? 0,
      });
      setSnapshot({ runtime, sessionId, machineId, text });
    });
  }, [enabled, runtime, sessionId, machineId]);

  return enabled &&
    snapshot?.runtime === runtime &&
    snapshot?.sessionId === sessionId &&
    snapshot?.machineId === machineId
    ? snapshot.text
    : null;
}
