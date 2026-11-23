import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { e2eeRecoveryVaultFeatureEnabledAtom } from '@lody/components/atoms/settings';
import {
  E2eeRecoveryHostContext,
  type E2eeRecoveryHost,
} from '@lody/components/components/settings/e2ee/recovery-host';
import { authClient } from '../auth';
import { MobileRecoveryContext } from './recovery-context';
import { mobileRecoveryPort } from './recovery-port';
import { chooseRecoveryFile } from '@lody/client-e2ee/recovery-port';
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
  const [confirming, setConfirming] = useState(false);
  const confirmation = useRef<
    | {
        resolve: (file: Uint8Array | null) => void;
        reject: (error: unknown) => void;
      }
    | undefined
  >(undefined);
  const cancelConfirmation = () => {
    confirmation.current?.resolve(null);
    confirmation.current = undefined;
    setConfirming(false);
  };
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
      confirmSavedFile: () =>
        new Promise((resolve, reject) => {
          confirmation.current = { resolve, reject };
          setConfirming(true);
        }),
    });
    setHost({ key: `${accountId}:${sessionId}`, value: { port: owned.port } });
    return () => {
      owned.dispose();
      confirmation.current?.resolve(null);
      confirmation.current = undefined;
      setConfirming(false);
    };
  }, [config, enabled, accountId, sessionId]);
  const value = config && enabled && host?.key === key ? host.value : null;
  return (
    <E2eeRecoveryHostContext.Provider value={value}>
      {children}
      <AlertDialog.Root
        open={confirming}
        onOpenChange={(open) => {
          if (!open) cancelConfirmation();
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{t('mobileRecovery.verifyFile')}</AlertDialog.Title>
            <AlertDialog.Description>
              {t('mobileRecovery.verifyFileDescription')}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel onClick={cancelConfirmation}>
              {t('common.cancel')}
            </AlertDialog.Cancel>
            <Button
              onClick={() => {
                // Capture this prompt before any await; never answer a later login's prompt.
                const answer = confirmation.current;
                confirmation.current = undefined;
                setConfirming(false);
                void chooseRecoveryFile().then(
                  (file) => answer?.resolve(file),
                  (error: unknown) => answer?.reject(error)
                );
              }}
            >
              {t('mobileRecovery.selectSavedFile')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </E2eeRecoveryHostContext.Provider>
  );
}
