import type { DragEventHandler, ReactNode, Ref } from 'react';

import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import {
  ConversationDropOverlay,
  type ConversationDropKind,
} from '@/components/shared/conversation-drop-overlay';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeSpace } from '../../style/theme-scale.stylex';

/**
 * Conversation-column width at which the IDE launcher and share pills appear.
 * Keep the pixel token in `SESSION_PAGE_HEADER_PILLS_CLASS` in lockstep —
 * Tailwind cannot interpolate this constant.
 */
export const SESSION_PAGE_HEADER_PILLS_MIN_WIDTH_PX = 800;

/** Named container so nested `@container`s cannot steal the page-width query. */
export const SESSION_PAGE_CONTAINER_CLASS = '@container/session-page';

/** `display: none` below the breakpoint; flex above. */
export const SESSION_PAGE_HEADER_PILLS_CLASS = 'hidden @[800px]/session-page:flex';

const styles = stylex.create({
  header: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    gap: themeSpace[1],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: themeColors.border,
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[2],
    flexShrink: 0,
    height: themeSpace[12],
  },
  /** A native shell insets the header by its own safe areas. */
  headerNative: {
    height: 'calc(3rem + var(--safe-area-top))',
    paddingTop: 'calc(0.5rem + var(--safe-area-top))',
    paddingLeft: 'calc(0.75rem + var(--safe-area-left))',
    paddingRight: 'calc(0.75rem + var(--safe-area-right))',
  },
  /** The macOS traffic lights need the title to start after them. */
  headerMacInset: { paddingLeft: themeSpace[20] },
  headerRow: {
    display: 'flex',
    width: '100%',
    minWidth: 0,
    flexDirection: { default: 'column', '@media (min-width: 640px)': 'row' },
    gap: themeSpace[2],
    alignItems: { default: 'stretch', '@media (min-width: 640px)': 'center' },
  },
  headerStart: {
    display: 'flex',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    minWidth: 0,
    alignItems: 'center',
    gap: themeSpace[2],
  },
  headerEnd: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[1],
  },
  messageArea: {
    position: 'relative',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    minHeight: 0,
  },
  page: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
  },
  pageFullHeight: { height: '100%' },
});

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
  const headerProps = stylex.props(
    styles.header,
    nativeApp && styles.headerNative,
    reserveMacTrafficLightInset && styles.headerMacInset
  );

  return (
    <div {...headerProps} className={clsx(SESSION_PAGE_CONTAINER_CLASS, headerProps.className)}>
      <div {...stylex.props(styles.headerRow)}>
        <div {...stylex.props(styles.headerStart)}>
          {startSlot}
          {titleSlot}
        </div>

        {desktopActionsSlot}

        <div {...stylex.props(styles.headerEnd)}>
          {menuSlot}
          {endSlot}
        </div>
      </div>
    </div>
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
      <div ref={messageAreaRef} {...stylex.props(styles.messageArea)}>
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
  const pageProps = stylex.props(styles.page, !hideMessageArea && styles.pageFullHeight);

  return (
    <div
      {...pageProps}
      className={clsx(pageProps.className, className)}
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
