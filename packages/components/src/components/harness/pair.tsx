/*
 * Pairing: how a machine joins the workspace. Used as the whole empty state
 * and, later, inside the "Pair a device" sheet from the device switcher.
 *
 * Each method resolves into the same success moment, so the user learns one
 * pattern: pick where the agent runs → do one thing → see the device arrive.
 */
import { useEffect, useMemo, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, Terminal } from 'lucide-react';

import { BRAND, CLI, PAIR_METHODS, PAIR_RESULT, type DeviceKind, type PairMethod } from './catalog';
import {
  Button,
  DeviceGlyph,
  DrawnCheck,
  Segmented,
  Spinner,
  StatusDot,
  soft,
  spring,
  useCopy,
  CopyIcon,
} from './primitives';
import { parts } from './parts';
import { harness } from './store';
import { pairStyles as s } from './pair.styles';

type Phase = 'idle' | 'working' | 'done';

export function PairPanel({
  onPaired,
  onMethod,
  onPhase,
}: {
  onPaired?: (device: string) => void;
  onMethod?: (method: PairMethod | null) => void;
  onPhase?: (phase: Phase) => void;
}) {
  const [method, setMethod] = useState<PairMethod | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');

  useEffect(() => onMethod?.(method), [method, onMethod]);
  useEffect(() => onPhase?.(phase), [phase, onPhase]);

  const complete = () => {
    if (!method) return;
    setPhase('done');
    window.setTimeout(() => {
      const id = harness.pair(method);
      onPaired?.(id);
    }, 1150);
  };

  return (
    <div {...stylex.props(s.pair)}>
      <div {...stylex.props(s.methods)} role="radiogroup" aria-label="Where should the agent run?">
        {PAIR_METHODS.map((option, index) => {
          const active = method === option.id;
          return (
            <motion.button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={active}
              {...stylex.props(
                s.method,
                active && s.methodActive,
                phase !== 'idle' && !active && s.methodDisabled
              )}
              disabled={phase !== 'idle' && !active}
              onClick={() => phase === 'idle' && setMethod(option.id)}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...soft, delay: 0.12 + index * 0.05 }}
            >
              <span {...stylex.props(s.methodGlyph)}>
                <DeviceGlyph kind={option.kind} size={26} />
              </span>
              <span {...stylex.props(s.methodTitle)}>
                {option.title}
                {option.tag ? (
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
                  kind={PAIR_RESULT[method].kind}
                  name={PAIR_RESULT[method].name}
                  host={PAIR_RESULT[method].host}
                />
              ) : method === 'local' ? (
                <LocalPair phase={phase} onStart={() => setPhase('working')} onDone={complete} />
              ) : method === 'remote' ? (
                <RemotePair onStart={() => setPhase('working')} onDone={complete} />
              ) : (
                <CloudPair phase={phase} onStart={() => setPhase('working')} onDone={complete} />
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Paired({ kind, name, host }: { kind: DeviceKind; name: string; host: string }) {
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
        <small {...stylex.props(s.pairedMeta)}>
          {host} · end-to-end encrypted · setting up the harness…
        </small>
      </span>
    </motion.div>
  );
}

function LocalPair({
  phase,
  onStart,
  onDone,
}: {
  phase: Phase;
  onStart: () => void;
  onDone: () => void;
}) {
  useEffect(() => {
    if (phase !== 'working') return;
    const timer = window.setTimeout(onDone, 1300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const device = PAIR_RESULT.local;
  return (
    <div {...stylex.props(s.split)}>
      <div {...stylex.props(s.facts)}>
        <Fact label="Device" value={device.name} />
        <Fact label="System" value={`${device.os} · ${device.arch}`} />
        <Fact label="Runtime" value={`${BRAND} Desktop ${device.version}`} />
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

/** A six-character code that expires; the CLI exchanges it for a device key. */
function usePairCode() {
  return useMemo(() => {
    const alphabet = 'ACDEFGHJKMNPQRTUVWXY34679';
    const pick = () => alphabet[Math.floor(Math.random() * alphabet.length)];
    return `${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}`;
  }, []);
}

const CODE_TTL = 600;

function RemotePair({ onStart, onDone }: { onStart: () => void; onDone: () => void }) {
  const code = usePairCode();
  const [via, setVia] = useState<'cli' | 'ssh'>('cli');
  const [left, setLeft] = useState(CODE_TTL);
  const [heard, setHeard] = useState(false);
  const [host, setHost] = useState('');
  const { copied, copy } = useCopy();
  const command = `curl -fsSL https://get.${CLI}.dev | sh && ${CLI} pair ${code}`;

  useEffect(() => {
    const timer = window.setInterval(() => setLeft((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Demo stand-in for the server push: a device "checks in" after the copy.
  useEffect(() => {
    if (!heard) return;
    onStart();
    const timer = window.setTimeout(onDone, 2600);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heard]);

  const mm = String(Math.floor(left / 60)).padStart(1, '0');
  const ss = String(left % 60).padStart(2, '0');

  return (
    <div {...stylex.props(s.remote)}>
      <div {...stylex.props(s.remoteHead)}>
        <Segmented
          size="sm"
          label="Pairing method"
          value={via}
          onChange={setVia}
          options={[
            { id: 'cli', label: 'One command' },
            { id: 'ssh', label: 'Over SSH' },
          ]}
        />
        <span {...stylex.props(s.ttl)} title="The code expires">
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
              strokeDasharray={`${(left / CODE_TTL) * 37.7} 37.7`}
              transform="rotate(-90 8 8)"
              strokeLinecap="round"
            />
          </svg>
          {mm}:{ss}
        </span>
      </div>

      {via === 'cli' ? (
        <>
          <p {...stylex.props(s.lede)}>
            Run this on the machine you want to add. It installs the runtime and claims this code.
          </p>
          <div {...stylex.props(s.cmd)}>
            <Terminal size={14} {...stylex.props(s.cmdIcon)} />
            <code {...stylex.props(s.cmdCode)}>
              <span {...stylex.props(s.cmdDim)}>
                curl -fsSL https://get.{CLI}.dev | sh &amp;&amp;{' '}
              </span>
              {CLI} pair <span {...stylex.props(s.cmdToken)}>{code}</span>
            </code>
            <button
              type="button"
              {...stylex.props(parts.iconBtn, s.cmdAction)}
              aria-label="Copy command"
              onClick={() => {
                copy(command);
                setHeard(true);
              }}
            >
              <CopyIcon copied={copied} />
            </button>
          </div>
        </>
      ) : (
        <form
          {...stylex.props(s.ssh)}
          onSubmit={(event) => {
            event.preventDefault();
            if (host.trim()) setHeard(true);
          }}
        >
          <p {...stylex.props(s.lede)}>
            We'll SSH in once with your agent's key, install the runtime, then disconnect.
          </p>
          <div {...stylex.props(s.sshRow)}>
            <input
              {...stylex.props(parts.input, parts.inputMono)}
              placeholder="user@10.0.4.21"
              value={host}
              onChange={(event) => setHost(event.target.value)}
              aria-label="SSH destination"
              spellCheck={false}
              autoFocus
            />
            <Button type="submit" variant="primary" disabled={!host.trim() || heard}>
              Connect
            </Button>
          </div>
        </form>
      )}

      <div {...stylex.props(s.listen)}>
        <span {...stylex.props(s.radar)} aria-hidden="true">
          <i {...stylex.props(s.radarRing, heard && s.radarRingHeard)} />
          <i {...stylex.props(s.radarRing, s.radarRingSecond, heard && s.radarRingHeard)} />
          <StatusDot status="live" />
        </span>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={heard ? 'heard' : 'wait'}
            {...stylex.props(s.listenText)}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
          >
            {heard ? (
              <>
                <b {...stylex.props(s.listenStrong)}>build-box</b> answered · verifying fingerprint…
              </>
            ) : (
              <>Listening for a device to claim {code}</>
            )}
          </motion.span>
        </AnimatePresence>
        {heard ? null : (
          <button type="button" {...stylex.props(parts.link)} onClick={() => setHeard(true)}>
            Simulate
          </button>
        )}
      </div>
    </div>
  );
}

const CLOUD_STEPS = [
  'Allocating VM',
  'Booting image',
  'Installing runtime',
  'Opening secure tunnel',
];

function CloudPair({
  phase,
  onStart,
  onDone,
}: {
  phase: Phase;
  onStart: () => void;
  onDone: () => void;
}) {
  const [region, setRegion] = useState<'iad' | 'sfo' | 'fra'>('iad');
  const [size, setSize] = useState<'s' | 'm' | 'l'>('m');
  const [at, setAt] = useState(-1);

  useEffect(() => {
    if (phase !== 'working') return;
    if (at >= CLOUD_STEPS.length) {
      onDone();
      return;
    }
    const timer = window.setTimeout(() => setAt((index) => index + 1), at < 0 ? 200 : 650);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, at]);

  if (phase === 'working') {
    return (
      <ol {...stylex.props(s.boot)}>
        {CLOUD_STEPS.map((step, index) => {
          const state = index < at ? 'done' : index === at ? 'active' : 'todo';
          return (
            <li
              key={step}
              {...stylex.props(
                s.bootItem,
                state === 'done' && s.bootItemDone,
                state === 'active' && s.bootItemActive
              )}
            >
              <span
                {...stylex.props(
                  s.stepIcon,
                  state === 'done' && s.stepIconDone,
                  state === 'active' && s.stepIconActive
                )}
              >
                {state === 'done' ? (
                  <DrawnCheck size={11} />
                ) : state === 'active' ? (
                  <Spinner size={12} />
                ) : null}
              </span>
              {step}
            </li>
          );
        })}
      </ol>
    );
  }

  return (
    <div {...stylex.props(s.cloud)}>
      <div {...stylex.props(s.cloudFields)}>
        <label {...stylex.props(s.cloudField)}>
          <span {...stylex.props(s.cloudFieldLabel)}>Region</span>
          <Segmented
            size="sm"
            label="Region"
            value={region}
            onChange={setRegion}
            options={[
              { id: 'iad', label: 'US East' },
              { id: 'sfo', label: 'US West' },
              { id: 'fra', label: 'Europe' },
            ]}
          />
        </label>
        <label {...stylex.props(s.cloudField)}>
          <span {...stylex.props(s.cloudFieldLabel)}>Size</span>
          <Segmented
            size="sm"
            label="Size"
            value={size}
            onChange={setSize}
            options={[
              { id: 's', label: '2 vCPU' },
              { id: 'm', label: '4 vCPU' },
              { id: 'l', label: '8 vCPU' },
            ]}
          />
        </label>
      </div>
      <Button variant="primary" size="lg" onClick={onStart}>
        Create sandbox <ArrowRight size={14} />
      </Button>
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
