import { useCallback, useLayoutEffect, useState, type RefObject } from 'react';

interface Submission {
  isCurrent: () => boolean;
  finish: () => void;
  dispose: () => void;
}

function createScope(key: string) {
  return { key, submission: null as Submission | null };
}

/**
 * Owns the local submission lifetime, including its post-commit focus handoff.
 * A scope change/unmount retires the whole lifetime, even on an A → B → A trip.
 * Callers still own acceptance and draft persistence.
 */
export function useComposerSubmission(
  scopeKey: string,
  inputRef: RefObject<HTMLTextAreaElement | null>
) {
  const [scope, setScope] = useState(() => createScope(scopeKey));
  if (scope.key !== scopeKey) setScope(createScope(scopeKey));
  const [state, setState] = useState<{
    scope: typeof scope;
    pending: boolean;
    restoreFocus: () => void;
  } | null>(null);

  useLayoutEffect(() => {
    return () => {
      scope.submission?.dispose();
      scope.submission = null;
    };
  }, [scope]);

  useLayoutEffect(() => {
    if (state?.scope !== scope || state.pending) return;
    state.restoreFocus();
    scope.submission?.dispose();
    scope.submission = null;
  }, [scope, state]);

  const beginSubmission = useCallback(
    ({ dismissKeyboard }: { dismissKeyboard: boolean }): Submission | null => {
      // The submission token also covers two submissions in the same React batch.
      if (scope.submission) return null;
      const input = inputRef.current;
      if (!input) return null;
      const document = input.ownerDocument;
      const window = document.defaultView;
      let focusRelinquished = false;
      const relinquishFocus = () => {
        focusRelinquished = true;
      };
      const onFocus = (event: FocusEvent) => {
        if (event.target !== inputRef.current && event.target !== document.body) relinquishFocus();
      };
      const onPointerDown = (event: PointerEvent) => {
        if (event.target !== inputRef.current) relinquishFocus();
      };
      const dispose = () => {
        document.removeEventListener('focusin', onFocus, true);
        document.removeEventListener('pointerdown', onPointerDown, true);
        window?.removeEventListener('blur', relinquishFocus);
      };
      const restoreFocus = () => {
        if (!dismissKeyboard && !focusRelinquished)
          inputRef.current?.focus({ preventScroll: true });
      };
      const submission: Submission = {
        isCurrent: () => scope.submission === submission,
        dispose,
        finish: () => {
          if (!submission.isCurrent()) return;
          // A new state object makes completion observable even if React batches
          // pending and settled into one commit (including immediate rejection).
          setState({
            scope,
            pending: false,
            restoreFocus,
          });
        },
      };
      scope.submission = submission;
      if (dismissKeyboard) {
        input.blur();
      } else {
        document.addEventListener('focusin', onFocus, true);
        document.addEventListener('pointerdown', onPointerDown, true);
        window?.addEventListener('blur', relinquishFocus);
      }
      setState({ scope, pending: true, restoreFocus });
      return submission;
    },
    [inputRef, scope]
  );

  return { submissionPending: state?.scope === scope && state.pending, beginSubmission };
}
