import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import type { E2eeWorkspaceRuntime } from '@lody/platform';
import { Button } from '@lody/ui/button';
import { Card } from '@lody/ui/card';
import { Collapsible } from '@lody/ui/collapsible';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { Check, ChevronDown, Copy, Server } from 'lucide-react';
type Runtime = Pick<
  E2eeWorkspaceRuntime,
  | 'beginRemoteMachinePairing'
  | 'inspectRemoteMachinePairing'
  | 'approveRemoteMachinePairing'
  | 'cancelRemoteMachinePairing'
>;
type Preview = Awaited<ReturnType<NonNullable<Runtime['inspectRemoteMachinePairing']>>>;
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const styles = stylex.create({
  disclosure: { display: 'flex', flexDirection: 'column', gap: space[2] },
  body: { display: 'flex', flexDirection: 'column', gap: space[3] },
  actions: { display: 'flex', flexWrap: 'wrap', gap: space[2] },
  // One command line on dark ground, as it will look in the machine's terminal.
  command: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    paddingBlock: space[2],
    paddingInlineStart: space[3],
    paddingInlineEnd: space[1],
    borderRadius: radius.medium,
    backgroundColor: '#1e1e1e',
    color: '#e8e8e8',
    fontFamily: MONO,
    fontSize: text.footnoteSize,
  },
  commandText: { flexGrow: 1, minWidth: 0, overflowWrap: 'anywhere', userSelect: 'all' },
  copy: { color: '#e8e8e8' },
  machine: { display: 'flex', alignItems: 'center', gap: space[2] },
  machineName: { fontWeight: 600 },
  code: {
    fontFamily: MONO,
    fontSize: text.headlineSize,
    letterSpacing: '0.04em',
    overflowWrap: 'anywhere',
    userSelect: 'all',
  },
  message: { margin: 0, color: colors.secondaryLabel, fontSize: text.footnoteSize },
});
/** An expiring command transfers pins. A separate, material-bound click grants consent. */
export function E2eeRemoteMachinePairing({
  workspaceId,
  runtime,
}: {
  workspaceId: string;
  runtime: Runtime;
}) {
  const { t } = useTranslation();
  const [session, setSession] = useState<{ pairingSessionId: string; command: string } | null>(
    null
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // A revoked identity cannot be readmitted; the machine must create a new one.
  const [error, setError] = useState<false | 'generic' | 'key-revoked'>(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  if (
    !runtime.beginRemoteMachinePairing ||
    !runtime.inspectRemoteMachinePairing ||
    !runtime.approveRemoteMachinePairing ||
    !runtime.cancelRemoteMachinePairing
  )
    return null;
  const begin = runtime.beginRemoteMachinePairing,
    inspect = runtime.inspectRemoteMachinePairing,
    approve = runtime.approveRemoteMachinePairing,
    cancel = runtime.cancelRemoteMachinePairing;
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      await work();
    } catch (cause) {
      if (active.current)
        setError(
          cause instanceof Error && /\be2ee_pairing_key_revoked$/.test(cause.message)
            ? 'key-revoked'
            : 'generic'
        );
    } finally {
      if (active.current) setBusy(false);
    }
  };
  const refresh = async () => {
    if (!session) return;
    const next = await inspect(workspaceId, session.pairingSessionId);
    if (active.current) setPreview(next);
  };
  const terminal =
    preview && ['cancelled', 'expired', 'conflict', 'ready'].includes(preview.status);
  const location =
    [preview?.location?.city, preview?.location?.country].filter(Boolean).join(', ') ||
    t('e2ee.remoteMachine.unknown');
  return (
    <Card.Root>
      <Card.Header>
        <Card.Title>{t('e2ee.remoteMachine.title')}</Card.Title>
        <Card.Description>{t('e2ee.remoteMachine.description')}</Card.Description>
      </Card.Header>
      <div {...stylex.props(styles.body)}>
        {error && (
          <p role="alert">
            {t(
              error === 'key-revoked' ? 'e2ee.remoteMachine.keyRevoked' : 'e2ee.remoteMachine.error'
            )}
          </p>
        )}
        {session && (
          <>
            <div {...stylex.props(styles.command)}>
              <span
                aria-label={t('e2ee.remoteMachine.command')}
                {...stylex.props(styles.commandText)}
              >
                {session.command}
              </span>
              <Button
                variant="ghost"
                size="small"
                icon
                aria-label={t(copied ? 'e2ee.verify.copied' : 'e2ee.remoteMachine.copyCommand')}
                onClick={() => {
                  void navigator.clipboard.writeText(session.command).then(
                    () => {
                      if (active.current) setCopied(true);
                    },
                    // Denied clipboard: the command stays selectable.
                    () => undefined
                  );
                }}
                {...stylex.props(styles.copy)}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </Button>
            </div>
            <p {...stylex.props(styles.message)}>{t('e2ee.remoteMachine.commandHelp')}</p>
          </>
        )}
        {preview && (
          <p role="status">
            {t(
              preview.status === 'conflict' && preview.noAdmissionReserved
                ? 'e2ee.remoteMachine.status.claimedByAnotherMachine'
                : `e2ee.remoteMachine.status.${preview.status}`
            )}
          </p>
        )}
        {preview?.summary && (
          <>
            <div {...stylex.props(styles.machine)}>
              <Server size={16} aria-hidden="true" />
              <span {...stylex.props(styles.machineName)}>
                {t('e2ee.remoteMachine.machine', { id: preview.material?.machineId })}
              </span>
            </div>
            <p {...stylex.props(styles.message)}>
              {t('e2ee.remoteMachine.location', { location })} ·{' '}
              {t(
                preview.material?.protection === 'file'
                  ? 'e2ee.localAgent.fileProtection'
                  : 'e2ee.remoteMachine.osProtection'
              )}
            </p>
            <p>{t('e2ee.remoteMachine.compare')}</p>
            <p data-testid="e2ee-remote-machine-summary" {...stylex.props(styles.code)}>
              {preview.summary}
            </p>
            <p {...stylex.props(styles.message)}>{t('e2ee.remoteMachine.locationHelp')}</p>
          </>
        )}
        <div {...stylex.props(styles.actions)}>
          {!session && (
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const next = await begin(workspaceId);
                  if (active.current) {
                    setSession(next);
                    setPreview(null);
                  }
                })
              }
            >
              {t('e2ee.remoteMachine.create')}
            </Button>
          )}
          {session && !terminal && (
            <Button variant="secondary" disabled={busy} onClick={() => void run(refresh)}>
              {t('e2ee.remoteMachine.check')}
            </Button>
          )}
          {session &&
            preview?.summary &&
            ['claimed', 'admitting', 'admitted'].includes(preview.status) && (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    try {
                      await approve(workspaceId, session.pairingSessionId, preview.summary ?? '');
                    } catch (cause) {
                      // Show why approval stopped (e.g. another machine used the command);
                      // a failed refresh never replaces the original error.
                      await refresh().catch(() => undefined);
                      throw cause;
                    }
                    await refresh();
                  })
                }
              >
                {t(
                  preview.status === 'claimed'
                    ? 'e2ee.remoteMachine.allow'
                    : 'e2ee.remoteMachine.resume'
                )}
              </Button>
            )}
          {session && (!preview || !['admitting', 'admitted'].includes(preview.status)) && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await cancel(workspaceId, session.pairingSessionId);
                  if (active.current) {
                    setSession(null);
                    setPreview(null);
                  }
                })
              }
            >
              {t(terminal ? 'e2ee.remoteMachine.newCommand' : 'common.cancel')}
            </Button>
          )}
        </div>
      </div>
    </Card.Root>
  );
}

/** Remote machines are a rarer task than adding a phone: closed until asked for. The
 * panel stays mounted, so a pairing in progress survives closing it. */
export function E2eeRemoteMachineDisclosure(props: { children: ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <div {...stylex.props(styles.disclosure)}>
        <Collapsible.Trigger
          render={<Button variant="ghost" size="small" data-testid="e2ee-remote-machine-toggle" />}
        >
          <Server size={14} aria-hidden="true" />
          {t('e2ee.remoteMachine.disclosure')}
          <ChevronDown size={14} aria-hidden="true" />
        </Collapsible.Trigger>
        <Collapsible.Panel keepMounted>{props.children}</Collapsible.Panel>
      </div>
    </Collapsible.Root>
  );
}
