import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Download, ExternalLink, RefreshCw } from 'lucide-react';
import type { MemoryInstallFailure, MemoryProviderResponse } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { space } from '@lody/ui/tokens/scales.stylex';
import type { useMemoryProvider } from '@/hooks/use-memory-provider';
import { openExternalUrl } from '@/lib/native-browser';
import { settingsCatalog as catalog } from './surface';
import { FormMessage } from './form-primitives';
import { MemoryProviderHeading, memoryProviderActions } from './memory-provider-heading';

/** A download, so slower than a sign-in poll and worth asking after less often. */
const POLL_INTERVAL_MS = 5_000;
/**
 * How long to keep asking before calling it off. A reply that never carries a
 * job — a machine that went offline mid-install, a transport error — is not a
 * reason to stop on its own, so without a deadline the card spins forever.
 */
// Room for a Node.js download before the provider's own install, when the
// machine needs one first.
const RUN_BUDGET_MS = 20 * 60_000;

const styles = stylex.create({
  stack: { display: 'flex', flexDirection: 'column', gap: space[3], minWidth: 0 },
  // Layout only; the text itself takes the shared meta level so it sits at
  // the same grey as every other secondary line on the page.
  waiting: { display: 'flex', alignItems: 'center', gap: space[2] },
});

type Phase = 'idle' | 'running' | 'stranded' | 'failed';

/**
 * Whether an install that reported `done` actually put the provider where this
 * machine can reach it. A fresh machine answers `not_running` — installed, and
 * nobody signed in yet — which is success and the cue for the sign-in card.
 * Reading only `ready` as success called the ordinary outcome a failure and
 * stopped the install from carrying on into the sign-in it promised.
 */
const landed = (status: MemoryProviderResponse['status']): boolean =>
  status === 'ready' || status === 'not_running';

/**
 * The screen for a provider this machine cannot use yet. Every provider on the
 * page gets the same card, named and described the same way, so the choice
 * between them is a choice between what they do — not an artefact of one
 * having been given a heading and the other a loose sentence.
 *
 * What the button does differs: a provider Lody can fetch is installed in
 * place, and one it cannot is a trip to its own page. The arrow says which.
 */
export function MemoryInstallCard({
  logo,
  name,
  providerKey,
  installUrl,
  reason,
  onInstalled,
  state,
}: {
  logo?: ReactNode;
  name: string;
  /** Picks the copy that says how this provider divides a memory up. */
  providerKey: string;
  installUrl?: string;
  /** `undefined` for a provider Lody cannot install; the link is the action. */
  reason?: 'missing' | 'unreadable';
  /** Told once the fetch lands, so the next step can start without a click. */
  onInstalled?: () => void;
  state: ReturnType<typeof useMemoryProvider>;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('idle');
  /** What the daemon recognised about the last failure, if anything. */
  const [failure, setFailure] = useState<MemoryInstallFailure>();
  /** Which part of the install the daemon last said it was on. */
  const [step, setStep] = useState<'runtime' | 'provider'>();
  // The hook hands back a fresh closure each render; the interval reads the
  // current one rather than restarting every time this component re-renders.
  const poll = useRef(state.installPoll);
  poll.current = state.installPoll;
  // Same reason as the poll above: a fresh closure each render, read through
  // a ref so the interval is not torn down and rebuilt on every one.
  const installed = useRef(onInstalled);
  installed.current = onInstalled;
  const endsAt = useRef(0);

  useEffect(() => {
    if (phase !== 'running') return undefined;
    let cancelled = false;
    // One ask at a time: each poll probes EverCLI, which is allowed longer
    // than the gap between ticks, so they would otherwise pile up.
    let asking = false;
    const timer = window.setInterval(() => {
      if (Date.now() > endsAt.current) {
        setPhase('failed');
        return;
      }
      if (asking) return;
      asking = true;
      void poll
        .current()
        .finally(() => {
          asking = false;
        })
        .then((result) => {
          if (cancelled || !result?.install) return;
          setStep(result.install.step);
          if (result.install.status === 'failed') {
            setFailure(result.install.failure);
            setPhase('failed');
          }
          // Landed and reachable: done. `not_running` counts — a machine that
          // never had EverCLI has nobody signed in on it, which is the whole
          // reason the next card exists. Only a provider that still cannot be
          // seen at all is stranded.
          else if (result.install.status === 'done') {
            const settled = landed(result.status);
            setPhase(settled ? 'idle' : 'stranded');
            if (settled) installed.current?.();
          }
        });
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [phase]);

  const start = async () => {
    if (phase === 'running') return;
    endsAt.current = Date.now() + RUN_BUDGET_MS;
    setFailure(undefined);
    setStep(undefined);
    setPhase('running');
    const result = await state.install();
    // No job in the reply means the request never reached one — an offline
    // machine, a transport error. Waiting on a job nobody started is the hang
    // this guard exists to prevent.
    if (!result?.install || result.install.status === 'failed') {
      setFailure(result?.install?.failure);
      setPhase('failed');
    } else if (result.install.status === 'done') {
      // Same reading as the poll.
      const settled = landed(result.status);
      setPhase(settled ? 'idle' : 'stranded');
      if (settled) installed.current?.();
    }
  };

  return (
    <div {...stylex.props(styles.stack)}>
      <MemoryProviderHeading
        logo={logo}
        name={name}
        providerKey={providerKey}
        {...(reason === 'unreadable'
          ? { description: t(`settings.memory.setUp.about.unreadable.${providerKey}`) }
          : {})}
      />
      <span {...stylex.props(memoryProviderActions)}>
        {reason ? (
          <Button
            type="button"
            variant="secondary"
            disabled={phase === 'running'}
            onClick={() => void start()}
          >
            {/* The mark follows the label on every provider's button, so the
                pair reads as one phrase and the icon always means the same
                thing in the same place relative to the words. */}
            {phase === 'failed' || phase === 'stranded'
              ? t('settings.memory.setUp.retry')
              : t(`settings.memory.setUp.action.${reason}`, { provider: name })}
            {phase === 'running' ? (
              <Spinner size="small" label={null} {...stylex.props(catalog.icon)} />
            ) : reason === 'unreadable' ? (
              <RefreshCw {...stylex.props(catalog.icon)} />
            ) : (
              <Download {...stylex.props(catalog.icon)} />
            )}
          </Button>
        ) : null}
        {/* The arrow marks the one that leaves Lody. Two identical buttons,
            one of which silently installs software, is the thing to avoid. */}
        {installUrl && (!reason || phase === 'failed' || phase === 'stranded') ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => void openExternalUrl(installUrl)}
          >
            {t(reason ? 'settings.memory.setUp.openPage' : 'settings.memory.setUp.get', {
              provider: name,
            })}
            <ExternalLink {...stylex.props(catalog.icon)} />
          </Button>
        ) : null}
      </span>
      {phase === 'running' && reason ? (
        <span role="status" {...stylex.props(styles.waiting, catalog.meta)}>
          <Spinner size="small" label={null} />
          {t(
            step === 'runtime'
              ? 'settings.memory.setUp.running.runtime'
              : `settings.memory.setUp.running.${reason}`,
            { provider: name }
          )}
        </span>
      ) : null}
      {phase === 'failed' || phase === 'stranded' ? (
        <FormMessage tone="error">
          {t(
            // A recognised cause names its own way out; anything else keeps
            // the general advice.
            phase === 'failed' && failure
              ? [
                  `settings.memory.setUp.failed.${failure}.${providerKey}`,
                  `settings.memory.setUp.failed.${failure}`,
                ]
              : `settings.memory.setUp.${phase}`,
            { provider: name }
          )}
        </FormMessage>
      ) : null}
    </div>
  );
}
