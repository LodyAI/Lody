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

type ContentElement = React.ElementRef<typeof Primitive.div>;
type InputBoundaryRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};
type MentionContentStyle = React.CSSProperties & {
  '--mention-input-width'?: string;
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
   * Which reference rect drives floating placement. `input-top` is useful for
   * large top-side menus that should sit directly above the input rather than
   * above the current caret line.
   */
  positionAnchor?: 'caret' | 'input-top';

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
    const [inputTopAnchorRect, setInputTopAnchorRect] = React.useState<InputBoundaryRect | null>(
      null
    );

    const rtlAwareAlign = React.useMemo(() => {
      if (context.dir !== 'rtl') return align;
      return align === 'start' ? 'end' : align === 'end' ? 'start' : align;
    }, [align, context.dir]);

    React.useLayoutEffect(() => {
      if (isMobile || typeof window === 'undefined') {
        setInputBoundary(null);
        return undefined;
      }

      const input = context.inputRef.current;
      if (!input) {
        setInputBoundary(null);
        setInputTopAnchorRect(null);
        return undefined;
      }

      const modal = input.closest<HTMLElement>('[data-lody-dialog-content], [data-vaul-drawer]');
      const measure = () => {
        const modalRect = modal?.getBoundingClientRect();
        const inputRect = (input.parentElement ?? input).getBoundingClientRect();
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

        const nextInputTopAnchor = {
          x: inputRect.left,
          y: inputRect.top,
          width: inputRect.width,
          height: 0,
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
        setInputTopAnchorRect((previous) => {
          if (
            previous?.x === nextInputTopAnchor.x &&
            previous?.y === nextInputTopAnchor.y &&
            previous?.width === nextInputTopAnchor.width &&
            previous?.height === nextInputTopAnchor.height
          ) {
            return previous;
          }
          return nextInputTopAnchor;
        });
      };

      measure();

      const cleanupResizeObserver = observeResizeOnAnimationFrame(input, () => measure());
      const cleanupModalObserver = modal
        ? observeResizeOnAnimationFrame(modal, measure)
        : undefined;
      window.addEventListener('resize', measure);
      window.addEventListener('scroll', measure, true);
      window.visualViewport?.addEventListener('resize', measure);
      window.visualViewport?.addEventListener('scroll', measure);

      return () => {
        cleanupResizeObserver();
        cleanupModalObserver?.();
        window.removeEventListener('resize', measure);
        window.removeEventListener('scroll', measure, true);
        window.visualViewport?.removeEventListener('resize', measure);
        window.visualViewport?.removeEventListener('scroll', measure);
      };
    }, [context.inputRef, isMobile]);

    const inputWidthStyle = React.useMemo<MentionContentStyle>(() => {
      return {
        '--mention-input-width': inputBoundary ? `${inputBoundary.width}px` : 'calc(100vw - 2rem)',
      };
    }, [inputBoundary]);

    const inputTopAnchor = React.useMemo<VirtualElement | null>(() => {
      if (!inputTopAnchorRect) return null;
      return {
        contextElement: context.inputRef.current ?? undefined,
        getBoundingClientRect() {
          return {
            width: inputTopAnchorRect.width,
            height: inputTopAnchorRect.height,
            x: inputTopAnchorRect.x,
            y: inputTopAnchorRect.y,
            top: inputTopAnchorRect.y,
            right: inputTopAnchorRect.x + inputTopAnchorRect.width,
            bottom: inputTopAnchorRect.y + inputTopAnchorRect.height,
            left: inputTopAnchorRect.x,
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
    }, [context.inputRef, inputTopAnchorRect]);

    const anchorRef =
      positionAnchor === 'input-top'
        ? (inputTopAnchor ?? context.virtualAnchor)
        : context.virtualAnchor;

    const positionerContext = useAnchorPositioner({
      open: context.open,
      onOpenChange: context.onOpenChange,
      anchorRef,
      side,
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
      avoidCollisions,
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
    const composedStyle = React.useMemo<React.CSSProperties>(() => {
      return {
        ...inputWidthStyle,
        ...style,
        ...positionerContext.floatingStyles,
        ...(!context.open && forceMount ? { visibility: 'hidden' } : {}),
      };
    }, [inputWidthStyle, style, positionerContext.floatingStyles, forceMount, context.open]);

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
          side={side}
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
        side={side}
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
