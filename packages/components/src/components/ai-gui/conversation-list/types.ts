import type { ComponentType, CSSProperties, ReactElement, ReactNode, Ref, RefObject } from 'react';
import type { SessionId } from '@lody/shared';
import type { EngineRow } from '@/lib/conversation-scroll/types';

/** Props the list passes to the component that wraps each row. */
export interface ConversationRowComponentProps {
  index: number;
  style: CSSProperties;
  children: ReactNode;
  ref?: Ref<HTMLDivElement>;
}

export type ConversationRowComponent = ComponentType<ConversationRowComponentProps>;

/**
 * How `SessionChatStreamView` talks to the conversation scroll engine's list:
 * the outline, visible-turn reports and native selection read positions and
 * issue commands only through this handle.
 *
 * `scrollOffset` is the viewport's scrollTop; item offsets start at the rows
 * container's top (the viewport's top padding is not included; the view
 * measures that delta itself).
 */
export interface ConversationListHandle {
  readonly scrollOffset: number;
  readonly scrollSize: number;
  readonly viewportSize: number;
  findItemIndex(offset: number): number;
  getItemOffset(index: number): number;
  getItemSize(index: number): number;
  /** Put row `index` (a list index, leading row included) at the viewport's top edge. */
  scrollRowToTop(index: number, options: { smooth: boolean; offset: number }): void;
  /** Force the bottom and re-enable follow. */
  scrollToBottom(): void;
  /** Hold a just-sent row at the top with the reply room reserved below it. */
  anchorToRow(index: number): void;
  /** The held row's index after rows above it changed; negative when it is gone. */
  retargetAnchor(index: number): void;
}

export interface ConversationScrollerState {
  scrollElement: HTMLDivElement | null;
  /** The initial position is applied and the conversation may be shown. */
  revealed: boolean;
  /** Following the end, or holding a sent message. */
  isSticky: boolean;
}

export interface ConversationScrollerProps {
  sessionId: SessionId;
  /** Keyed row elements in list order: leading row, conversation rows, activity row. */
  rows: readonly ReactElement[];
  /** What the engine knows about each row, aligned with `rows`. */
  rowMeta: readonly EngineRow[];
  item: ConversationRowComponent;
  /** List indexes native selection needs mounted; must commit synchronously. */
  keepMounted?: readonly number[];
  initialWindowReady: boolean;
  /**
   * The viewport is off screen with no layout box (an inactive tab kept
   * mounted under `display: none`, a collapsed panel). The engine pauses until
   * it is shown again.
   */
  hidden?: boolean;
  /** Every reason the view has to stop follow-output (selection, jumps, search). */
  suppressAutoScrollRef?: RefObject<boolean>;
  onAtBottomChange?: (atBottom: boolean) => void;
  onScroll?: (offset: number) => void;
  onStateChange: (state: ConversationScrollerState) => void;
  /** Conversation font setting; part of the engine's layout version. */
  layoutKey: string;
  viewportClassName?: string;
  viewportStyle?: CSSProperties;
  /** Rendered after the reply room, inside the viewport (never a list row). */
  trailing?: ReactNode;
  bufferSize: number;
  handleRef: RefObject<ConversationListHandle | null>;
}
