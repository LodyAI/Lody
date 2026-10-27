import {
  Fragment,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { PopupContainerProvider } from '@lody/ui/popup-container';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';

import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { MobileInlinePickerRowSlot } from '@/components/mobile/mobile-inline-picker';
import { useKeyboardAwareScrollIntoView } from '@/hooks/use-keyboard-aware-scroll-into-view';
import { withClassName } from '@/lib/stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeFontWeight, themeRadius, themeSpace } from '../../style/theme-scale.stylex';
import { sheetSurface } from './sheet-surface';

export type MobileNewChatSheetLabels = {
  title?: string;
  description?: string;
  closeAriaLabel?: string;
  machineLabel?: string;
  contextTypeLabel?: string;
  /** Primary per-type row label — just the project / repo name now
     (branch lives on its own row, see `branchLabel`). Parent picks
     the wording (e.g. "项目" / "仓库"). */
  perTypeLabel?: string;
  /** Branch row label, shown on the row below the project/repo when
     a branch picker is wired. Defaults to "分支". */
  branchLabel?: string;
  /** Secondary per-type row label, used by local context for the worktree
     mode pill. Optional — collapsed when `secondaryPerTypeNode` is null. */
  secondaryPerTypeLabel?: string;
};

export type MobileNewChatSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & MobileNewChatSheetContentProps;

export type MobileNewChatSheetContentProps = {
  labels?: MobileNewChatSheetLabels;
  /** Row 1: machine pill / selector. */
  machineNode: ReactNode;
  /** Row 2: project type (3-icon) pill switcher. */
  contextTypeNode: ReactNode;
  /** Row 3: the project (local) or repo (github) picker on its own
     row — branch moved to its own row below so neither chip gets
     truncated on narrow phones. Pass `null` to collapse (chat
     context has no target). */
  perTypeNode?: ReactNode | null;
  /** Row 4 (optional): branch picker, only shown when a project /
     repo with branches is selected. Splitting it off from
     `perTypeNode` was the user's call — easier to read at a glance
     than two side-by-side chips. */
  branchNode?: ReactNode | null;
  /** Row 5 (local-only): workdir mode toggle (本地文件 / 新工作树).
     Renders only when the caller hands a node — github and chat
     contexts pass `null`. */
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

const styles = stylex.create({
  /** The sheet's column. */
  root: {
    display: 'flex',
    minHeight: 0,
    maxHeight: '100%',
    flexDirection: 'column',
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  /** The sheet's title. */
  title: { userSelect: 'none' },
  /** The close chip in the header's corner. */
  closeChip: { WebkitAppRegion: 'no-drag' },
  /** The sheet's description, under the header. */
  description: {
    paddingInline: themeSpace[4],
    paddingBottom: themeSpace[1],
    fontSize: '0.75rem',
    lineHeight: 'calc(1 / 0.75)',
    color: themeColors.mutedForeground,
  },
  /** The scrolling area. */
  scroll: {
    minHeight: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflowY: 'auto',
    paddingInline: themeSpace[4],
    paddingBottom:
      'calc(12px + max(0px, var(--safe-area-bottom, 0px) - var(--native-keyboard-height, 0px)))',
  },
  /** The labelled rows above the composer. */
  rows: {
    display: 'flex',
    flexDirection: 'column',
    paddingTop: themeSpace[1],
    paddingBottom: themeSpace[3],
  },
  /** A row that animates in and out. */
  animatedRow: { overflow: 'hidden' },
  /** The space a row keeps above it. */
  rowRhythm: { paddingTop: themeSpace[1.5] },
  /** The space the first row keeps above it — the first one hugs the header. */
  rowRhythmFirst: {
    paddingTop: themeSpace[1.5],
    ':first-child': { paddingTop: 0 },
  },
  /** The composer's own space. */
  composer: { paddingTop: themeSpace[1] },
  /** The cluster below the composer. */
  belowComposer: {
    paddingInline: themeSpace[1],
    paddingTop: themeSpace[2],
  },
  /** A labelled row: the label, then the value column. */
  row: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'stretch',
    gap: themeSpace[3],
    paddingInline: themeSpace[3],
    paddingTop: themeSpace[1.5],
    paddingBottom: themeSpace[1.5],
    borderRadius: themeRadius.xl,
    backgroundColor: themeColors.card,
    boxShadow: '0 0 0 1px hsl(var(--border) / 0.6)',
  },
  /** The label column: a fixed width, so every value starts at the same x. */
  rowLabel: {
    width: '4rem',
    flexShrink: 0,
    alignSelf: 'center',
    fontSize: '0.72rem',
    fontWeight: themeFontWeight.semibold,
    letterSpacing: '0.025em',
    color: themeColors.mutedForeground,
  },
  /** The value column. */
  rowValue: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
  },
});

/**
 * Bottom sheet that hosts the "new chat" composer flow on mobile home.
 *
 * Layout stacks top-to-bottom per the design comp: machine → project
 * type → per-type selectors (optionally split into project+branch +
 * worktree on local) → composer (footer holds the same
 * `MobileSessionRunConfig` face as the in-session chat). Each row
 * carries a short label (机器 / 类型 / 项目 / 模式) so the surface reads
 * like a form rather than a tag cloud.
 */
export function MobileNewChatSheet({
  open,
  onOpenChange,
  ...contentProps
}: MobileNewChatSheetProps) {
  const [popupContainer, setPopupContainer] = useState<HTMLDivElement | null>(null);
  const title = contentProps.labels?.title ?? '新建对话';
  const description = contentProps.labels?.description;

  return (
    <Drawer open={open} onOpenChange={onOpenChange} repositionInputs={false}>
      {/* Adaptive height: only cap the maximum so short contexts (chat-only
         with no per-type row) collapse to their natural height instead of
         leaving a half-screen of empty white space below the composer. */}
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
        className="mobile-new-chat-sheet h-auto! max-h-[92dvh]! rounded-t-2xl border-border/60 bottom-[var(--native-keyboard-height,0px)]!"
        style={{
          transition: 'bottom 320ms cubic-bezier(0.32, 0.72, 0, 1)',
          willChange: 'bottom',
        }}
      >
        <DrawerTitle {...stylex.props(sheetSurface.srOnly)}>{title}</DrawerTitle>
        <DrawerDescription {...stylex.props(sheetSurface.srOnly)}>
          {description ?? title}
        </DrawerDescription>
        <PopupContainerProvider container={popupContainer}>
          <MobileNewChatSheetContent
            {...contentProps}
            onClose={() => onOpenChange(false)}
            className={contentProps.className}
          />
        </PopupContainerProvider>
        {/* Stay inside Vaul's modal boundary, outside the scrolling content.
            Menu touches must not start a drawer drag. */}
        <div ref={setPopupContainer} data-vaul-no-drag="" />
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
  const machineLabel = labels.machineLabel ?? '机器';
  const contextTypeLabel = labels.contextTypeLabel ?? '类型';
  const perTypeLabel = labels.perTypeLabel ?? '项目';
  const branchLabel = labels.branchLabel ?? '分支';
  const secondaryPerTypeLabel = labels.secondaryPerTypeLabel ?? '模式';
  /* Keep the focused composer centered above the native keyboard so the
     footer run-config control isn't left hidden. */
  const scrollRef = useRef<HTMLDivElement>(null);
  useKeyboardAwareScrollIntoView(scrollRef);

  return (
    <div {...withClassName(stylex.props(styles.root), className)}>
      <header {...stylex.props(sheetSurface.header)}>
        <h2 {...stylex.props(sheetSurface.title, sheetSurface.titleCentered, styles.title)}>
          {title}
        </h2>
        {showCloseButton ? (
          <button
            type="button"
            aria-label={closeAriaLabel}
            {...stylex.props(
              sheetSurface.iconButton,
              sheetSurface.iconButtonRight,
              styles.closeChip
            )}
            onClick={onClose}
          >
            <X {...stylex.props(sheetSurface.glyph20)} aria-hidden="true" strokeWidth={1.8} />
          </button>
        ) : null}
      </header>
      {description ? (
        <p {...stylex.props(styles.description)}>{description}</p>
      ) : (
        <p {...stylex.props(sheetSurface.srOnly)}>{title}</p>
      )}

      <Coordinator>
        <div
          ref={scrollRef}
          {...withClassName(stylex.props(styles.scroll), scrollAreaClassName)}
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
          {/* Per-type + secondary rows mount / unmount as the user
             switches context type (e.g. picking Chat collapses the
             项目 row, picking Local adds the 模式 row).
             `AnimatePresence` + height-animated wrappers slide the
             rows in / out so the surrounding stack ripples smoothly
             rather than snapping. */}
          <div {...stylex.props(styles.rows)}>
            <AnimatedSheetRow alwaysOn>
              <Row label={machineLabel}>{machineNode}</Row>
            </AnimatedSheetRow>
            <AnimatedSheetRow alwaysOn>
              <Row label={contextTypeLabel}>{contextTypeNode}</Row>
            </AnimatedSheetRow>
            <AnimatePresence initial={false}>
              {perTypeNode ? (
                <AnimatedSheetRow key="per-type">
                  <Row label={perTypeLabel}>{perTypeNode}</Row>
                </AnimatedSheetRow>
              ) : null}
              {branchNode ? (
                <AnimatedSheetRow key="branch">
                  <Row label={branchLabel}>{branchNode}</Row>
                </AnimatedSheetRow>
              ) : null}
              {secondaryPerTypeNode ? (
                <AnimatedSheetRow key="secondary-per-type">
                  <Row label={secondaryPerTypeLabel}>{secondaryPerTypeNode}</Row>
                </AnimatedSheetRow>
              ) : null}
            </AnimatePresence>
          </div>

          <div {...stylex.props(styles.composer)}>{composer}</div>

          {belowComposerNode ? (
            /* Vertical-rhythm wrapper only; the slot owns horizontal
               layout (e.g. agent left vs permission right). */
            <div {...stylex.props(styles.belowComposer)}>{belowComposerNode}</div>
          ) : null}
        </div>
      </Coordinator>
    </div>
  );
}

/* Wrapper that animates a row's mount / unmount via height accordion.
   `alwaysOn` skips the AnimatePresence-driven mount transition (for
   rows that are always rendered like machine + type) but keeps the
   `pt-1.5` rhythm so the spacing stays consistent with the rows that
   do animate in.

   We bake `pt-1.5` into the wrapper instead of using parent `gap-1.5`
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
    return <div {...stylex.props(styles.rowRhythmFirst)}>{children}</div>;
  }
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
      {...stylex.props(styles.animatedRow)}
    >
      <div {...stylex.props(styles.rowRhythm)}>{children}</div>
    </motion.div>
  );
}

/* Single labelled row.
   Label sits left at fixed width; value column flexes to fill the rest
   so chips render in the remaining width. The whole row is wrapped in a
   `MobileInlinePickerRowSlot` so any picker dropped inside the value
   column portals its expansion drawer into the slot rendered just
   below the row card — full row width, escaping the chip's own column.
   That gives the "list under the entire row" behavior the design comp
   asks for even when the row holds two side-by-side chips (e.g.
   project + branch). */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <MobileInlinePickerRowSlot>
      <div {...stylex.props(styles.row)}>
        {/* Fixed-width label column so every row's value column starts
           at the same x regardless of the label's intrinsic width.
           Without this, "Machine" / "Type" / "Project" / "Branch" /
           "Mode" each push the value chip to a different x in
           English (Chinese labels are uniform 2 chars so it accidentally
           lined up before). `w-16` (64px) fits the longest English
           label at 0.72rem without wrapping. */}
        <span {...stylex.props(styles.rowLabel)}>{label}</span>
        <div {...stylex.props(styles.rowValue)}>{children}</div>
      </div>
    </MobileInlinePickerRowSlot>
  );
}
