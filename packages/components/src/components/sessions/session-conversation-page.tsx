import type { DragEventHandler, ReactNode, Ref } from 'react';

import {
  ConversationDropOverlay,
  type ConversationDropKind,
} from '@/components/shared/conversation-drop-overlay';
import { CardHeader } from '@/ui/card';
import { cn } from '@/lib/utils';
import { CHAT_WORKSPACE_RAIL_DISCOVERY_ATTRIBUTE } from '@/lib/chat-workspace-geometry';

export interface SessionConversationPageHeaderProps {
  titleSlot: ReactNode;
  startSlot?: ReactNode;
  desktopActionsSlot?: ReactNode;
  menuSlot?: ReactNode;
  endSlot?: ReactNode;
  nativeApp?: boolean;
  reserveMacTrafficLightInset?: boolean;
}

export function SessionConversationPageHeader({
  titleSlot,
  startSlot,
  desktopActionsSlot,
  menuSlot,
  endSlot,
  nativeApp = false,
  reserveMacTrafficLightInset = false,
}: SessionConversationPageHeaderProps) {
  return (
    <CardHeader
      className={cn(
        'flex flex-col justify-center gap-1 border-b border-border px-3 py-2 shrink-0 h-12',
        nativeApp &&
          'h-[calc(3rem+var(--safe-area-top))] pt-[calc(0.5rem+var(--safe-area-top))] pl-[calc(0.75rem+var(--safe-area-left))] pr-[calc(0.75rem+var(--safe-area-right))]',
        reserveMacTrafficLightInset && 'pl-20'
      )}
    >
      <div className={cn('flex w-full min-w-0 flex-col gap-2 sm:flex-row sm:items-center')}>
        <div className="flex flex-1 min-w-0 items-center gap-2">
          {startSlot}
          {titleSlot}
        </div>

        {desktopActionsSlot}

        <div className="flex shrink-0 items-center gap-1">
          {menuSlot}
          {endSlot}
        </div>
      </div>
    </CardHeader>
  );
}

export interface SessionConversationPageBodyProps {
  pinSlot?: ReactNode;
  goalBannerSlot?: ReactNode;
  messageAreaRef?: Ref<HTMLDivElement>;
  searchSlot?: ReactNode;
  streamSlot: ReactNode;
  permissionSlot?: ReactNode;
  notificationSlot?: ReactNode;
  composerSlot?: ReactNode;
}

export function SessionConversationPageBody({
  pinSlot,
  goalBannerSlot,
  messageAreaRef,
  searchSlot,
  streamSlot,
  permissionSlot,
  notificationSlot,
  composerSlot,
}: SessionConversationPageBodyProps) {
  return (
    <>
      {pinSlot}
      {goalBannerSlot}
      <div
        ref={messageAreaRef}
        {...{ [CHAT_WORKSPACE_RAIL_DISCOVERY_ATTRIBUTE]: 'session.messages' }}
        className="relative flex-1 min-h-0"
      >
        {searchSlot}
        {streamSlot}
      </div>
      {permissionSlot}
      {notificationSlot}
      {composerSlot}
    </>
  );
}

export interface SessionConversationPageProps {
  className?: string;
  /** Highlights the page while an accepted drag (attachment or session) is over it. */
  dropActive?: boolean;
  dropKind?: ConversationDropKind;
  headerSlot?: ReactNode;
  subHeaderSlot?: ReactNode;
  hideMessageArea?: boolean;
  bodySlot?: ReactNode;
  trailingSlot?: ReactNode;
  children?: ReactNode;
  onDragEnter?: DragEventHandler<HTMLDivElement>;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  onDragLeave?: DragEventHandler<HTMLDivElement>;
  onDrop?: DragEventHandler<HTMLDivElement>;
}

export function SessionConversationPage({
  className,
  dropActive = false,
  dropKind = 'session-mention',
  headerSlot,
  subHeaderSlot,
  hideMessageArea = false,
  bodySlot,
  trailingSlot,
  children,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
}: SessionConversationPageProps) {
  return (
    <div
      {...{ [CHAT_WORKSPACE_RAIL_DISCOVERY_ATTRIBUTE]: 'session.page' }}
      className={cn('relative flex flex-col', hideMessageArea ? '' : 'h-full', className)}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <ConversationDropOverlay active={dropActive} kind={dropKind} />
      {children ?? (
        <>
          {headerSlot}
          {subHeaderSlot}
          {hideMessageArea ? null : bodySlot}
          {trailingSlot}
        </>
      )}
    </div>
  );
}
