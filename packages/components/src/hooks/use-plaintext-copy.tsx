import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useAtomValue, useStore } from 'jotai';
import { usePlatform } from '@lody/platform/react';
import { useTranslation } from 'react-i18next';
import { userAtom } from '../atoms';
import { activeWorkspaceRuntimeAtom, type WorkspaceRuntime } from '../atoms/runtime';
import { workspaceContentModeAtom } from '../atoms/workspace-content-mode';
import { AlertDialog } from '../ui/dialog';
import { Button } from '@lody/ui/button';
import { useWorkspaceRouteTargetSlug } from '../providers/workspace-route-target';

/** Cancel only the UI waiter. Capture/native adapters retain their own cleanup through settlement. */
async function waitForCopy<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {});
    signal.throwIfAborted();
  }
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** One explicit export, bound to its original runtime and selected source. No keys or persisted consent. */
export function usePlaintextCopy(
  runtime: WorkspaceRuntime | null,
  source: unknown,
  enabled = true
) {
  const store = useStore();
  const platform = usePlatform();
  const accountId = useAtomValue(userAtom)?.id ?? null;
  const routeTarget = useWorkspaceRouteTargetSlug();
  const currentRoute = useRef(routeTarget);
  currentRoute.current = routeTarget;
  const currentSource = useRef(source);
  currentSource.current = source;
  const flight = useRef<AbortController | null>(null);
  const pending = useRef<((confirmed: boolean) => void) | null>(null);
  const [confirming, setConfirming] = useState(false);
  const answer = useCallback((confirmed: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    setConfirming(false);
    resolve?.(confirmed);
  }, []);
  useLayoutEffect(
    () => () => {
      flight.current?.abort();
      answer(false);
    },
    [runtime, source, enabled, accountId, routeTarget, answer]
  );

  const run = useCallback(
    async <T,>(
      operation: (assertCurrent: () => void, admitOutput: () => Promise<void>) => Promise<T>
    ): Promise<T | undefined> => {
      if (!enabled || !runtime || source == null) return undefined;
      flight.current?.abort();
      answer(false);
      const controller = new AbortController();
      let admittedGenesis: string | undefined;
      flight.current = controller;
      const assertSource = () => {
        controller.signal.throwIfAborted();
        if (
          currentSource.current !== source ||
          runtime !== store.get(activeWorkspaceRuntimeAtom) ||
          (currentRoute.current !== null && currentRoute.current !== runtime.workspaceSlug) ||
          accountId !== (store.get(userAtom)?.id ?? null) ||
          (platform.kind === 'cloud' && runtime.accountId !== accountId)
        )
          throw new DOMException('Copy source changed', 'AbortError');
      };
      const assertCurrent = () => {
        assertSource();
        if (platform.kind === 'local') return;
        const mode = store.get(workspaceContentModeAtom);
        const descriptor = mode?.descriptor;
        if (
          !accountId ||
          mode?.accountId !== accountId ||
          mode.workspaceId !== runtime.workspaceId ||
          mode.workspaceSlug !== runtime.workspaceSlug ||
          descriptor?.workspaceId !== runtime.workspaceId ||
          !(runtime.contentMode === 'e2ee'
            ? 'contentMode' in descriptor &&
              descriptor.contentMode === 'e2ee' &&
              descriptor.contentModeVersion === 1
            : ('contentMode' in descriptor &&
                descriptor.contentMode === 'plaintext' &&
                descriptor.contentModeVersion === 1) ||
              ('admission' in descriptor && descriptor.admission === 'legacy-unclassified'))
        )
          throw new DOMException('Copy admission changed', 'AbortError');
        if ('genesisHash' in descriptor) {
          if (admittedGenesis !== undefined && admittedGenesis !== descriptor.genesisHash)
            throw new DOMException('Copy genesis changed', 'AbortError');
          admittedGenesis = descriptor.genesisHash;
        }
      };
      const admitOutput = async () => {
        assertCurrent();
        await waitForCopy(
          Promise.resolve(runtime.waitForContentAdmission?.(controller.signal)),
          controller.signal
        );
        assertCurrent();
      };
      try {
        assertSource();
        await waitForCopy(
          Promise.resolve(runtime.waitForContentAdmission?.(controller.signal)),
          controller.signal
        );
        assertCurrent();
        if (runtime.contentMode === 'e2ee') {
          const confirmed = await new Promise<boolean>((resolve) => {
            pending.current = resolve;
            setConfirming(true);
            controller.signal.addEventListener(
              'abort',
              () => {
                if (flight.current === controller) answer(false);
              },
              { once: true }
            );
          });
          if (!confirmed) return undefined;
        }
        assertCurrent();
        const result = await waitForCopy(operation(assertCurrent, admitOutput), controller.signal);
        assertCurrent();
        return result;
      } catch (error) {
        if (
          controller.signal.aborted ||
          ((error instanceof Error || error instanceof DOMException) && error.name === 'AbortError')
        )
          return undefined;
        throw error;
      } finally {
        if (flight.current === controller) {
          flight.current = null;
          answer(false);
        }
        controller.abort();
      }
    },
    [accountId, answer, enabled, platform.kind, runtime, source, store]
  );

  return {
    run,
    confirmation: <PlaintextCopyConfirmationView open={confirming} onAnswer={answer} />,
  };
}

export function PlaintextCopyConfirmationView({
  open,
  onAnswer,
}: {
  open: boolean;
  onAnswer: (confirmed: boolean) => void;
}) {
  const { t } = useTranslation();
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onAnswer(false);
      }}
    >
      <AlertDialog.Content initialFocus={() => cancel.current}>
        <AlertDialog.Header>
          <AlertDialog.Title>
            {t('export.e2ee.title', 'Create a decrypted copy?')}
          </AlertDialog.Title>
          <AlertDialog.Description>
            {t(
              'export.e2ee.disclosure',
              'This creates a readable copy outside the encrypted workspace. Anyone with access to the clipboard or saved file can read it. Later workspace revocation cannot take it back.'
            )}
          </AlertDialog.Description>
        </AlertDialog.Header>
        <AlertDialog.Footer>
          <Button ref={cancel} variant="secondary" onClick={() => onAnswer(false)}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button onClick={() => onAnswer(true)}>
            {t('export.e2ee.confirm', 'Create decrypted copy')}
          </Button>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
