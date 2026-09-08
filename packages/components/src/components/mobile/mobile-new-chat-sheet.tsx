import { Fragment, type ComponentType, type CSSProperties, type ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';

import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { useKeyboardAwareSheet } from '@/hooks/use-keyboard-aware-scroll-into-view';
import { cn } from '@/lib/utils';

export type MobileNewChatSheetLabels = {
  title?: string;
  description?: string;
  closeAriaLabel?: string;
  /** @deprecated Target rows no longer render separate labels. */
  machineLabel?: string;
  /** @deprecated Work / Chat is rendered inline with the machine. */
  contextTypeLabel?: string;
  /** @deprecated The unified project control identifies itself. */
  perTypeLabel?: string;
  /** @deprecated Branch is rendered beside the project. */
  branchLabel?: string;
  /** @deprecated Workdir mode is rendered without a separate label. */
  secondaryPerTypeLabel?: string;
};

export type MobileNewChatSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & MobileNewChatSheetContentProps;

export type MobileNewChatSheetContentProps = {
  labels?: MobileNewChatSheetLabels;
  /** Optional machine selector in the bottom rail. */
  machineNode: ReactNode;
  /** @deprecated Context now belongs to the header picker; retained for existing hosts. */
  contextTypeNode?: ReactNode;
  /** Unified context picker: no project (Chat), local projects, and GitHub repositories. */
  perTypeNode?: ReactNode | null;
  /** Optional branch picker in the bottom rail. */
  branchNode?: ReactNode | null;
  /** Local-only Worktree toggle in the bottom rail. */
  secondaryPerTypeNode?: ReactNode | null;
  /** Render a sheet composer with these target controls in its footer rail. */
  composer: ReactNode | ((targetControls: ReactNode) => ReactNode);
  /** Optional cluster below the composer. Usually empty now that run
     config (agent/model/mode/…) lives in the composer footer via
     `MobileSessionRunConfig`; kept for hosts that still need a slot. */
  belowComposerNode?: ReactNode;
  /** Optional wrapper that scopes a region — e.g. a
     `MobileInlinePickerCoordinator` that enforces only-one-open across
     the pickers inside the sheet. Defaults to `Fragment` (no wrapping).
     The wrapper must accept `children` and render them in place. */
  coordinator?: ComponentType<{ children: ReactNode }>;
  /** Optional close affordance for the host surface. */
  onClose?: () => void;
  /** Hide the close button when the host already owns window chrome. */
  showCloseButton?: boolean;
  className?: string;
  scrollAreaClassName?: string;
  scrollAreaStyle?: CSSProperties;
};

/** Full-height writing surface; execution controls belong to its bottom rail. */
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
  machineNode,
  contextTypeNode,
  perTypeNode = null,
  branchNode = null,
  secondaryPerTypeNode = null,
  composer,
  belowComposerNode,
  coordinator: Coordinator = Fragment,
  onClose,
  showCloseButton = true,
  className,
  scrollAreaClassName,
  scrollAreaStyle,
}: MobileNewChatSheetContentProps) {
  const title = labels.title ?? '新建对话';
  const keyboard = useKeyboardAwareSheet({ chromeHeight: '5rem', bodyPadding: '8px' });
  const targets = (
    <>
      {[machineNode, branchNode, secondaryPerTypeNode, contextTypeNode].map((node, index) =>
        node ? (
          <div
            key={index}
            className="flex h-10 max-w-[min(18rem,70vw)] shrink-0 items-center rounded-full border border-border/60 bg-muted/50 px-2"
          >
            {node}
          </div>
        ) : null
      )}
    </>
  );
  return (
    <div className={cn('flex min-h-0 flex-col bg-background text-foreground', className)}>
      <Coordinator>
        <header className="relative flex h-16 shrink-0 items-center justify-center px-16">
          {showCloseButton ? (
            <button
              type="button"
              aria-label={labels.closeAriaLabel ?? 'Close'}
              className="absolute left-4 flex h-11 w-11 items-center justify-center rounded-full border border-border/60 bg-background text-foreground hover:bg-muted/60"
              onClick={onClose}
            >
              <ChevronLeft className="h-6 w-6" aria-hidden="true" />
            </button>
          ) : null}
          <div className="flex min-w-0 max-w-full justify-center text-lg font-semibold">
            {perTypeNode ?? <h2 className="truncate">{title}</h2>}
          </div>
        </header>
        {labels.description ? (
          <p className="px-4 text-xs text-muted-foreground">{labels.description}</p>
        ) : null}
        <div
          ref={keyboard.scrollRef}
          data-vaul-no-drag
          className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto', scrollAreaClassName)}
          style={{ ...keyboard.scrollStyle, ...scrollAreaStyle }}
        >
          {typeof composer === 'function' ? (
            composer(targets)
          ) : (
            <>
              <div className="flex min-h-0 flex-1 flex-col">{composer}</div>
              <div className="flex shrink-0 gap-2 overflow-x-auto border-t border-border/60 px-3 py-2">
                {targets}
              </div>
            </>
          )}
          {belowComposerNode ? <div className="shrink-0 px-3 pt-2">{belowComposerNode}</div> : null}
        </div>
      </Coordinator>
    </div>
  );
}
