import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { useDrag } from '@use-gesture/react';

import { cn } from '@/lib/utils';
import { getSessionChatInputAreaShellClassName } from '@/components/chat/composer-surface';
import { BaseHeader } from '@/components/page-headers/base-header';
import { MobileSessionHeaderBackButton } from '@/components/mobile/glass-icon-button';
import { SessionConversationPage } from '@/components/sessions/session-conversation-page';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { isNativeAppShell } from '@/lib/native-platform';
import { useKeyboardAwareScrollIntoView } from '@/hooks/use-keyboard-aware-scroll-into-view';
import { EDGE_ZONE_PX } from './mobile-edge-back-swipe';

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

/* Keep in sync with `.mobile-drill-in` in `tailwind/index.css`. */
export const MOBILE_NEW_CHAT_SLIDE_MS = 280;
const SLIDE_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';
const SWIPE_COMMIT_PX = 80;
const SWIPE_COMMIT_VELOCITY = 0.45;
const SWIPE_HORIZONTAL_INTENT_PX = 8;
const SWIPE_MAX_VERTICAL_DRIFT_PX = 52;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** New-chat page over the still-mounted mobile home or project screen. */
export function MobileNewChatSheet({
  open,
  onOpenChange,
  ...contentProps
}: MobileNewChatSheetProps) {
  if (!open) return null;
  return <MobileNewChatPage {...contentProps} onClose={() => onOpenChange(false)} />;
}

/**
 * Pushes in from the right on mount and leaves to the right on Back. In the
 * native app a rightward drag that starts within `EDGE_ZONE_PX` of the left
 * edge moves the page with the finger, revealing the screen beneath, and
 * commits or snaps back on release. The drag is bound on the page itself rather
 * than an overlay strip, so no tap target is covered; drags starting in the
 * composer stay with the composer. A host that sets `open` to false (first-send
 * presentation) removes the page immediately, without an exit slide.
 */
function MobileNewChatPage({
  onClose,
  className,
  ...contentProps
}: MobileNewChatSheetContentProps & { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [entering, setEntering] = useState(() => !prefersReducedMotion());
  const closingRef = useRef(false);
  const swipingRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(
    () => () => {
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    },
    []
  );

  /* An interrupted entrance hands the transform over to inline styles; the
     keyframe's fill would otherwise outrank them. */
  const stopEntrance = useCallback(() => {
    panelRef.current?.classList.remove('mobile-drill-in');
    setEntering(false);
  }, []);

  const settle = useCallback((offset: '0px' | '100%', onDone: () => void) => {
    const panel = panelRef.current;
    if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    if (!panel || prefersReducedMotion()) {
      onDone();
      return;
    }
    panel.style.transition = `transform ${MOBILE_NEW_CHAT_SLIDE_MS}ms ${SLIDE_EASING}`;
    panel.style.transform = `translate3d(${offset}, 0, 0)`;
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      onDone();
    }, MOBILE_NEW_CHAT_SLIDE_MS);
  }, []);

  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    swipingRef.current = false;
    stopEntrance();
    settle('100%', () => onCloseRef.current());
  }, [settle, stopEntrance]);

  const snapBack = useCallback(() => {
    swipingRef.current = false;
    settle('0px', () => {
      const panel = panelRef.current;
      if (!panel) return;
      /* No resting transform: it would make the page a containing block for
         fixed descendants. */
      panel.style.transition = '';
      panel.style.transform = '';
    });
  }, [settle]);

  const bindEdgeBack = useDrag(
    ({
      first,
      last,
      movement: [movementX, movementY],
      direction: [directionX],
      velocity: [velocityX],
      initial: [startX],
      cancel,
      event,
    }) => {
      /* With `axis` set, `first` arrives on the first intentional move, so the
         edge test reads the touch-down position. */
      if (first) {
        const target = event.target;
        if (
          closingRef.current ||
          startX > EDGE_ZONE_PX ||
          (target instanceof Element && target.closest('[data-new-chat-no-edge-back]'))
        ) {
          cancel();
          return;
        }
        swipingRef.current = true;
      }
      if (!swipingRef.current) return;
      const panel = panelRef.current;
      if (!panel) return;

      if (
        movementX <= SWIPE_HORIZONTAL_INTENT_PX &&
        Math.abs(movementY) > SWIPE_MAX_VERTICAL_DRIFT_PX
      ) {
        cancel();
        snapBack();
        return;
      }

      const offsetX = Math.max(0, movementX);
      if (offsetX > SWIPE_HORIZONTAL_INTENT_PX) {
        event.preventDefault();
        if (entering) stopEntrance();
        panel.style.transition = 'none';
        panel.style.transform = `translate3d(${offsetX}px, 0, 0)`;
      }

      if (!last) return;
      const commit =
        offsetX >= SWIPE_COMMIT_PX ||
        (directionX > 0 && velocityX >= SWIPE_COMMIT_VELOCITY && offsetX >= SWIPE_COMMIT_PX * 0.3);
      if (commit) close();
      else snapBack();
    },
    {
      axis: 'x',
      pointer: { touch: true },
      eventOptions: { passive: false },
    }
  );

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      <div
        ref={panelRef}
        className={cn('flex h-full flex-col bg-background', entering && 'mobile-drill-in')}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget) setEntering(false);
        }}
        {...(isNativeAppShell() ? bindEdgeBack() : {})}
      >
        <MobileNewChatSheetContent
          {...contentProps}
          onClose={close}
          className={cn('min-h-0 flex-1', className)}
        />
      </div>
    </div>
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
          <div
            data-new-chat-no-edge-back=""
            className={getSessionChatInputAreaShellClassName({ protectFromEdgeBackZone: true })}
          >
            <ConversationColumn>{composer}</ConversationColumn>
          </div>
        </SessionConversationPage>
      </Coordinator>
    </div>
  );
}
