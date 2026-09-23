import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { AgentRoleId, SessionId } from '@lody/shared';

/**
 * Explicit Role choices made in existing-session composers.
 *
 * Session surfaces are unmounted when navigation moves between top-level
 * Sessions, so component-local state cannot own this identity. Absence means
 * "use the latest durable Turn (then creation provenance for legacy Turns)";
 * null inside an override is an explicit None choice. The known logical Turn
 * lineage fences a draft so a newer accepted/queued Turn from this or another
 * client wins without mistaking queue promotion/reordering for a new Turn.
 */
export const sessionAgentRoleSelectionAtomFamily = atomFamily((_sessionId: SessionId) =>
  atom<
    | {
        roleId: AgentRoleId | null;
        /** Logical durable Turns visible when this unsent choice was made. */
        basedOnTurnKeys: readonly string[];
      }
    | undefined
  >(undefined)
);

/**
 * Last fully hydrated durable Role selection for a Session.
 *
 * `useSessionDoc` briefly exposes an empty fallback document when a Session
 * composer remounts. This cache bridges only that loading window; once the
 * document is ready its Turn inputConfig is authoritative again. Keeping the
 * logical Turn lineage beside the three-state Role value prevents queue
 * lifecycle changes from looking like newer accepted input.
 */
export const sessionAgentRoleDurableSnapshotAtomFamily = atomFamily((_sessionId: SessionId) =>
  atom<
    | {
        roleId: AgentRoleId | null | undefined;
        roleRevision: number | undefined;
        currentTurnKey: string | null;
        knownTurnKeys: readonly string[];
      }
    | undefined
  >(undefined)
);
