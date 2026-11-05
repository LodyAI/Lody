import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Check, Copy, ExternalLink, LogIn } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import type { useMemoryProvider } from '@/hooks/use-memory-provider';
import { openExternalUrl } from '@/lib/native-browser';
import { settingsCatalog as catalog, settingsSurface as surface } from './surface';
import { FormMessage } from './form-primitives';
import { MemoryProviderHeading } from './memory-provider-heading';

/** Close enough to feel like the browser told us; far enough apart to stay quiet. */
const POLL_INTERVAL_MS = 4_000;
/** Only bounds Lody's own waiting when the provider named no deadline of its own. */
const FALLBACK_EXPIRY_SEC = 900;

/** The page goes to the system browser, so only the schemes a browser opens. */
const isWebPage = (value: string | undefined): value is string => {
  if (!value) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
};

/** What a started flow leaves on screen, with its page already vouched for. */
type StartedFlow = {
  page: string;
  userCode?: string;
  expiresInSec?: number;
  /**
   * Whether the system browser took the page. Only when it did not is the code
   * worth showing: the usual flow never needs it, and a code on screen reads
   * as something to do rather than the nothing it normally is.
   */
  opened: boolean;
};

const styles = stylex.create({
  stack: { display: 'flex', flexDirection: 'column', gap: space[3], minWidth: 0 },
  // Only the one-time-code block stacks text now; the heading is shared.
  leadText: { display: 'flex', flexDirection: 'column', gap: space[1.5], minWidth: 0 },
  block: { display: 'flex', flexDirection: 'column', gap: space[3], minWidth: 0 },
  codeRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
  },
  codeLabel: {
    margin: 0,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: colors.tertiaryLabel,
  },
  // Wide tracking and a mono face: this is read off the screen and typed into
  // a browser, so the glyphs have to stay apart to be read one at a time.
  code: {
    display: 'block',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: text.headlineSize,
    lineHeight: text.headlineLeading,
    letterSpacing: '0.14em',
    userSelect: 'all',
    color: colors.label,
  },
  // Layout only; the text itself takes the shared meta level so it sits at
  // the same grey as every other secondary line on the page.
  waiting: { display: 'flex', alignItems: 'center', gap: space[2] },
});

type Phase = 'idle' | 'starting' | 'waiting' | 'expired' | 'failed';

/**
 * The first screen of a provider nobody on this machine has signed in to yet.
 * Approval happens in a browser and comes back on its own, so the only thing
 * asked of the user here is a click — never a key pasted out of a dashboard.
 */
export function MemorySignInCard({
  logo,
  name,
  providerKey,
  autoStart,
  state,
}: {
  logo?: ReactNode;
  name: string;
  /** Picks the one-line copy that says how this provider divides a memory up. */
  providerKey: string;
  /**
   * Set when the user just asked to get the provider. The button promised to
   * set it up, so finishing that promise is not a second decision to make.
   */
  autoStart?: boolean;
  state: ReturnType<typeof useMemoryProvider>;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('idle');
  const [flow, setFlow] = useState<StartedFlow | null>(null);
  const [copied, setCopied] = useState(false);
  // Every flow carries an end: a code the provider dated, or Lody's own bound
  // when it did not. Without one a provider that stopped answering would leave
  // the card polling against nothing for as long as the page stayed open.
  const expiresAt = useRef(0);
  // The hook hands back a fresh closure each render; the interval reads the
  // current one instead of restarting every time this component re-renders.
  const poll = useRef(state.signInPoll);
  poll.current = state.signInPoll;
  const begun = useRef(false);

  useEffect(() => {
    if (phase !== 'waiting') return undefined;
    let cancelled = false;
    // One ask at a time. A tick is allowed 4s but the call behind it is
    // allowed twenty, so without this the same device code was redeemed
    // twice — and the second attempt found it spent and called the flow
    // expired on a machine that had just signed in.
    let asking = false;
    const timer = window.setInterval(() => {
      if (Date.now() > expiresAt.current) {
        setPhase('expired');
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
          // `approved` needs nothing here: the reply that carries it carries the
          // signed-in inventory too, and the panel swaps this card for the list.
          if (!cancelled && result?.signIn?.status === 'expired') setPhase('expired');
        });
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [phase]);

  const start = async () => {
    if (phase === 'starting' || phase === 'waiting') return;
    setCopied(false);
    setPhase('starting');
    const started = (await state.signIn())?.signIn;
    if (started?.status !== 'pending' || !isWebPage(started.verificationUrl)) {
      setFlow(null);
      setPhase('failed');
      return;
    }
    const page = started.verificationUrl;
    expiresAt.current = Date.now() + (started.expiresInSec ?? FALLBACK_EXPIRY_SEC) * 1000;
    setFlow({ page, userCode: started.userCode, expiresInSec: started.expiresInSec, opened: true });
    setPhase('waiting');
    const opened = await openExternalUrl(page);
    if (!opened) setFlow((current) => (current ? { ...current, opened: false } : current));
  };

  // `start` is a new closure each render, so the effect reads the current one
  // through a ref rather than restarting whenever this component re-renders.
  const starter = useRef(start);
  starter.current = start;
  useEffect(() => {
    if (!autoStart || begun.current) return;
    begun.current = true;
    void starter.current();
  }, [autoStart]);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyCode = async () => {
    if (!flow?.userCode) return;
    try {
      await navigator.clipboard.writeText(flow.userCode);
      setCopied(true);
    } catch {
      // A denied clipboard leaves the code on screen to read, which is enough.
      setCopied(false);
    }
  };

  const expiryMinutes = flow?.expiresInSec ? Math.ceil(flow.expiresInSec / 60) : null;
  const waiting = phase === 'waiting';
  // The page is in front of the user; the code is a way back to it. Showing
  // both at once makes a one-click flow look like a form to fill in.
  const stranded = waiting && flow !== null && !flow.opened;
  return (
    <div {...stylex.props(styles.stack)}>
      <MemoryProviderHeading
        logo={logo}
        name={name}
        providerKey={providerKey}
        action={
          <Button
            type="button"
            size="small"
            variant="secondary"
            disabled={phase === 'starting'}
            onClick={() => void (waiting && flow ? openExternalUrl(flow.page) : start())}
          >
            {waiting
              ? t('settings.memory.signIn.openPage')
              : phase === 'expired' || phase === 'failed'
                ? t('settings.memory.signIn.retry')
                : t('settings.memory.signIn.start', { provider: name })}
            {/* The mark follows the label here too. The install card is the
                screen immediately before this one, and an icon that swaps sides
                between them is a shift the eye has to re-find every time. */}
            {phase === 'starting' ? (
              <Spinner size="small" label={null} {...stylex.props(catalog.icon)} />
            ) : waiting ? (
              <ExternalLink {...stylex.props(catalog.icon)} />
            ) : (
              <LogIn {...stylex.props(catalog.icon)} />
            )}
          </Button>
        }
      />
      {/* A flow can go wrong in ways no poll sees — the tab closed, the wrong
          account approved. Without this the only way out is to outlast the
          code, which can be fifteen minutes. */}
      {waiting ? (
        <span role="status" {...stylex.props(styles.waiting, catalog.meta)}>
          <Spinner size="small" label={null} />
          {stranded
            ? t('settings.memory.signIn.browserBlocked')
            : t('settings.memory.signIn.waiting')}
          <Button
            type="button"
            size="small"
            variant="ghost"
            onClick={() => {
              setFlow(null);
              setPhase('idle');
            }}
          >
            {t('settings.memory.signIn.retry')}
          </Button>
        </span>
      ) : null}
      {/* Only a browser that never opened needs the code typed in by hand. */}
      {stranded && flow?.userCode ? (
        <div {...stylex.props(surface.formBlock, styles.block)}>
          <div {...stylex.props(styles.codeRow)}>
            <span {...stylex.props(styles.leadText)}>
              <span {...stylex.props(styles.codeLabel)}>
                {t('settings.memory.signIn.oneTimeCode')}
              </span>
              <code {...stylex.props(styles.code)}>{flow.userCode}</code>
              <span {...stylex.props(catalog.meta)}>
                {expiryMinutes
                  ? t('settings.memory.signIn.enterCodeWithExpiry', { minutes: expiryMinutes })
                  : t('settings.memory.signIn.enterCode')}
              </span>
            </span>
            <Button type="button" size="small" variant="ghost" onClick={() => void copyCode()}>
              {copied
                ? t('settings.memory.signIn.codeCopied')
                : t('settings.memory.signIn.copyCode')}
              {copied ? (
                <Check {...stylex.props(catalog.icon)} />
              ) : (
                <Copy {...stylex.props(catalog.icon)} />
              )}
            </Button>
          </div>
        </div>
      ) : null}
      {phase === 'expired' || phase === 'failed' ? (
        <FormMessage tone="error">
          {t(`settings.memory.signIn.${phase}`, { provider: name })}
        </FormMessage>
      ) : null}
    </div>
  );
}
