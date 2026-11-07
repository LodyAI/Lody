import { useCallback, useEffect, useReducer, useState } from 'react';
import { atom, useAtomValue } from 'jotai';
import { getSessionRoomId, type SessionId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import { useResolvedWorkspaceScope } from './use-resolved-workspace-scope';

const noSessionMeta = atom(undefined);

/**
 * Suggestion text this renderer already answered by sending a message, per
 * workspace/machine/session. Module-level so a remounted composer (tab switch)
 * does not bring an answered prediction back. Only a different upstream text
 * releases the mark: transient null routes must not resurrect the old hint.
 */
const answeredSuggestions = new Map<string, string>();
const answeredKey = (workspaceId: string, machineId: string, sessionId: string) =>
  JSON.stringify([workspaceId, machineId, sessionId]);

export type SessionPromptSuggestion = {
  /** Displayable advisory text, or null. */
  text: string | null;
  /**
   * Hide `answered` (the text shown when the user sent a message) until a
   * different suggestion arrives for this session.
   */
  markAnswered: (answered: string | null) => void;
};

/**
 * Advisory text is independent of the draft. Typing, clearing and accepting never
 * consume it; only an accepted send retires the text that was current at that time.
 */
export function useSessionPromptSuggestion(
  sessionId: SessionId | null | undefined
): SessionPromptSuggestion {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const scope = useResolvedWorkspaceScope();
  const meta = useAtomValue(
    sessionId ? sessionMetaAtomFamily(getSessionRoomId(sessionId)) : noSessionMeta
  );
  const machineId = meta?.machineId;
  const enabled = scope.enabled && runtime?.workspaceId === scope.workspaceId;
  const [snapshot, setSnapshot] = useState<{
    runtime: WorkspaceRuntime;
    sessionId: SessionId;
    machineId: string;
    text: string | null;
  } | null>(null);
  const [, rerender] = useReducer((count: number) => count + 1, 0);

  useEffect(() => {
    if (!enabled || !runtime || !sessionId || !machineId) return undefined;
    const key = answeredKey(runtime.workspaceId, machineId, sessionId);
    return runtime.subscribePromptSuggestion(machineId, sessionId, (text) => {
      if (text && text !== answeredSuggestions.get(key)) answeredSuggestions.delete(key);
      setSnapshot({ runtime, sessionId, machineId, text });
    });
  }, [enabled, runtime, sessionId, machineId]);

  const current =
    enabled &&
    snapshot?.runtime === runtime &&
    snapshot?.sessionId === sessionId &&
    snapshot?.machineId === machineId
      ? snapshot
      : null;
  const key = current
    ? answeredKey(current.runtime.workspaceId, current.machineId, current.sessionId)
    : null;
  const text =
    current?.text && key && answeredSuggestions.get(key) !== current.text ? current.text : null;

  const markAnswered = useCallback(
    (answered: string | null) => {
      if (!key || !answered) return;
      answeredSuggestions.set(key, answered);
      rerender();
    },
    [key]
  );

  return { text, markAnswered };
}
