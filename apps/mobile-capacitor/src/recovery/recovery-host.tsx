import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { e2eeRecoveryVaultFeatureEnabledAtom } from '@lody/components/atoms/settings';
import {
  E2eeRecoveryHostContext,
  type E2eeRecoveryHost,
} from '@lody/components/components/settings/e2ee/recovery-host';
import { authClient } from '../auth';
import { MobileRecoveryContext } from './recovery-context';
import { mobileRecoveryPort, type FilePromptMode } from './recovery-port';
import { AlertDialog } from '@lody/components/ui/dialog';
import { Button } from '@lody/ui/button';
import { useTranslation } from 'react-i18next';
import { mobileRecoveryCopy } from './recovery-copy';

/** Offers the console the shared recovery section over this login's port, only while
 * the native recovery config exists and the feature is on, exactly when account settings mounts
 * its recovery controls. Otherwise no section is provided, so the console shows where
 * recovery can be set up instead of an empty tab. The vault engine loads on first use. */
export function MobileRecoveryHostProvider({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const [prompt, setPrompt] = useState<FilePromptMode | null>(null);
  const files = useRef<ReturnType<typeof mobileRecoveryPort>['filePrompt'] | undefined>(undefined);
  const config = useContext(MobileRecoveryContext);
  const enabled = useAtomValue(e2eeRecoveryVaultFeatureEnabledAtom);
  const session = authClient.useSession();
  const identity = session.data
    ? { accountId: session.data.user.id, sessionId: session.data.session.id }
    : null;
  const live = useRef(identity);
  live.current = identity;
  const accountId = identity?.accountId,
    sessionId = identity?.sessionId;
  const [host, setHost] = useState<{ key: string; value: E2eeRecoveryHost }>();
  const key = `${accountId}:${sessionId}`;
  useEffect(() => {
    for (const [locale, copy] of Object.entries(mobileRecoveryCopy))
      i18n.addResourceBundle(locale, 'translation', copy, true, true);
  }, [i18n]);
  useEffect(() => {
    if (!config || !enabled || !accountId || !sessionId) {
      setHost(undefined);
      return;
    }
    // One port per login: a new account or session gets a new port and a reloaded section.
    const owned = mobileRecoveryPort({
      config,
      accountId,
      sessionId,
      currentSession: () => live.current,
      onFilePrompt: setPrompt,
    });
    files.current = owned.filePrompt;
    setHost({ key: `${accountId}:${sessionId}`, value: { port: owned.port } });
    return () => {
      if (files.current === owned.filePrompt) files.current = undefined;
      owned.dispose();
    };
  }, [config, enabled, accountId, sessionId]);
  const value = config && enabled && host?.key === key ? host.value : null;
  return (
    <E2eeRecoveryHostContext.Provider value={value}>
      {children}
      <AlertDialog.Root
        open={prompt !== null}
        onOpenChange={(open) => {
          if (!open) files.current?.cancel();
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {t(prompt === 'open' ? 'e2ee.recovery.file' : 'mobileRecovery.verifyFile')}
            </AlertDialog.Title>
            {prompt === 'verify' && (
              <AlertDialog.Description>
                {t('mobileRecovery.verifyFileDescription')}
              </AlertDialog.Description>
            )}
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel onClick={() => files.current?.cancel()}>
              {t('common.cancel')}
            </AlertDialog.Cancel>
            <Button onClick={() => files.current?.pick()}>
              {t(prompt === 'open' ? 'mobileRecovery.openFile' : 'mobileRecovery.selectSavedFile')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </E2eeRecoveryHostContext.Provider>
  );
}
