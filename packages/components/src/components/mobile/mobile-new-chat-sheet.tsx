import { Fragment, type ComponentType, type ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';

import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { useKeyboardAwareSheet } from '@/hooks/use-keyboard-aware-scroll-into-view';
import { cn } from '@/lib/utils';

export type MobileNewChatSheetLabels = {
  /** Sheet title, announced by the sr-only `DrawerTitle`. */
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
  /** Header centre: the unified Chat / project / repository picker. */
  targetNode: ReactNode;
  /** The full-height composer. Its footer carries the run config, machine,
     branch and worktree controls; the sheet only owns the page. */
  composer: ReactNode;
  /** Optional wrapper that scopes a region, kept for hosts that still mount
     inline pickers inside the composer. Defaults to `Fragment`. */
  coordinator?: ComponentType<{ children: ReactNode }>;
  className?: string;
  scrollAreaClassName?: string;
};

/**
 * Full-height writing surface for a new conversation.
 *
 * The header holds one native target picker; the body is a single composer
 * whose prompt fills the page and whose footer is a scrolling control rail.
 * Execution settings (machine, branch, worktree) therefore never sit between
 * the user and the place they write.
 *
 * Layout adapted from the community contribution in
 * [#491](https://github.com/LodyAI/Lody/pull/491) by @natsustan.
 */
export function MobileNewChatSheet({
  open,
  onOpenChange,
  ...contentProps
}: MobileNewChatSheetProps) {
  const title = contentProps.labels?.title ?? '新建对话';
  const keyboard = useKeyboardAwareSheet();

  return (
    <Drawer open={open} onOpenChange={onOpenChange} repositionInputs={false}>
      <DrawerContent
        className={cn(
          'mobile-new-chat-sheet mt-0! h-[calc(92dvh-var(--native-keyboard-height,0px))]! max-h-[92dvh]! overflow-hidden rounded-t-[2rem]! border-border/60',
          keyboard.contentClassName
        )}
      >
        <DrawerTitle className="sr-only">{title}</DrawerTitle>
        <DrawerDescription className="sr-only">
          {contentProps.labels?.description ?? title}
        </DrawerDescription>
        <MobileNewChatSheetContent
          {...contentProps}
          onClose={() => onOpenChange(false)}
          className={cn('min-h-0 flex-1', contentProps.className)}
        />
      </DrawerContent>
    </Drawer>
  );
}

export function MobileNewChatSheetContent({
  labels = {},
  targetNode,
  composer,
  coordinator: Coordinator = Fragment,
  className,
  scrollAreaClassName,
  onClose,
}: MobileNewChatSheetContentProps & { onClose?: () => void }) {
  const keyboard = useKeyboardAwareSheet({ chromeHeight: '4rem', bodyPadding: '8px' });

  return (
    <div className={cn('flex min-h-0 flex-col bg-background text-foreground', className)}>
      <Coordinator>
        <header className="relative flex h-16 shrink-0 items-center justify-center px-16">
          <button
            type="button"
            aria-label={labels.backAriaLabel ?? 'Back'}
            className="absolute left-4 flex h-11 w-11 items-center justify-center rounded-full border border-border/60 bg-background text-foreground transition-colors hover:bg-muted/60"
            onClick={() => onClose?.()}
          >
            <ChevronLeft className="h-6 w-6" aria-hidden="true" />
          </button>
          <div
            data-vaul-no-drag=""
            className="flex min-w-0 max-w-full justify-center text-xl font-semibold"
          >
            {targetNode}
          </div>
        </header>
        {labels.description ? (
          <p className="px-4 text-xs text-muted-foreground">{labels.description}</p>
        ) : null}
        <div
          ref={keyboard.scrollRef}
          data-vaul-no-drag=""
          className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto', scrollAreaClassName)}
          style={keyboard.scrollStyle}
        >
          {composer}
        </div>
      </Coordinator>
    </div>
  );
}
