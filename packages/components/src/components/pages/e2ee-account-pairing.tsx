import * as stylex from '@stylexjs/stylex';
import { Result } from 'effect';
import { ScanLine } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PAIRING_URL_PREFIX, parsePairingString } from '@lody/e2ee-core/protocol';
import {
  accountPairingErrorCode,
  type E2eeAccountPairingApproval,
  type E2eeAccountPairingPreview,
  type E2eeAccountPairingRequestState,
  type E2eeWorkspaceRuntime,
} from '@lody/platform';
import { Alert } from '@lody/ui/alert';
import { Button } from '@lody/ui/button';
import { Card } from '@lody/ui/card';
import { Checkbox } from '@lody/ui/checkbox';
import { Textarea } from '@lody/ui/textarea';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text as type } from '@lody/ui/tokens/scales.stylex';
import { classifyE2eeControlFailure, custodyFailureMessage } from '@/lib/e2ee-control-failure';
import { LedgerQrCode, useQrCamera } from './e2ee-ledger-verification';

const styles = stylex.create({
  actions: { display: 'flex', flexWrap: 'wrap', gap: space[2] },
  code: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: type.titleSize,
    letterSpacing: '0.04em',
    userSelect: 'all',
    margin: 0,
  },
  qr: { backgroundColor: '#ffffff', padding: space[2], alignSelf: 'flex-start' },
  muted: { color: colors.secondaryLabel, margin: 0 },
  list: { margin: 0, paddingInlineStart: 0, listStyle: 'none', display: 'grid', gap: space[2] },
  row: { display: 'flex', alignItems: 'center', gap: space[2] },
  facts: { margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: space[2] },
  term: { color: colors.secondaryLabel },
  detail: { margin: 0 },
  video: { width: '100%', maxWidth: 320 },
});

const POLL_MS = 3000;
const time = (value: number) =>
  new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
/** QR payload of a host-supplied, possibly grouped pairing string. */
const qrPayload = (pairingString: string) =>
  PAIRING_URL_PREFIX + pairingString.replace(/[\s-]/g, '');
/** Checks a typed or scanned code locally, before any network request; the host
 * parses it again and owns the secret. The decoded bytes are wiped at once. */
function localCodeError(input: string): string | null {
  const parsed = parsePairingString(input);
  if (Result.isSuccess(parsed)) {
    parsed.success.fill(0);
    return null;
  }
  return `e2ee.accountPair.code.${parsed.failure.code}`;
}
/** Host refusals become specific messages; anything else keeps the custody wording. */
function failureKey(error: unknown) {
  const code = accountPairingErrorCode(error);
  if (code) return `e2ee.accountPair.error.${code}`;
  return custodyFailureMessage(classifyE2eeControlFailure(error).kind) ?? 'e2ee.accountPair.error.failed';
}
/** Runs `tick` every `ms` while `active`, never overlapping; the latest `tick` is used. */
function usePoll(active: boolean, ms: number, tick: () => Promise<void>) {
  const latest = useRef(tick);
  latest.current = tick;
  useEffect(() => {
    if (!active) return undefined;
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void latest.current().finally(() => {
        running = false;
      });
    }, ms);
    return () => clearInterval(timer);
  }, [active, ms]);
}
function useLive() {
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  return live;
}

type RequestRuntime = Pick<
  E2eeWorkspaceRuntime,
  'requestAccountPairing' | 'accountPairingRequest' | 'cancelAccountPairing'
>;

/**
 * New-device side. Desktop and mobile start on mount (`autoStart`); Web asks first,
 * because a browser is often shared. Shows this device's code until another of the
 * user's devices approves it, or accepts a code that device shows instead.
 */
export function E2eeAccountPairingRequest(props: {
  runtime: RequestRuntime;
  autoStart: boolean;
  onJoined: () => void;
  pollMs?: number;
}) {
  const { runtime } = props;
  const { t } = useTranslation();
  const live = useLive();
  const [state, setState] = useState<E2eeAccountPairingRequestState | null>(null);
  const [phase, setPhase] = useState<'loading' | 'idle' | 'busy' | 'ready'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [entering, setEntering] = useState(false);
  const [input, setInput] = useState('');
  const joined = useRef(false);
  const accept = (next: E2eeAccountPairingRequestState | null) => {
    if (!live.current) return;
    setState(next);
    setPhase(next ? 'ready' : 'idle');
    if (next?.status === 'joined' && !joined.current) {
      joined.current = true;
      props.onJoined();
    }
  };
  const run = async (operation: () => Promise<void>) => {
    setPhase('busy');
    setError(null);
    try {
      await operation();
    } catch (failure) {
      if (!live.current) return;
      setError(failureKey(failure));
      setPhase((current) => (current === 'busy' ? (state ? 'ready' : 'idle') : current));
    }
  };
  const start = (pairingString?: string) =>
    run(async () => accept(await runtime.requestAccountPairing!({ pairingString })));
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const retained = (await runtime.accountPairingRequest?.()) ?? null;
        if (cancelled) return;
        if (retained?.status === 'waiting' || !props.autoStart) accept(retained);
        else await start();
      } catch (failure) {
        if (cancelled) return;
        setError(failureKey(failure));
        setPhase('idle');
      }
    })();
    return () => {
      cancelled = true;
    };
    // Recovery and automatic start happen once per mounted host.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime]);
  usePoll(
    phase === 'ready' && state?.status === 'waiting' && Boolean(runtime.accountPairingRequest),
    props.pollMs ?? POLL_MS,
    async () => {
      try {
        const next = await runtime.accountPairingRequest!();
        if (next) accept(next);
      } catch (failure) {
        if (live.current) setError(failureKey(failure));
      }
    }
  );
  const restart = () =>
    run(async () => {
      await runtime.cancelAccountPairing?.();
      accept(await runtime.requestAccountPairing!({}));
    });
  const enterCode = () => {
    const local = localCodeError(input);
    if (local) return setError(local);
    setEntering(false);
    void start(input.trim());
  };
  if (!runtime.requestAccountPairing) return null;
  const terminal = state && state.status !== 'waiting' && state.status !== 'joined';
  return (
    <Card.Root data-testid="e2ee-account-pairing-request">
      <Card.Title>{t('e2ee.accountPair.request.title')}</Card.Title>
      {phase === 'idle' && !state && (
        <>
          <p {...stylex.props(styles.muted)}>{t('e2ee.accountPair.request.web')}</p>
          <div {...stylex.props(styles.actions)}>
            <Button onClick={() => void start()}>{t('e2ee.accountPair.request.start')}</Button>
          </div>
        </>
      )}
      {state?.status === 'waiting' && state.pairingString && (
        <>
          <p>{t('e2ee.accountPair.request.show')}</p>
          <div {...stylex.props(styles.qr)}>
            <LedgerQrCode
              payload={qrPayload(state.pairingString)}
              size={200}
              label={t('e2ee.accountPair.code.label')}
            />
          </div>
          <p data-testid="e2ee-account-pairing-string" {...stylex.props(styles.code)}>
            {state.pairingString}
          </p>
          <p {...stylex.props(styles.muted)}>{t('e2ee.accountPair.request.private')}</p>
        </>
      )}
      {state?.status === 'waiting' && !state.pairingString && (
        <p>{t('e2ee.accountPair.request.answered')}</p>
      )}
      {state?.status === 'waiting' && (
        <p role="status" {...stylex.props(styles.muted)}>
          {t('e2ee.accountPair.request.waiting', { time: time(state.expiresAt) })}
        </p>
      )}
      {state?.status === 'joined' && (
        <p role="status">{t('e2ee.accountPair.request.joined')}</p>
      )}
      {terminal && (
        <p role="status">{t(`e2ee.accountPair.request.${state.status}`)}</p>
      )}
      {entering && (
        <>
          <Textarea
            aria-label={t('e2ee.accountPair.code.label')}
            placeholder={t('e2ee.accountPair.code.placeholder')}
            value={input}
            maxLength={200}
            onChange={(event) => {
              setInput(event.target.value);
              setError(null);
            }}
          />
          <div {...stylex.props(styles.actions)}>
            <Button disabled={!input.trim() || phase === 'busy'} onClick={enterCode}>
              {t('e2ee.accountPair.request.useCode')}
            </Button>
          </div>
        </>
      )}
      <div {...stylex.props(styles.actions)}>
        {state && state.status !== 'joined' && (
          <Button variant="secondary" disabled={phase === 'busy'} onClick={() => void restart()}>
            {t('e2ee.accountPair.request.restart')}
          </Button>
        )}
        {!entering && state?.status !== 'joined' && (
          <Button variant="ghost" disabled={phase === 'busy'} onClick={() => setEntering(true)}>
            {t('e2ee.accountPair.request.haveCode')}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" {...stylex.props(styles.muted)}>
          {t(error)}
        </p>
      )}
    </Card.Root>
  );
}

type ApproveRuntime = Pick<
  E2eeWorkspaceRuntime,
  | 'accountPairingCode'
  | 'inspectAccountPairing'
  | 'approveAccountPairing'
  | 'declineAccountPairing'
>;
type ApprovePhase =
  | { kind: 'enter' }
  | { kind: 'showing'; pairingString: string; expiresAt: number }
  | { kind: 'confirm'; pairingString: string; preview: E2eeAccountPairingPreview }
  | { kind: 'done'; result: E2eeAccountPairingApproval; preview: E2eeAccountPairingPreview }
  | { kind: 'declined' };

/**
 * Approving side, on an already approved personal device. The host verifies the
 * request before anything is shown; the user then reads the fixed warning, sees the
 * named target and its scope, and may deselect any workspace before approving.
 */
export function E2eeAccountPairingApprove(props: { runtime: ApproveRuntime; pollMs?: number }) {
  const { runtime } = props;
  const { t } = useTranslation();
  const live = useLive();
  const [phase, setPhase] = useState<ApprovePhase>({ kind: 'enter' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [camera, setCamera] = useState(false);
  const cameraSupported =
    typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (failure) {
      if (live.current) setError(failureKey(failure));
    } finally {
      if (live.current) setBusy(false);
    }
  };
  const confirm = (pairingString: string, preview: E2eeAccountPairingPreview) => {
    setSelected(new Set(preview.workspaces.map((workspace) => workspace.workspaceId)));
    setPhase({ kind: 'confirm', pairingString, preview });
  };
  const check = (code: string) => {
    const local = localCodeError(code);
    if (local) return setError(local);
    const pairingString = code.trim();
    void run(async () => {
      const preview = await runtime.inspectAccountPairing!(pairingString);
      if (!live.current) return;
      if (!preview) setError('e2ee.accountPair.approve.notFound');
      else confirm(pairingString, preview);
    });
  };
  const { video, state: cameraState } = useQrCamera(camera, (scanned) => {
    setCamera(false);
    setInput(scanned);
    check(scanned);
  });
  usePoll(
    phase.kind === 'showing' && Boolean(runtime.inspectAccountPairing),
    props.pollMs ?? POLL_MS,
    async () => {
      if (phase.kind !== 'showing') return;
      try {
        const preview = await runtime.inspectAccountPairing!(phase.pairingString);
        if (preview && live.current) confirm(phase.pairingString, preview);
      } catch (failure) {
        if (live.current) setError(failureKey(failure));
      }
    }
  );
  if (!runtime.inspectAccountPairing || !runtime.approveAccountPairing) return null;
  const reset = () => {
    setPhase({ kind: 'enter' });
    setInput('');
    setError(null);
  };
  return (
    <Card.Root data-testid="e2ee-account-pairing-approve">
      <Card.Title>{t('e2ee.accountPair.approve.title')}</Card.Title>
      {phase.kind === 'enter' && (
        <>
          <p {...stylex.props(styles.muted)}>{t('e2ee.accountPair.approve.lead')}</p>
          {cameraSupported &&
            (camera ? (
              <video ref={video} muted playsInline {...stylex.props(styles.video)} />
            ) : (
              <Button variant="secondary" onClick={() => setCamera(true)}>
                <ScanLine size={16} aria-hidden="true" />
                {t('e2ee.accountPair.approve.scan')}
              </Button>
            ))}
          {cameraState === 'unavailable' && (
            <p {...stylex.props(styles.muted)}>{t('e2ee.verify.cameraUnavailable')}</p>
          )}
          <Textarea
            aria-label={t('e2ee.accountPair.code.label')}
            placeholder={t('e2ee.accountPair.code.placeholder')}
            value={input}
            maxLength={200}
            onChange={(event) => {
              setInput(event.target.value);
              setError(null);
            }}
          />
          <div {...stylex.props(styles.actions)}>
            <Button disabled={!input.trim() || busy} onClick={() => check(input)}>
              {t('e2ee.accountPair.approve.check')}
            </Button>
            {runtime.accountPairingCode && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const offer = await runtime.accountPairingCode!();
                    if (live.current) setPhase({ kind: 'showing', ...offer });
                  })
                }
              >
                {t('e2ee.accountPair.approve.showInstead')}
              </Button>
            )}
          </div>
        </>
      )}
      {phase.kind === 'showing' && (
        <>
          <p>{t('e2ee.accountPair.approve.showing')}</p>
          <div {...stylex.props(styles.qr)}>
            <LedgerQrCode
              payload={qrPayload(phase.pairingString)}
              size={200}
              label={t('e2ee.accountPair.code.label')}
            />
          </div>
          <p data-testid="e2ee-account-pairing-string" {...stylex.props(styles.code)}>
            {phase.pairingString}
          </p>
          <p role="status" {...stylex.props(styles.muted)}>
            {t('e2ee.accountPair.request.waiting', { time: time(phase.expiresAt) })}
          </p>
          <div {...stylex.props(styles.actions)}>
            <Button variant="ghost" onClick={reset}>
              {t('common.cancel')}
            </Button>
          </div>
        </>
      )}
      {phase.kind === 'confirm' && (
        <>
          <Alert.Root tone="warning">
            <Alert.Title>{t('e2ee.accountPair.approve.warningTitle')}</Alert.Title>
            <Alert.Description>{t('e2ee.accountPair.approve.warning')}</Alert.Description>
          </Alert.Root>
          <dl {...stylex.props(styles.facts)}>
            <dt {...stylex.props(styles.term)}>{t('e2ee.accountPair.approve.device')}</dt>
            <dd data-testid="e2ee-account-pairing-device" {...stylex.props(styles.detail)}>
              {phase.preview.deviceName}
            </dd>
            <dt {...stylex.props(styles.term)}>{t('e2ee.accountPair.approve.location')}</dt>
            <dd {...stylex.props(styles.detail)}>
              {phase.preview.approximateLocation ?? t('e2ee.accountPair.approve.locationUnknown')}
            </dd>
            <dt {...stylex.props(styles.term)}>{t('e2ee.accountPair.approve.requestedAt')}</dt>
            <dd {...stylex.props(styles.detail)}>{time(phase.preview.requestedAt)}</dd>
          </dl>
          <p>
            {t('e2ee.accountPair.approve.scope', {
              count: selected.size,
              total: phase.preview.workspaces.length,
            })}
          </p>
          <ul {...stylex.props(styles.list)}>
            {phase.preview.workspaces.map((workspace) => (
              <li key={workspace.workspaceId} {...stylex.props(styles.row)}>
                <Checkbox
                  checked={selected.has(workspace.workspaceId)}
                  aria-label={workspace.name}
                  data-workspace-id={workspace.workspaceId}
                  onCheckedChange={(checked) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (checked) next.add(workspace.workspaceId);
                      else next.delete(workspace.workspaceId);
                      return next;
                    })
                  }
                />
                <span>{workspace.name}</span>
              </li>
            ))}
          </ul>
          {phase.preview.unavailable.length > 0 && (
            <p {...stylex.props(styles.muted)}>
              {t('e2ee.accountPair.approve.unavailable', {
                names: phase.preview.unavailable.map((workspace) => workspace.name).join(', '),
              })}
            </p>
          )}
          <div {...stylex.props(styles.actions)}>
            <Button
              disabled={busy || selected.size === 0}
              onClick={() =>
                void run(async () => {
                  const result = await runtime.approveAccountPairing!({
                    pairingString: phase.pairingString,
                    requestId: phase.preview.requestId,
                    // Keep the host's order; only the user's choice changes the set.
                    workspaceIds: phase.preview.workspaces
                      .map((workspace) => workspace.workspaceId)
                      .filter((id) => selected.has(id)),
                  });
                  if (live.current) setPhase({ kind: 'done', result, preview: phase.preview });
                })
              }
            >
              {t('e2ee.accountPair.approve.approve', { device: phase.preview.deviceName })}
            </Button>
            {runtime.declineAccountPairing && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await runtime.declineAccountPairing!({
                      pairingString: phase.pairingString,
                      requestId: phase.preview.requestId,
                    });
                    if (live.current) setPhase({ kind: 'declined' });
                  })
                }
              >
                {t('e2ee.accountPair.approve.decline')}
              </Button>
            )}
            <Button variant="ghost" disabled={busy} onClick={reset}>
              {t('common.cancel')}
            </Button>
          </div>
        </>
      )}
      {phase.kind === 'done' && (
        <>
          <ul {...stylex.props(styles.list)} aria-live="polite">
            {phase.result.workspaces.map((item) => (
              <li key={item.workspaceId} data-outcome={item.outcome}>
                {t(`e2ee.accountPair.outcome.${item.outcome}`, {
                  name:
                    phase.preview.workspaces.find(
                      (workspace) => workspace.workspaceId === item.workspaceId
                    )?.name ?? item.workspaceId,
                })}
              </li>
            ))}
          </ul>
          <div {...stylex.props(styles.actions)}>
            <Button variant="secondary" onClick={reset}>
              {t('e2ee.accountPair.approve.another')}
            </Button>
          </div>
        </>
      )}
      {phase.kind === 'declined' && (
        <>
          <p role="status">{t('e2ee.accountPair.approve.declined')}</p>
          <div {...stylex.props(styles.actions)}>
            <Button variant="secondary" onClick={reset}>
              {t('e2ee.accountPair.approve.another')}
            </Button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" {...stylex.props(styles.muted)}>
          {t(error)}
        </p>
      )}
    </Card.Root>
  );
}
