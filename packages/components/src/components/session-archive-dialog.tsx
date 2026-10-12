import { useAtom } from 'jotai';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import { Button } from '@lody/ui/button';
import { Dialog } from '@lody/ui/dialog';
import { sessionArchiveDialogAtom } from '@/atoms/session-archive';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';

/** All manual entry points share one confirmation, including a pending archive's override. */
export function SessionArchiveDialog() {
  const [request, setRequest] = useAtom(sessionArchiveDialogAtom);
  const waitButton = useRef<HTMLButtonElement>(null);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const { t } = useTranslation();
  useEffect(
    () => () => {
      setRequest((current) => {
        current?.resolve(null);
        return null;
      });
    },
    [runtime, setRequest]
  );
  const finish = (mode: 'wait' | 'immediate' | null) => {
    setRequest(null);
    request?.resolve(mode);
  };
  return (
    <Dialog.Root
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <Dialog.Content initialFocus={() => waitButton.current}>
        <Dialog.Header>
          <Dialog.Title>
            {t('sessions.deferredArchive.title', 'Archive this conversation group?')}
          </Dialog.Title>
          <Dialog.Description>
            {t(
              'sessions.deferredArchive.description',
              '{{count}} conversations are included. Wait for running work and queued messages to finish, or archive immediately and interrupt unfinished work.',
              { count: request?.count ?? 0 }
            )}
          </Dialog.Description>
        </Dialog.Header>
        <Dialog.Footer>
          <Button variant="secondary" onClick={() => finish(null)}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button variant="destructive" onClick={() => finish('immediate')}>
            {t('sessions.deferredArchive.immediate', 'Archive immediately')}
          </Button>
          <Button ref={waitButton} onClick={() => finish('wait')}>
            {t('sessions.deferredArchive.wait', 'Archive when finished')}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}
