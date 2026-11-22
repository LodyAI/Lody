import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import * as stylex from '@stylexjs/stylex';
import { Checkbox } from '@lody/ui/checkbox';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import {
  TODAY_CONVERT_DIALOG_WIDTH,
  TodayConvertDialogHeader,
} from './today-convert-dialog-header';

export type TodayConvertDialogProps = {
  open: boolean;
  /** The node's text and its children; it seeds the dialog's own draft on each open. */
  prompt: string;
  /**
   * The same prompt with the node's ancestors around it, when it has any. It
   * seeds the draft instead, and a checkbox switches between the two while
   * the prompt is unedited.
   */
  promptWithAncestors?: string | null;
  /** Called once `startSession` has accepted the first turn, before the dialog closes. */
  onAccepted: (sessionId: SessionId) => void;
  onOpenChange: (open: boolean) => void;
};

const SURFACE = 'today-convert' as const;

const styles = stylex.create({
  ancestors: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    marginTop: space[2],
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
    cursor: 'pointer',
    userSelect: 'none',
  },
  hint: { color: colors.tertiaryLabel },
});

/**
 * "Convert to task": the new-chat page's own landing, in a dialog laid out
 * like a create form — a breadcrumb header, the prompt as the page, the
 * selectors as a pill row and a footer with Cancel and Start task. The
 * landing runs on its own surface draft, so the page's draft is untouched,
 * and it releases that draft when it unmounts; each open starts from
 * `prompt`. Closing is refused while a send is in flight.
 */
export function TodayConvertDialog({
  open,
  prompt,
  promptWithAncestors = null,
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
  const promptRef = useRef(promptWithAncestors ?? prompt);
  promptRef.current = promptWithAncestors ?? prompt;
  const draftAtom = chatLandingSessionStateAtomFamily(
    buildChatLandingSurfaceDraftKey(owner, SURFACE, workspaceSlug ?? '')
  );
  const draftPrompt = useAtomValue(draftAtom).prompt;
  const ancestorsIncluded = promptWithAncestors !== null && draftPrompt === promptWithAncestors;
  const ancestorsSwitchable =
    promptWithAncestors !== null && (draftPrompt === promptWithAncestors || draftPrompt === prompt);

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
  const submitLabel = t('today.convertSubmit', 'Start task');
  const embedding = useMemo<ChatLandingEmbedding>(
    () => ({
      surface: SURFACE,
      submitLabel,
      onSessionAccepted: ({ sessionId }) => {
        onAcceptedRef.current(sessionId);
        onOpenChangeRef.current(false);
      },
      onPendingChange: (next) => {
        pendingRef.current = next;
        setPending(next);
      },
      // Cancel is disabled while a send is in flight; the guard repeats it.
      onCancel: () => {
        if (!pendingRef.current) onOpenChangeRef.current(false);
      },
    }),
    [submitLabel]
  );

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
      <Dialog.Content
        width={TODAY_CONVERT_DIALOG_WIDTH}
        closeButton={!pending}
        closeLabel={t('common.close', 'Close')}
        data-testid="today-convert-dialog"
      >
        <TodayConvertDialogHeader
          parent={t('today.nav', 'Today')}
          title={t('today.convertTitle', 'Convert to task')}
        />
        {promptWithAncestors !== null ? (
          <label {...stylex.props(styles.ancestors)} data-testid="today-convert-ancestors">
            <Checkbox
              checked={ancestorsIncluded}
              disabled={!ancestorsSwitchable || pending}
              onCheckedChange={(checked) =>
                store.set(draftAtom, (previous) => ({
                  ...previous,
                  prompt: checked ? promptWithAncestors : prompt,
                  mentionRanges: [],
                }))
              }
            />
            <span>{t('today.convertIncludeAncestors', 'Include parent nodes')}</span>
            {ancestorsSwitchable ? null : (
              <span {...stylex.props(styles.hint)}>
                {t('today.convertAncestorsEdited', 'Prompt edited')}
              </span>
            )}
          </label>
        ) : null}
        {landingMounted && workspaceSlug ? (
          <ChatLanding workspaceSlug={workspaceSlug} embedding={embedding} />
        ) : null}
      </Dialog.Content>
    </Dialog.Root>
  );
}
