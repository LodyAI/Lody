import { Fragment, useRef, type ComponentType, type ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { getSessionChatInputAreaShellClassName } from '@/components/chat/composer-surface';
import { BaseHeader } from '@/components/page-headers/base-header';
import { MobileSessionHeaderBackButton } from '@/components/mobile/glass-icon-button';
import { SessionConversationPage } from '@/components/sessions/session-conversation-page';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { isNativeAppShell } from '@/lib/native-platform';
import { useKeyboardAwareScrollIntoView } from '@/hooks/use-keyboard-aware-scroll-into-view';

export type MobileNewChatSheetLabels = {
  /** Accessible page title. */
  title?: string;
  description?: string;
  backAriaLabel?: string;
};

export type MobileNewChatSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & MobileNewChatSheetContentProps;

export type MobileNewChatSheetContentProps = {
  labels?: MobileNewChatSheetLabels;
  /** Header content for the new-chat page. */
  targetNode: ReactNode;
  /** Session-style composer anchored at the bottom. */
  composer: ReactNode;
  /** In-flow selection controls above the composer. */
  summary?: ReactNode;
  /** Optional wrapper that scopes a region, kept for hosts that still mount
     inline pickers inside the composer. Defaults to `Fragment`. */
  coordinator?: ComponentType<{ children: ReactNode }>;
  className?: string;
  scrollAreaClassName?: string;
};

/** New-chat page over the still-mounted mobile home or project screen. */
export function MobileNewChatSheet({
  open,
  onOpenChange,
  ...contentProps
}: MobileNewChatSheetProps) {
  if (!open) return null;
  return (
    <MobileNewChatSheetContent
      {...contentProps}
      onClose={() => onOpenChange(false)}
      className={cn('fixed inset-0 z-50', contentProps.className)}
    />
  );
}

export function MobileNewChatSheetContent({
  labels = {},
  targetNode,
  composer,
  summary,
  coordinator: Coordinator = Fragment,
  className,
  scrollAreaClassName,
  onClose,
}: MobileNewChatSheetContentProps & { onClose?: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useKeyboardAwareScrollIntoView(scrollRef);
  const headerInset = isNativeAppShell() ? 'calc(3rem + var(--safe-area-top, 0px))' : '3rem';
  return (
    <div className={cn('flex min-h-0 flex-col bg-background text-foreground', className)}>
      <Coordinator>
        <SessionConversationPage className="min-h-0 flex-1">
          <BaseHeader
            truncateTitle={false}
            hideMenuButton
            className="absolute inset-x-0 top-0 z-30 border-b-0 bg-background/55 backdrop-blur-xl"
            style={{ height: headerInset, paddingTop: 'var(--safe-area-top, 0px)' }}
            leading={
              <MobileSessionHeaderBackButton
                label={labels.backAriaLabel}
                onBack={() => onClose?.()}
              />
            }
            title={targetNode}
          />
          <div
            ref={scrollRef}
            className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto', scrollAreaClassName)}
            style={{ paddingTop: headerInset, scrollPaddingTop: headerInset }}
          >
            {labels.description ? (
              <p className="text-xs text-muted-foreground">{labels.description}</p>
            ) : null}
            <div className="min-h-6 flex-1" />
            <ConversationColumn>{summary}</ConversationColumn>
            <div className="h-6 shrink-0" />
          </div>
          <div className={getSessionChatInputAreaShellClassName({ protectFromEdgeBackZone: true })}>
            <ConversationColumn>{composer}</ConversationColumn>
          </div>
        </SessionConversationPage>
      </Coordinator>
    </div>
  );
}
