import * as stylex from '@stylexjs/stylex';
import { ChevronDown } from 'lucide-react';
import { useLayoutEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { E2eeWorkspaceRuntime } from '@lody/platform';
import { Button } from '@lody/ui/button';
import { Card } from '@lody/ui/card';
import { Collapsible } from '@lody/ui/collapsible';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';
import { holdPrivateTelemetrySurface } from '@/lib/posthog-privacy';
import { E2eeAccountPairingApprove } from './e2ee-account-pairing';
import { useE2eeDeviceRequests } from './e2ee-device-requests';

/** Pauses session recording while a pairing secret or approval is on screen. */
export function usePairingPrivacy() {
  useLayoutEffect(() => {
    const release = holdPrivateTelemetrySurface();
    // Layout cleanup precedes host removal. Restart recording only after the
    // commit has removed the private DOM, including a portal's exit transition.
    return () => {
      queueMicrotask(release);
    };
  }, []);
}
export function PrivatePairingSurface({ children }: { children: ReactNode }) {
  usePairingPrivacy();
  return <>{children}</>;
}

const styles = stylex.create({
  card: { display: 'flex', flexDirection: 'column', gap: space[3] },
  cardLead: { margin: 0, color: colors.secondaryLabel },
  disclosure: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
    paddingTop: space[3],
  },
  disclosureTrigger: { alignSelf: 'flex-start' },
  callout: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    padding: space[3],
    borderRadius: radius.medium,
    backgroundColor: colors.secondaryBackground,
  },
});

type AddDeviceRuntime = Pick<
  E2eeWorkspaceRuntime,
  | 'inspectAccountPairing'
  | 'approveAccountPairing'
  | 'declineAccountPairing'
  | 'approveAutomaticPairing'
>;

/**
 * The console's Add device card. A new device signs in and opens an encrypted
 * workspace; this device then asks for the six-digit code it shows. A device
 * without automatic pairing shows an offline pairing code, entered below.
 */
export function E2eeAddDeviceCard(props: { runtime: AddDeviceRuntime }) {
  const { t } = useTranslation();
  const requests = useE2eeDeviceRequests();
  const manual = Boolean(
    props.runtime.inspectAccountPairing && props.runtime.approveAccountPairing
  );
  // A host that can approve neither way has no device to add here.
  if (!manual && !props.runtime.approveAutomaticPairing) return null;
  return (
    <Card.Root data-testid="e2ee-add-device">
      <div {...stylex.props(styles.card)}>
        <Card.Title>{t('e2ee.addDevice.title')}</Card.Title>
        <p {...stylex.props(styles.cardLead)}>{t('e2ee.addDevice.lead')}</p>
        {requests && requests.count > 0 && <E2eeWaitingRequestsCallout />}
      </div>
      {manual && (
        <Collapsible.Root>
          <div {...stylex.props(styles.disclosure)}>
            <Collapsible.Trigger
              render={
                <Button
                  variant="ghost"
                  size="small"
                  data-testid="e2ee-add-device-manual"
                  xstyle={styles.disclosureTrigger}
                />
              }
            >
              {t('e2ee.addDevice.manual')}
              <ChevronDown size={14} aria-hidden="true" />
            </Collapsible.Trigger>
            <Collapsible.Panel>
              <E2eeAccountPairingApprove runtime={props.runtime} embedded />
            </Collapsible.Panel>
          </div>
        </Collapsible.Root>
      )}
    </Card.Root>
  );
}

const AUTO_PAIR_PREFIX = 'lody://auto-pair?';
/** The new device's comparison code as a QR payload. It carries only what that screen
 * already shows: scanning it is the same as typing the code, and the approving device
 * still compares it with its own before signing. */
export const autoPairQrPayload = (id: string, code: string) =>
  `${AUTO_PAIR_PREFIX}${new URLSearchParams({ id, code }).toString()}`;
export function parseAutoPairQr(text: string): { id: string; code: string } | null {
  const value = text.trim();
  if (!value.toLowerCase().startsWith(AUTO_PAIR_PREFIX)) return null;
  const params = new URLSearchParams(value.slice(AUTO_PAIR_PREFIX.length));
  const id = params.get('id'),
    code = params.get('code');
  return id && code && /^\d{6}$/.test(code) ? { id, code } : null;
}

/** Requests already waiting, reachable from inside Settings or the console: the new
 * device's code is typed there. */
export function E2eeWaitingRequestsCallout() {
  const { t } = useTranslation();
  const requests = useE2eeDeviceRequests();
  if (!requests || requests.count === 0) return null;
  return (
    <div data-testid="e2ee-waiting-requests" {...stylex.props(styles.callout)}>
      <span>{t('e2ee.addDevice.waiting', { count: requests.count })}</span>
      <Button size="small" variant="secondary" onClick={requests.review}>
        {t('e2ee.auto.review')}
      </Button>
    </div>
  );
}
