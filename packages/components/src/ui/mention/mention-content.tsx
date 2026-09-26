import {
  type Align,
  type AnchorPositionerProps,
  createContext,
  type PointerDownOutsideEvent,
  Presence,
  Primitive,
  type Side,
  useAnchorPositioner,
  useComposedRefs,
  useDismiss,
  useScrollLock,
} from '@diceui/shared';
import { FloatingFocusManager, type VirtualElement } from '@floating-ui/react';
import * as React from 'react';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import { getDataState, useMentionContext } from './mention-root';
import { MentionMobilePanel, useIsMentionMobile } from './mention-mobile-content';

const CONTENT_NAME = 'MentionContent';
const MENTION_VIEWPORT_PADDING_PX = 16;
/**
 * The room a composer menu needs to open above without cutting its list short:
 * the menu's 320px list, a level header and the surface inset. With at least
 * this much above the composer — or no less than below it — the menu opens
 * above; only a composer pressed against the top of its layer opens it below.
 */
const COMPOSER_MENU_ROOM_PX = 360;
/** A composer marks the box a menu belongs to: its chip row and its input. */
const MENTION_FRAME_SELECTOR = '[data-mention-frame]';

type ContentElement = React.ElementRef<typeof Primitive.div>;
type InputBoundaryRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};
type MentionContentStyle = React.CSSProperties & {
  '--mention-input-width'?: string;
  /** Where the entrance starts: one step further from the caret, on the side the menu landed. */
  '--mention-rise'?: string;
};

interface MentionContentContextValue {
  side: Side;
  align: Align;
  onArrowChange: (arrow: HTMLElement | null) => void;
  arrowStyles: React.CSSProperties;
  arrowDisplaced: boolean;
  forceMount: boolean;
}

const [MentionContentProvider, useMentionContentContext] =
  createContext<MentionContentContextValue>(CONTENT_NAME);

interface MentionContentProps
  extends AnchorPositionerProps, React.ComponentPropsWithoutRef<typeof Primitive.div> {
  /**
   * Which reference rect drives floating placement.
   *
   * `caret` follows the caret line and flips to stay on screen.
   *
   * `composer` belongs to the composer instead: it opens against the nearest
   * `[data-mention-frame]` around the input (else the input's wrapper),
   * left-aligned to it and as wide at most. It picks its side once per open —
   * above unless there is truly no room there — and keeps it: a level change or
   * a keystroke resizes the menu in place and never moves its anchor. Its height
   * is capped to the room on that side instead of flipping.
   */
  positionAnchor?: 'caret' | 'composer';

  /**
   * Event handler called when the `Escape` key is pressed.
   *
   * Can be used to prevent the popover from closing when the `Escape` key is pressed.
   */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;

  /**
   * Event handler called when a `pointerdown` event happens outside of the content.
   *
   * Can be used to prevent the popover from closing when the pointer is outside of the content.
   */
  onPointerDownOutside?: (event: PointerDownOutsideEvent) => void;
}

const MentionContent = React.forwardRef<ContentElement, MentionContentProps>(
  (props, forwardedRef) => {
    const {
      side = 'bottom',
      sideOffset = 4,
      align = 'start',
      alignOffset = 0,
      arrowPadding = 0,
      collisionBoundary,
      collisionPadding,
      sticky = 'partial',
      strategy = 'absolute',
      avoidCollisions = true,
      fitViewport = false,
      forceMount = false,
      hideWhenDetached = false,
      trackAnchor = true,
      positionAnchor = 'caret',
      onEscapeKeyDown,
      onPointerDownOutside,
      style,
      ...contentProps
    } = props;

    const context = useMentionContext(CONTENT_NAME);
    const isMobile = useIsMentionMobile();
    const [inputBoundary, setInputBoundary] = React.useState<InputBoundaryRect | null>(null);
    const [frameRect, setFrameRect] = React.useState<InputBoundaryRect | null>(null);
    /** Room above and below the frame inside the visible layer, for `composer`. */
    const [frameRoom, setFrameRoom] = React.useState<{ above: number; below: number } | null>(null);
    /** The side a `composer` menu chose when it opened. Held until it closes. */
    const [lockedSide, setLockedSide] = React.useState<'top' | 'bottom' | null>(null);
    const composerAnchor = positionAnchor === 'composer';

    const rtlAwareAlign = React.useMemo(() => {
      if (context.dir !== 'rtl') return align;
      return align === 'start' ? 'end' : align === 'end' ? 'start' : align;
    }, [align, context.dir]);

    // Measured afresh on each open: a composer menu chooses its side from the
    // room it opens with.
    React.useLayoutEffect(() => {
      if (isMobile || typeof window === 'undefined') {
        setInputBoundary(null);
        return undefined;
      }
      const open = context.open;

      const input = context.inputRef.current;
      if (!input) {
        setInputBoundary(null);
        setFrameRect(null);
        setFrameRoom(null);
        return undefined;
      }

      const modal = input.closest<HTMLElement>('[data-lody-dialog-content], [data-vaul-drawer]');
      // A composer menu measures against the composer's own frame (its chip
      // row and box), so it lines up with them and never cuts a chip in half.
      const frame =
        (composerAnchor ? input.closest<HTMLElement>(MENTION_FRAME_SELECTOR) : null) ??
        input.parentElement ??
        input;
      const measure = () => {
        const modalRect = modal?.getBoundingClientRect();
        const inputRect = frame.getBoundingClientRect();
        const viewport = window.visualViewport;
        const viewportLeft = viewport?.offsetLeft ?? 0;
        const viewportTop = viewport?.offsetTop ?? 0;
        const viewportWidth = viewport?.width ?? window.innerWidth;
        const viewportHeight = viewport?.height ?? window.innerHeight;
        const viewportRight = viewportLeft + viewportWidth;
        // The modal is the portal owner and can clip its descendants. Flip/shift
        // within that visible layer rather than placing rows behind its footer.
        const top = Math.max(viewportTop, modalRect?.top ?? viewportTop);
        const bottom = Math.min(viewportTop + viewportHeight, modalRect?.bottom ?? Infinity);
        const left = Math.max(inputRect.left, viewportLeft + MENTION_VIEWPORT_PADDING_PX);
        const right = Math.min(inputRect.right, viewportRight - MENTION_VIEWPORT_PADDING_PX);
        const next =
          right > left
            ? {
                x: left,
                y: top,
                width: right - left,
                height: Math.max(0, bottom - top),
              }
            : null;

        const nextFrame = {
          x: inputRect.left,
          y: inputRect.top,
          width: inputRect.width,
          height: inputRect.height,
        };
        const nextRoom = {
          above: Math.max(0, inputRect.top - top - MENTION_VIEWPORT_PADDING_PX),
          below: Math.max(0, bottom - inputRect.bottom - MENTION_VIEWPORT_PADDING_PX),
        };

        setInputBoundary((previous) => {
          if (
            previous?.x === next?.x &&
            previous?.y === next?.y &&
            previous?.width === next?.width &&
            previous?.height === next?.height
          ) {
            return previous;
          }
          return next;
        });
        setFrameRect((previous) => {
          if (
            previous?.x === nextFrame.x &&
            previous?.y === nextFrame.y &&
            previous?.width === nextFrame.width &&
            previous?.height === nextFrame.height
          ) {
            return previous;
          }
          return nextFrame;
        });
        // A closed menu holds no room, so the next open cannot choose its side
        // from where the composer was the last time.
        setFrameRoom((previous) =>
          !open
            ? null
            : previous?.above === nextRoom.above && previous?.below === nextRoom.below
              ? previous
              : nextRoom
        );
      };

      measure();

      const cleanupResizeObserver = observeResizeOnAnimationFrame(input, () => measure());
      const cleanupFrameObserver =
        frame !== input ? observeResizeOnAnimationFrame(frame, measure) : undefined;
      const cleanupModalObserver = modal
        ? observeResizeOnAnimationFrame(modal, measure)
        : undefined;
      window.addEventListener('resize', measure);
      window.addEventListener('scroll', measure, true);
      window.visualViewport?.addEventListener('resize', measure);
      window.visualViewport?.addEventListener('scroll', measure);

      return () => {
        cleanupResizeObserver();
        cleanupFrameObserver?.();
        cleanupModalObserver?.();
        window.removeEventListener('resize', measure);
        window.removeEventListener('scroll', measure, true);
        window.visualViewport?.removeEventListener('resize', measure);
        window.visualViewport?.removeEventListener('scroll', measure);
      };
    }, [composerAnchor, context.inputRef, context.open, isMobile]);

    // A composer menu chooses its side once, from the room it opened with, and
    // keeps it until it closes: the first level is short and the second tall, so
    // letting floating-ui flip on size put the two on opposite sides.
    React.useLayoutEffect(() => {
      if (!composerAnchor || !context.open) {
        setLockedSide(null);
        return;
      }
      if (!frameRoom) return;
      setLockedSide(
        (previous) =>
          previous ??
          (frameRoom.above >= COMPOSER_MENU_ROOM_PX || frameRoom.above >= frameRoom.below
            ? 'top'
            : 'bottom')
      );
    }, [composerAnchor, context.open, frameRoom]);

    const inputWidthStyle = React.useMemo<MentionContentStyle>(() => {
      return {
        '--mention-input-width': inputBoundary ? `${inputBoundary.width}px` : 'calc(100vw - 2rem)',
      };
    }, [inputBoundary]);

    const frameAnchor = React.useMemo<VirtualElement | null>(() => {
      if (!frameRect) return null;
      return {
        contextElement: context.inputRef.current ?? undefined,
        getBoundingClientRect() {
          return {
            width: frameRect.width,
            height: frameRect.height,
            x: frameRect.x,
            y: frameRect.y,
            top: frameRect.y,
            right: frameRect.x + frameRect.width,
            bottom: frameRect.y + frameRect.height,
            left: frameRect.x,
            toJSON() {
              return this;
            },
          } satisfies DOMRect;
        },
        getClientRects() {
          const rect = this.getBoundingClientRect();
          const rects = [rect];
          Object.defineProperty(rects, 'item', {
            value: function item(index: number) {
              return this[index];
            },
          });
          return rects;
        },
      };
    }, [context.inputRef, frameRect]);

    const anchorRef = composerAnchor
      ? (frameAnchor ?? context.virtualAnchor)
      : context.virtualAnchor;
    const placedSide: Side = composerAnchor ? (lockedSide ?? 'top') : side;

    const positionerContext = useAnchorPositioner({
      open: context.open,
      onOpenChange: context.onOpenChange,
      anchorRef,
      side: placedSide,
      sideOffset,
      align: rtlAwareAlign,
      alignOffset,
      arrowPadding,
      // `inputBoundary` is null until the first measure. It must degrade to
      // `undefined` (no boundary, positioner default) — floating-ui reads a
      // non-element boundary as a rect and dereferences it.
      collisionBoundary:
        collisionBoundary ??
        (inputBoundary as AnchorPositionerProps['collisionBoundary'] | undefined) ??
        undefined,
      collisionPadding,
      sticky,
      strategy,
      // A composer menu never flips: its side is locked and its height capped.
      avoidCollisions: composerAnchor ? false : avoidCollisions,
      disableArrow: true,
      fitViewport,
      hideWhenDetached,
      trackAnchor,
    });

    const setFloatingRef = React.useRef(positionerContext.refs.setFloating);
    setFloatingRef.current = positionerContext.refs.setFloating;
    const handleFloatingRef = React.useCallback((node: ContentElement | null) => {
      setFloatingRef.current(node);
    }, []);
    const composedRef = useComposedRefs(forwardedRef, handleFloatingRef);
    const resolvedSide = positionerContext.side;
    const composerMaxHeight =
      composerAnchor && frameRoom
        ? Math.max(0, (placedSide === 'top' ? frameRoom.above : frameRoom.below) - sideOffset)
        : undefined;
    const composedStyle = React.useMemo<MentionContentStyle>(() => {
      return {
        ...inputWidthStyle,
        '--mention-rise': resolvedSide === 'top' ? '-4px' : '4px',
        ...(composerMaxHeight !== undefined ? { maxHeight: `${composerMaxHeight}px` } : {}),
        ...style,
        ...positionerContext.floatingStyles,
        ...(!context.open && forceMount ? { visibility: 'hidden' } : {}),
      };
    }, [
      inputWidthStyle,
      resolvedSide,
      composerMaxHeight,
      style,
      positionerContext.floatingStyles,
      forceMount,
      context.open,
    ]);

    useDismiss({
      /* Disabled on mobile: the docked panel manages its own lifetime
         (diceui still closes the menu when the trigger query ends or a
         candidate is inserted), and this dismiss layer's outside-pointer
         handling is what made candidate taps close the panel instead of
         selecting inside a vaul Drawer. */
      enabled: context.open && !isMobile,
      onDismiss: () => context.onOpenChange(false),
      refs: [context.listRef, context.inputRef],
      onFocusOutside: (event) => event.preventDefault(),
      onEscapeKeyDown,
      onPointerDownOutside,
      disableOutsidePointerEvents: context.open && context.modal,
      preventScrollDismiss: context.open,
    });

    useScrollLock({
      referenceElement: context.inputRef.current,
      enabled: context.open && context.modal && !isMobile,
    });

    /* Mobile: dock a full-width panel above the composer instead of the
       caret-anchored floating popover. Reuses the same candidate rows
       (`contentProps.children`) and selection logic; only the container
       + positioning differ. Skips FloatingFocusManager / floating-ui so
       none of vaul's drag / pointer-capture / dismiss conflicts apply. */
    if (isMobile) {
      return (
        <MentionContentProvider
          side={placedSide}
          align={rtlAwareAlign}
          arrowStyles={positionerContext.arrowStyles}
          arrowDisplaced={positionerContext.arrowDisplaced}
          onArrowChange={positionerContext.onArrowChange}
          forceMount={forceMount}
        >
          <MentionMobilePanel open={forceMount || context.open} anchorRef={context.inputRef}>
            {contentProps.children}
          </MentionMobilePanel>
        </MentionContentProvider>
      );
    }

    return (
      <MentionContentProvider
        side={placedSide}
        align={rtlAwareAlign}
        arrowStyles={positionerContext.arrowStyles}
        arrowDisplaced={positionerContext.arrowDisplaced}
        onArrowChange={positionerContext.onArrowChange}
        forceMount={forceMount}
      >
        <FloatingFocusManager
          context={positionerContext.context}
          modal={false}
          initialFocus={context.inputRef}
          returnFocus={false}
          disabled={!context.open}
          visuallyHiddenDismiss
        >
          <Presence present={forceMount || context.open}>
            <Primitive.div
              ref={composedRef}
              role="listbox"
              aria-orientation="vertical"
              data-state={getDataState(context.open)}
              dir={context.dir}
              {...positionerContext.getFloatingProps(contentProps)}
              style={composedStyle}
            />
          </Presence>
        </FloatingFocusManager>
      </MentionContentProvider>
    );
  }
);

MentionContent.displayName = CONTENT_NAME;

const Content = MentionContent;

export { MentionContent, Content, useMentionContentContext };

export type { MentionContentProps, ContentElement };
