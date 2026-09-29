/**
 * Types of the conversation scroll engine. Design and invariants:
 * `.agents/notes/implemented/architecture/2026-09-27-conversation-scroll-engine.md`.
 */

/**
 * The fixed rows that are not turn rows and may render at zero height: the
 * coverage lemma's exempt set K, whose size widens its worst-case window.
 */
export const FIXED_ROW_KINDS = ['leading', 'agent-activity', 'trailing'] as const;
export type FixedRowKind = (typeof FIXED_ROW_KINDS)[number];

/**
 * What the engine knows about one list row. Rows are listed in display order;
 * `key` is the React key and is stable while the row is.
 */
export interface EngineRow {
  key: string;
  /** Owning turn; null for the fixed rows. */
  turnId: string | null;
  /** Absolute turn index, for ordering fallbacks; -1 for the fixed rows. */
  turnIndex: number;
  /** The history item this row renders on its own, when it renders exactly one. */
  itemIndex: number | null;
  /** A stable id of that item where it has one (a tool call id). */
  itemIdentity: string | null;
  /** The lowest item index this row covers, for folded groups; null when none. */
  firstItemIndex: number | null;
  /** A turn that is not hydrated renders as one placeholder row. */
  placeholder: boolean;
  fixed: FixedRowKind | null;
  /** Height to assume before the row is measured. */
  estimate: number;
}

export type ReadingAnchor =
  | {
      kind: 'turn';
      turnId: string;
      turnIndex: number;
      /** A fast path: the row the anchor was taken from, if it still exists. */
      rowKey: string;
      item: { index: number; identity: string | null } | null;
      /** Pixels from the anchor row's top to the anchored screen line. */
      offsetPx: number;
    }
  | { kind: 'fixed-row'; fixed: FixedRowKind; offsetPx: number };

export type Intent =
  | { kind: 'follow' }
  | { kind: 'read'; anchor: ReadingAnchor; screenY: number }
  | { kind: 'sent'; rowKey: string };

export type StickyMode = 'follow' | 'read' | 'sent';

/** One cycle's committed view of the scroller (I2). */
export interface ScrollSnapshot {
  sourceGeneration: number;
  geometryRevision: number;
  scrollTop: number;
  viewportHeight: number;
  extent: number;
  contentTop: number;
  replyRoom: number;
}

export type MovementClass = 'none' | 'own-write' | 'reader' | 'clamp' | 'unknown';

/** Per-cycle diagnostic entry; geometry only, never message text. */
export interface CycleDiagnostic {
  reason: string;
  intent: StickyMode;
  movement: MovementClass;
  target: number;
  actual: number;
  clamped: boolean;
  supplementaryCommits: number;
  passes: number;
  covered: boolean;
  pendingExternalMove: boolean;
  /** The reading anchor's recorded row and the row it resolved to (ids only). */
  anchorKey: string | null;
  resolvedKey: string | null;
}

export interface SavedScrollState {
  formatVersion: 1;
  intent: Extract<Intent, { kind: 'follow' | 'read' }>;
  sizes: { layoutVersion: string; keys: string[]; sizes: number[] } | null;
}
