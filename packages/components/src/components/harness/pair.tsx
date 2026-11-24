/*
 * Pairing: how a machine joins the workspace. Used as the whole empty state
 * and, later, inside the "Pair a device" sheet from the device switcher.
 *
 * Each method resolves into the same success moment, so the user learns one
 * pattern: pick where the agent runs → do one thing → see the device arrive.
 *
 * What is real here: 'This computer' surfaces the desktop machine
 * (`localMachineIdAtom`); 'Remote machine' runs the E2EE pairing offer —
 * `beginRemoteMachinePairing` produces the command the user pastes, and
 * `inspectRemoteMachinePairing` polls until the CLI claims, at which point
 * `approveRemoteMachinePairing` admits it. 'Cloud sandbox' has no backend
 * yet: the panel is drawn, but its action is inert rather than fake.
 */
import { useEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, Terminal } from 'lucide-react';
import { useAtomValue } from 'jotai';
import type { E2eeWorkspaceRuntime } from '@lody/platform';
import { usePlatform } from '@lody/platform/react';
import type { MachineId, MachineViewMeta } from '@lody/shared';
import type { RemoteMachineStatus } from '@lody/shared/e2ee-remote-pairing';

import { localMachineIdAtom } from '@/atoms/local-probe';
import { getMachineMetaMapAtom } from '@/atoms/machines';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { useOptionalAuthenticatedConvex } from '@/hooks/use-authenticated-convex';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useMachineOnlineStatus } from '@/hooks/use-machine-online-status';

import { BRAND, PAIR_METHODS, type DeviceKind, type PairMethod } from './catalog';
import {
  Button,
  DeviceGlyph,
  DrawnCheck,
  Spinner,
  StatusDot,
  soft,
  spring,
  useCopy,
  CopyIcon,
} from './primitives';
import { parts } from './parts';
import { machineKind, machineToDevice } from './machines';
import { harness } from './store';
import { pairStyles as s } from './pair.styles';

type Phase = 'idle' | 'working' | 'done';

/** The port the remote flow needs; `runtime` carries the pairing methods,
 * not the `e2eeWorkspaces` port itself (they live on the runtime). */
type RemotePairingRuntime = Required<
  Pick<
    E2eeWorkspaceRuntime,
    | 'beginRemoteMachinePairing'
    | 'inspectRemoteMachinePairing'
    | 'approveRemoteMachinePairing'
    | 'cancelRemoteMachinePairing'
  >
>;
/** `inspect` replies add the human-readable summary the status lacks. */
type RemoteInspection = RemoteMachineStatus & { summary: string | null };

/**
 * The desktop machine's meta for the 'This computer' card — the same index
 * the device list reads, so the card and the row agree on the name.
 */
function useLocalMachine(): MachineViewMeta | null {
  const localMachineId = useAtomValue(localMachineIdAtom);
  const authed = useOptionalAuthenticatedConvex();
  if (!authed) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- one branch per mount
    const machines = useAtomValue(getMachineMetaMapAtom);
    return localMachineId ? (machines.get(localMachineId) ?? null) : null;
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks -- the branch is stable
  const { machines } = useVisibleMachineMetas();
  return localMachineId ? (machines.get(localMachineId) ?? null) : null;
}

/**
 * Whether the remote flow can run: an E2EE workspace and the platform's
 * `e2eeWorkspaces.runtime` carrying all four pairing methods. Anything less
 * leaves the card unavailable rather than faking a command.
 */
function useE2eePairingPort(): {
  runtime: RemotePairingRuntime | null;
  workspaceId: string | null;
  reason: string | null;
} {
  const platform = usePlatform();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const runtime = platform.e2eeWorkspaces?.runtime ?? null;
  const hasMethods =
    !!runtime?.beginRemoteMachinePairing &&
    !!runtime?.inspectRemoteMachinePairing &&
    !!runtime?.approveRemoteMachinePairing &&
    !!runtime?.cancelRemoteMachinePairing;
  const ready = !!workspaceId && hasMethods;
  return {
    runtime: ready ? (runtime as RemotePairingRuntime) : null,
    workspaceId: ready ? workspaceId : null,
    reason: ready ? null : !workspaceId ? 'Not in a workspace' : 'E2EE workspaces only',
  };
}

export function PairPanel({
  onPaired,
  onMethod,
  onPhase,
}: {
  /** Called with the real `MachineId` once the machine is admitted. */
  onPaired?: (machineId: MachineId) => void;
  onMethod?: (method: PairMethod | null) => void;
  onPhase?: (phase: Phase) => void;
}) {
  const [method, setMethod] = useState<PairMethod | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [pairedId, setPairedId] = useState<MachineId | null>(null);
  const localMachine = useLocalMachine();
  const e2ee = useE2eePairingPort();
  const localStatus = useMachineOnlineStatus(localMachine?.id);

  useEffect(() => onMethod?.(method), [method, onMethod]);
  useEffect(() => onPhase?.(phase), [phase, onPhase]);

  // The success moment: the id is already a real machine, so the sheet
  // selects it and reports it — nothing is minted into the store.
  const complete = (machineId: MachineId) => {
    setPairedId(machineId);
    setPhase('done');
    harness.select(machineId);
    window.setTimeout(() => onPaired?.(machineId), 1150);
  };

  const localAvailable = !!localMachine;
  const availability = (option: PairMethod): string | null =>
    option === 'local' && !localAvailable
      ? 'Desktop app only'
      : option === 'remote' && !e2ee.runtime
        ? (e2ee.reason ?? 'Unavailable')
        : option === 'cloud'
          ? 'Not yet available'
          : null;

  const pairedDevice =
    method === 'local' && localMachine
      ? {
          kind: machineKind(localMachine),
          name: localMachine.name || 'This computer',
          detail: 'this machine',
        }
      : {
          kind: 'server' as DeviceKind,
          name: pairedId ?? 'Machine',
          detail: 'end-to-end encrypted',
        };

  return (
    <div {...stylex.props(s.pair)}>
      <div {...stylex.props(s.methods)} role="radiogroup" aria-label="Where should the agent run?">
        {PAIR_METHODS.filter((option) => !option.hidden).map((option, index) => {
          const active = method === option.id;
          const unavailable = availability(option.id);
          const disabled = (phase !== 'idle' && !active) || !!unavailable;
          return (
            <motion.button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={active}
              title={unavailable ?? undefined}
              {...stylex.props(s.method, active && s.methodActive, disabled && s.methodDisabled)}
              disabled={disabled}
              onClick={() => phase === 'idle' && !unavailable && setMethod(option.id)}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...soft, delay: 0.12 + index * 0.05 }}
            >
              <span {...stylex.props(s.methodGlyph)}>
                <DeviceGlyph kind={option.kind} size={26} />
              </span>
              <span {...stylex.props(s.methodTitle)}>
                {option.title}
                {unavailable ? (
                  <span {...stylex.props(parts.tag)}>{unavailable}</span>
                ) : option.tag ? (
                  <span {...stylex.props(parts.tag, parts.tagOk)}>
                    <StatusDot status="live" />
                    {option.tag}
                  </span>
                ) : null}
              </span>
              <span {...stylex.props(s.methodBody)}>{option.body}</span>
              <span
                {...stylex.props(s.methodRadio, active && s.methodRadioActive)}
                aria-hidden="true"
              />
            </motion.button>
          );
        })}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {method ? (
          <motion.div
            key={method}
            {...stylex.props(s.detail)}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={soft}
          >
            <div {...stylex.props(s.inner)}>
              {phase === 'done' ? (
                <Paired
                  kind={pairedDevice.kind}
                  name={pairedDevice.name}
                  detail={pairedDevice.detail}
                />
              ) : method === 'local' ? (
                <LocalPair
                  phase={phase}
                  machine={localMachine}
                  status={localStatus}
                  onStart={() => setPhase('working')}
                  onDone={complete}
                />
              ) : method === 'remote' ? (
                e2ee.runtime && e2ee.workspaceId ? (
                  <RemotePair
                    workspaceId={e2ee.workspaceId}
                    runtime={e2ee.runtime}
                    onStart={() => setPhase('working')}
                    onDone={complete}
                  />
                ) : null
              ) : (
                <CloudPair />
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Paired({ kind, name, detail }: { kind: DeviceKind; name: string; detail: string }) {
  return (
    <motion.div
      {...stylex.props(s.paired)}
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={spring}
    >
      <span {...stylex.props(s.pairedGlyph)}>
        <DeviceGlyph kind={kind} size={22} />
        <span {...stylex.props(s.pairedBadge)}>
          <DrawnCheck size={10} />
        </span>
      </span>
      <span>
        <strong {...stylex.props(s.pairedTitle)}>{name} is connected</strong>
        <small {...stylex.props(s.pairedMeta)}>{detail} · setting up the harness…</small>
      </span>
    </motion.div>
  );
}

function LocalPair({
  phase,
  machine,
  status,
  onStart,
  onDone,
}: {
  phase: Phase;
  machine: MachineViewMeta | null;
  status: 'online' | 'offline' | 'unknown';
  onStart: () => void;
  onDone: (machineId: MachineId) => void;
}) {
  // The machine is already paired in reality — the card just selects it, so
  // the "working" beat is only long enough to let the check draw in.
  useEffect(() => {
    if (phase !== 'working' || !machine) return;
    const timer = window.setTimeout(() => onDone(machine.id), 1300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, machine?.id]);

  if (!machine) {
    return (
      <p {...stylex.props(s.lede)}>
        This device can only run agents inside the {BRAND} desktop app.
      </p>
    );
  }

  const device = machineToDevice(machine, status);
  return (
    <div {...stylex.props(s.split)}>
      <div {...stylex.props(s.facts)}>
        <Fact label="Device" value={device.name} />
        <Fact label="System" value={device.os || '—'} />
        <Fact label="Runtime" value={device.version ? `${BRAND} ${device.version}` : BRAND} />
      </div>
      <Button variant="primary" size="lg" onClick={onStart} disabled={phase === 'working'}>
        {phase === 'working' ? (
          <>
            <Spinner /> Pairing
          </>
        ) : (
          <>
            Use this computer <ArrowRight size={14} />
          </>
        )}
      </Button>
    </div>
  );
}

const POLL_MS = 2000;
const TERMINAL = new Set<RemoteMachineStatus['status']>(['expired', 'conflict', 'cancelled']);

/**
 * The remote offer: begin → the real command → inspect until the remote CLI
 * claims → approve → admitted. Every label the listen line shows is a literal
 * wire status; the TTL ring reads the offer's own `expiresAt`.
 */
function RemotePair({
  workspaceId,
  runtime,
  onStart,
  onDone,
}: {
  workspaceId: string;
  runtime: RemotePairingRuntime;
  onStart: () => void;
  onDone: (machineId: MachineId) => void;
}) {
  const [offer, setOffer] = useState<{
    pairingSessionId: string;
    command: string;
    offeredAt: number;
  } | null>(null);
  const [beginError, setBeginError] = useState<Error | null>(null);
  const [status, setStatus] = useState<RemoteInspection | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { copied, copy } = useCopy();
  const active = useRef(true);
  const approving = useRef(false);
  const doneRef = useRef(false);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  // There is nothing to show before the command exists, so begin fires on
  // mount; the reply already carries the first status.
  useEffect(() => {
    let cancelled = false;
    runtime.beginRemoteMachinePairing!(workspaceId)
      .then((result) => {
        if (cancelled || !active.current) return;
        setOffer({
          pairingSessionId: result.pairingSessionId,
          command: result.command,
          offeredAt: Date.now(),
        });
        setStatus({ ...result, summary: null });
      })
      .catch((error) => {
        if (!cancelled && active.current) {
          setBeginError(error instanceof Error ? error : new Error(String(error)));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [runtime, workspaceId]);

  // Claimed → approve once. The harness admits on sight: the user committed
  // by starting this flow, and the summary is still passed through so the
  // CLI compares the same material the control page would show.
  useEffect(() => {
    if (!offer || !status || status.status !== 'claimed' || !status.summary) return;
    if (approving.current) return;
    approving.current = true;
    onStart();
    void (async () => {
      try {
        await runtime.approveRemoteMachinePairing!(
          workspaceId,
          offer.pairingSessionId,
          status.summary!
        );
      } catch {
        // The next inspect answers with the wire truth; nothing is faked.
      } finally {
        approving.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offer?.pairingSessionId, status?.status, status?.summary, runtime, workspaceId, onStart]);

  // Poll inspect on a fixed interval until a terminal status or unmount.
  useEffect(() => {
    if (!offer) return;
    let cancelled = false;
    let timer: number | null = null;
    const tick = async () => {
      try {
        const next = await runtime.inspectRemoteMachinePairing!(
          workspaceId,
          offer.pairingSessionId
        );
        if (cancelled || !active.current || doneRef.current) return;
        setStatus(next);
        if (!TERMINAL.has(next.status)) timer = window.setTimeout(tick, POLL_MS);
      } catch {
        if (!cancelled && !doneRef.current) timer = window.setTimeout(tick, POLL_MS);
      }
    };
    timer = window.setTimeout(tick, POLL_MS);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offer?.pairingSessionId, runtime, workspaceId]);

  const machineId = status?.material?.machineId ?? null;

  // admitted/ready: the machine is real — select it and let the list show it.
  useEffect(() => {
    if (doneRef.current || !machineId || !status) return;
    if (status.status !== 'admitted' && status.status !== 'ready') return;
    doneRef.current = true;
    onDone(machineId as MachineId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.status, machineId]);

  // A pending offer must not outlive the sheet that created it.
  useEffect(
    () => () => {
      if (offer && !doneRef.current) {
        runtime.cancelRemoteMachinePairing!(workspaceId, offer.pairingSessionId).catch(() => {});
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [offer?.pairingSessionId, runtime, workspaceId]
  );

  // The TTL ring reads the offer's real expiry, ticking once a second.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const expiresAt = status?.expiresAt ?? null;
  const leftSeconds = expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : null;
  // The ring scales to the offer's own lifetime (expiry minus when it was
  // issued), so it does not stretch as `now` ticks.
  const ttlTotal =
    offer && expiresAt ? Math.max(1, Math.ceil((expiresAt - offer.offeredAt) / 1000)) : 600;
  const mm = leftSeconds === null ? '--' : String(Math.floor(leftSeconds / 60)).padStart(2, '0');
  const ss = leftSeconds === null ? '--' : String(leftSeconds % 60).padStart(2, '0');

  const claimed = !!status && ['claimed', 'admitting', 'admitted', 'ready'].includes(status.status);
  const machineLabel =
    status?.material?.machineId ?? (status?.summary ? 'The claimed machine' : null);
  const locationText =
    [status?.location?.city, status?.location?.country].filter(Boolean).join(', ') || null;

  if (beginError) {
    return (
      <div {...stylex.props(s.remote)}>
        <p {...stylex.props(s.lede)}>Could not create a pairing offer: {beginError.message}</p>
      </div>
    );
  }

  return (
    <div {...stylex.props(s.remote)}>
      <div {...stylex.props(s.remoteHead)}>
        {/* The SSH sub-tab had no RPC behind it; one command is the only flow. */}
        <span {...stylex.props(s.lede)}>One command</span>
        <span {...stylex.props(s.ttl)} title="The offer expires">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <circle
              cx="8"
              cy="8"
              r="6"
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.2"
              strokeWidth="2"
            />
            <circle
              cx="8"
              cy="8"
              r="6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray={`${((leftSeconds ?? 0) / Math.max(1, ttlTotal)) * 37.7} 37.7`}
              transform="rotate(-90 8 8)"
              strokeLinecap="round"
            />
          </svg>
          {mm}:{ss}
        </span>
      </div>

      <p {...stylex.props(s.lede)}>
        Run this on the machine you want to add. It installs the runtime and claims this offer.
      </p>
      <div {...stylex.props(s.cmd)}>
        <Terminal size={14} {...stylex.props(s.cmdIcon)} />
        <code {...stylex.props(s.cmdCode)}>
          {offer?.command ?? 'Preparing the pairing command…'}
        </code>
        <button
          type="button"
          {...stylex.props(parts.iconBtn, s.cmdAction)}
          aria-label="Copy command"
          disabled={!offer}
          onClick={() => offer && copy(offer.command)}
        >
          <CopyIcon copied={copied} />
        </button>
      </div>

      <div {...stylex.props(s.listen)}>
        <span {...stylex.props(s.radar)} aria-hidden="true">
          <i {...stylex.props(s.radarRing, claimed && s.radarRingHeard)} />
          <i {...stylex.props(s.radarRing, s.radarRingSecond, claimed && s.radarRingHeard)} />
          <StatusDot status="live" />
        </span>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={status?.status ?? 'waiting'}
            {...stylex.props(s.listenText)}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
          >
            {status?.status === 'expired' ? (
              'This offer expired — close and reopen to get a new command.'
            ) : status?.status === 'conflict' ? (
              'Another admission is in progress — finish it first.'
            ) : status?.status === 'cancelled' ? (
              'Offer cancelled.'
            ) : claimed ? (
              <>
                <b {...stylex.props(s.listenStrong)}>{machineLabel ?? 'Machine'}</b>
                {status?.status === 'ready'
                  ? ' is admitted'
                  : status?.status === 'admitted'
                    ? ' admitted · finishing…'
                    : ' claimed this offer · admitting…'}
                {locationText ? ` · ${locationText}` : ''}
              </>
            ) : (
              'Listening for a machine to claim this offer'
            )}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}

/**
 * There is no cloud-VM RPC to call yet, so the drawn panel is honest about
 * it: the fields stay as drawn, but the action is disabled instead of faking
 * a boot sequence.
 */
function CloudPair() {
  return (
    <div {...stylex.props(s.cloud)}>
      <p {...stylex.props(s.lede)}>
        Cloud sandboxes are not available yet — this build cannot create one.
      </p>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div {...stylex.props(s.fact)}>
      <span {...stylex.props(s.factLabel)}>{label}</span>
      <b {...stylex.props(s.factValue)}>{value}</b>
    </div>
  );
}

export type { Phase as PairPhase };
