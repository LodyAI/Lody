import { Fragment, useRef, type ComponentType, type CSSProperties, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';

import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { MobileInlinePickerRowSlot } from '@/components/mobile/mobile-inline-picker';
import { useKeyboardAwareScrollIntoView } from '@/hooks/use-keyboard-aware-scroll-into-view';
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
  /** Target row: machine selector on the left. */
  machineNode: ReactNode;
  /** Target row: compact Work / Chat switcher on the right. */
  contextTypeNode: ReactNode;
  /** Unified local-project / GitHub-repository picker. Pass `null` for Chat. */
  perTypeNode?: ReactNode | null;
  /** Optional branch picker rendered beside the unified project picker. */
  branchNode?: ReactNode | null;
  /** Local-only Worktree toggle rendered inline with the project target. */
  secondaryPerTypeNode?: ReactNode | null;
  /** The composer itself — already wired with footer / bottomBar slots. */
  composer: ReactNode;
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

/**
 * Bottom sheet that hosts the "new chat" composer flow on mobile home.
 *
 * Layout stacks top-to-bottom per the design comp: machine + Work/Chat →
 * unified project + optional branch / Worktree toggle → composer (footer holds the same
 * `MobileSessionRunConfig` face as the in-session chat). Each row
 * stays compact and lets the selected values provide their own context.
 */
export function MobileNewChatSheet({
  open,
  onOpenChange,
  ...contentProps
}: MobileNewChatSheetProps) {
  const title = contentProps.labels?.title ?? '新建对话';
  const description = contentProps.labels?.description;

  return (
    <Drawer open={open} onOpenChange={onOpenChange} repositionInputs={false}>
      {/* Adaptive height: only cap the maximum so every context follows its
         actual rows and composer height without leaving blank sheet space. */}
      {/* Shift the whole drawer up by the soft-keyboard height on iOS
         Capacitor so the textarea + footer stay above the keyboard. The
         `--native-keyboard-height` CSS var is `0px` on web and Android;
         Android relies on native WebView resize instead (the main layout
         uses this var globally, but vaul renders the drawer through a
         portal so the root keyboard-padding utility doesn't reach it).

         iOS keyboard animates over ~250-350ms with a custom curve.
         We match it via the inline `style.transition` (Tailwind's
         `transition-[bottom]` was being overridden by Vaul's own
         transition declaration) and bump duration to 320ms so the
         lift lands roughly in sync with the keyboard finishing its
         own slide-up. Vaul's open/close uses `translate-y`
         (orthogonal property), so the two animations don't fight. */}
      <DrawerContent
        className={cn(
          'mobile-new-chat-sheet',
          'h-auto! max-h-[92dvh]! rounded-t-2xl border-border/60',
          'bottom-[var(--native-keyboard-height,0px)]!'
        )}
        style={{
          transition: 'bottom 320ms cubic-bezier(0.32, 0.72, 0, 1)',
          willChange: 'bottom',
        }}
      >
        <DrawerTitle className="sr-only">{title}</DrawerTitle>
        <DrawerDescription className="sr-only">{description ?? title}</DrawerDescription>
        <MobileNewChatSheetContent
          {...contentProps}
          onClose={() => onOpenChange(false)}
          className={cn('max-h-full', contentProps.className)}
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
  const description = labels.description;
  const closeAriaLabel = labels.closeAriaLabel ?? 'Close';
  /* Keep the focused composer centered above the native keyboard so the
     footer run-config control isn't left hidden. */
  const scrollRef = useRef<HTMLDivElement>(null);
  useKeyboardAwareScrollIntoView(scrollRef);

  return (
    <div className={cn('flex min-h-0 flex-col bg-background text-foreground', className)}>
      <header className="relative flex items-center px-4 pb-2 pt-2">
        <h2 className="mx-auto select-none text-[0.95rem] font-semibold tracking-tight">{title}</h2>
        {showCloseButton ? (
          <button
            type="button"
            aria-label={closeAriaLabel}
            className={cn(
              'absolute right-3 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full',
              'text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground',
              '[-webkit-app-region:no-drag]'
            )}
            onClick={onClose}
          >
            <X className="h-5 w-5" aria-hidden="true" strokeWidth={1.8} />
          </button>
        ) : null}
      </header>
      <p className={cn(description ? 'px-4 pb-1 text-xs text-muted-foreground' : 'sr-only')}>
        {description ?? title}
      </p>

      <Coordinator>
        <div
          ref={scrollRef}
          className={cn(
            'min-h-0 flex-1 overflow-y-auto px-4',
            /* Bottom padding is keyboard-aware: when the soft
               keyboard is down, we need `safe-area-bottom + 12px`
               so the last row clears the iOS home indicator. When
               the keyboard is up, the home indicator is hidden
               behind the keyboard so the safe-area portion is
               wasted space — it pushes the picker's bottom-anchored
               search input ~46px above the keyboard, leaving the
               visible gap the user reported. `max(safe - keyboard,
               0)` collapses that portion to 0 as soon as the
               keyboard rises past the safe area, leaving only the
               12px breathing buffer. */
            'pb-[calc(12px+max(0px,var(--safe-area-bottom,0px)-var(--native-keyboard-height,0px)))]',
            scrollAreaClassName
          )}
          /* Cap the scroll container's height to the *visible*
             drawer area: viewport minus the soft keyboard and the
             header. Without this cap the container stretches to
             fit content and `scrollIntoView` becomes a no-op —
             the search input's siblings (branch row / composer
             / agent chips) just stack between the search and the
             keyboard. With this cap, content overflows the
             container, and `PickerSearchInput`'s
             `scrollIntoView({ block: 'end' })` pulls the search
             row to the very bottom of the visible drawer area —
             i.e. flush against the top of the keyboard.
             `3.25rem` matches the header (`h-9` close button +
             `pt-2 + pb-2` ≈ 52px). */
          style={{
            maxHeight: 'calc(100dvh - var(--native-keyboard-height, 0px) - 3.25rem)',
            ...scrollAreaStyle,
          }}
        >
          {/* The project target row mounts / unmounts as the user switches
             between Work and Chat. Local and GitHub share one project picker.
             `AnimatePresence` + height-animated wrappers slide the
             rows in / out so the surrounding stack ripples smoothly
             rather than snapping. */}
          <div className="flex flex-col pb-2 pt-1">
            <AnimatedSheetRow alwaysOn>
              <TargetRow>
                <div className="min-w-0 flex-1">{machineNode}</div>
                <div className="shrink-0">{contextTypeNode}</div>
              </TargetRow>
            </AnimatedSheetRow>
            <AnimatePresence initial={false}>
              {perTypeNode || secondaryPerTypeNode ? (
                <AnimatedSheetRow key="per-type">
                  <TargetRow>
                    <div
                      className={cn('min-w-0 shrink', branchNode ? 'max-w-[42%]' : 'max-w-[70%]')}
                    >
                      {perTypeNode}
                    </div>
                    {branchNode ? <div className="min-w-0 flex-1">{branchNode}</div> : null}
                    {secondaryPerTypeNode ? (
                      <div className="ml-auto shrink-0 self-center">{secondaryPerTypeNode}</div>
                    ) : null}
                  </TargetRow>
                </AnimatedSheetRow>
              ) : null}
            </AnimatePresence>
          </div>

          <div className="pt-0.5">{composer}</div>

          {belowComposerNode ? (
            /* Vertical-rhythm wrapper only; the slot owns horizontal
               layout (e.g. agent left vs permission right). */
            <div className="px-1 pt-2">{belowComposerNode}</div>
          ) : null}
        </div>
      </Coordinator>
    </div>
  );
}

/* Wrapper that animates a row's mount / unmount via height accordion.
   `alwaysOn` skips the AnimatePresence-driven mount transition (for
   rows that are always rendered like machine + type) but keeps the
   `pt-1` rhythm so the spacing stays consistent with the rows that
   do animate in.

   We bake `pt-1` into the wrapper instead of using parent `gap-1`
   because gap doesn't animate with height — when a row mounts from
   height 0, the gap above it pops in instantly while the row's body
   grows, which looks jumpy. Putting the spacing inside the animated
   container makes it grow with the row. */
function AnimatedSheetRow({
  children,
  alwaysOn = false,
}: {
  children: ReactNode;
  alwaysOn?: boolean;
}) {
  if (alwaysOn) {
    return <div className="pt-1 first:pt-0">{children}</div>;
  }
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
      className="overflow-hidden"
    >
      <div className="pt-1">{children}</div>
    </motion.div>
  );
}

/* Compact target row. The slot still lets a richer picker project a full-width
   panel below the row if a host supplies one instead of a native select. */
function TargetRow({ children }: { children: ReactNode }) {
  return (
    <MobileInlinePickerRowSlot>
      <div className="flex min-w-0 items-stretch gap-1 rounded-xl px-1 py-0.5">{children}</div>
    </MobileInlinePickerRowSlot>
  );
}
