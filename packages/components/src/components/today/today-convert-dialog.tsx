import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useAtomValue, useStore } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { SessionId } from '@lody/shared';
import { userAtom } from '@/atoms';
import { buildChatLandingSurfaceDraftKey } from '@/atoms/chat-landing-draft';
import { chatLandingSessionStateAtomFamily } from '@/atoms/local-storage-cache';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { ChatLanding, type ChatLandingEmbedding } from '@/components/chat/chat-landing';
import { isImeComposingNativeKeyboardEvent } from '@/lib/ime';
import { Dialog } from '@/ui/dialog';

export type TodayConvertDialogProps = {
  open: boolean;
  /** The node's text and its children; it seeds the dialog's own draft on each open. */
  prompt: string;
  /** Called once `startSession` has accepted the first turn, before the dialog closes. */
  onAccepted: (sessionId: SessionId) => void;
  onOpenChange: (open: boolean) => void;
};

const SURFACE = 'today-convert' as const;

/**
 * "Convert to task": the new-chat page's own landing, in a dialog. The
 * landing runs on its own surface draft, so the page's draft is untouched,
 * and it releases that draft when it unmounts; each open starts from
 * `prompt`. Closing is refused while a send is in flight.
 */
export function TodayConvertDialog({
  open,
  prompt,
  onAccepted,
  onOpenChange,
}: TodayConvertDialogProps) {
  const { t } = useTranslation();
  const store = useStore();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const user = useAtomValue(userAtom);
  // The same owner the landing resolves for its draft key.
  const owner =
    user?.id ?? (runtime?.contentMode === 'e2ee' ? (runtime.accountId ?? undefined) : undefined);
  const workspaceSlug = runtime?.workspaceSlug ?? null;

  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  // Whether the landing is mounted, and whether this open still needs its seed.
  const [landingMounted, setLandingMounted] = useState(false);
  const [seedPending, setSeedPending] = useState(false);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;

  // Each open first unmounts a landing still fading out from the last close
  // (its unmount releases the surface draft), then seeds the draft, then
  // mounts a fresh landing over it. All of it lands before paint.
  useLayoutEffect(() => {
    if (!open) return;
    setLandingMounted(false);
    setSeedPending(true);
  }, [open]);
  useLayoutEffect(() => {
    if (!seedPending || landingMounted || !workspaceSlug) return;
    store.set(
      chatLandingSessionStateAtomFamily(
        buildChatLandingSurfaceDraftKey(owner, SURFACE, workspaceSlug)
      ),
      { prompt: promptRef.current, pastedTextDrafts: [], mentionRanges: [] }
    );
    setSeedPending(false);
    setLandingMounted(true);
  }, [landingMounted, owner, seedPending, store, workspaceSlug]);

  const onAcceptedRef = useRef(onAccepted);
  onAcceptedRef.current = onAccepted;
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const [embedding] = useState<ChatLandingEmbedding>(() => ({
    surface: SURFACE,
    onSessionAccepted: ({ sessionId }) => {
      onAcceptedRef.current(sessionId);
      onOpenChangeRef.current(false);
    },
    onPendingChange: (next) => {
      pendingRef.current = next;
      setPending(next);
    },
  }));

  const handleOpenChange = useCallback(
    (nextOpen: boolean, details?: { reason?: string; event?: Event }) => {
      if (nextOpen) {
        onOpenChange(true);
        return;
      }
      // A send in flight must settle before the draft can be released.
      if (pendingRef.current) return;
      // An Esc that ends an IME composition belongs to the input method.
      const event = details?.event;
      if (
        event instanceof KeyboardEvent &&
        isImeComposingNativeKeyboardEvent({
          key: event.key,
          isComposing: event.isComposing,
          keyCode: event.keyCode,
          which: event.which,
        })
      ) {
        return;
      }
      onOpenChange(false);
    },
    [onOpenChange]
  );

  return (
    <Dialog.Root
      open={open}
      onOpenChange={handleOpenChange}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) setLandingMounted(false);
      }}
    >
      <Dialog.Content width="42rem" closeButton={!pending} data-testid="today-convert-dialog">
        <Dialog.Header>
          <Dialog.Title>{t('today.convertTitle', 'Convert to task')}</Dialog.Title>
        </Dialog.Header>
        {landingMounted && workspaceSlug ? (
          <ChatLanding workspaceSlug={workspaceSlug} embedding={embedding} />
        ) : null}
      </Dialog.Content>
    </Dialog.Root>
  );
}
