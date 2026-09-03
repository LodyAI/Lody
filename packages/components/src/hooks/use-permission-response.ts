import { useCallback } from 'react';
import { useAtomValue } from 'jotai';
import type { SessionId, PermissionOutcome } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';

/**
 * Hook to handle permission responses by authoring the outcome through the
 * WorkspaceWriter seam: locate the tool_call whose `permissionRequest.requestId`
 * matches and write its outcome — reliable multi-device sync via CRDT.
 */
export function usePermissionResponse() {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);

  const respondToPermission = useCallback(
    async (
      sessionId: SessionId,
      requestId: string,
      outcome: PermissionOutcome,
      options?: { turnId?: string }
    ): Promise<void> => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }

      // Awaiting the writer call is the accept boundary: the local authored
      // write is durable, so there's no need to block on remote sync. The
      // turn id lets the writer address the turn instead of scanning history.
      await runtime.writer.respondSessionPermission(
        sessionId,
        requestId,
        outcome as unknown as Record<string, unknown>,
        options
      );
    },
    [runtime]
  );

  return { respondToPermission, isReady: !!runtime };
}
