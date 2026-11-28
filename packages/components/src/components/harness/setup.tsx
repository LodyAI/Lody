/*
 * First-run setup, after a device is paired. The pane is narrower than the
 * design's three-column page, so the rails fold into one row above the card:
 * where you are, how far the path has gone, and the one decision in front of
 * you.
 *
 * Setup always writes the shared profile; per-device tweaks live in settings.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, Minus, X } from 'lucide-react';

import { useWorkspaceMcpCatalog } from '@/hooks/use-workspace-mcp-catalog';

import { AUTONOMY, PROVIDERS } from './catalog';
import { useDeviceCapabilities } from './device-capabilities';
import { ModelsPanel, PermissionsPanel, PluginsPanel, ProvidersPanel } from './panels';
import { Button, DrawnCheck, Kbd, Spinner, soft } from './primitives';
import { parts } from './parts';
import { panelStyles as panel } from './panels.styles';
import { useActiveDevice } from './machines';
import { useSessionDefaults } from './session-defaults';
import { useSorbetTarget } from './sorbet';
import { harness, storeMirrored, useHarness } from './store';
import { setupStyles as s } from './setup.styles';

const STEPS = [
  {
    id: 'providers',
    nav: 'Sign in to a provider',
    title: 'Connect a model provider',
    lede: 'Sign in with a subscription or paste an API key. Add more than one to unlock fallback.',
  },
  {
    id: 'models',
    nav: 'Choose models',
    title: 'Pick a model for each role',
    lede: 'We chose sensible defaults from what you connected. Change them any time.',
  },
  {
    id: 'plugins',
    nav: 'Inject plugins',
    title: 'Choose what the agent carries',
    lede: 'Everything here is injected into each session. Watch the context cost — less is often faster.',
  },
  {
    id: 'permissions',
    nav: 'Set permissions',
    title: 'Decide what it can do alone',
    lede: 'You can loosen this per device later, e.g. full auto on a cloud sandbox.',
  },
  {
    id: 'review',
    nav: 'Review and check',
    title: 'Check the harness',
    lede: 'A dry run against the paired device before the first real session.',
  },
] as const;

export function Setup({ onSkip }: { onSkip?: () => void } = {}) {
  const state = useHarness();
  const step = Math.min(state.setupStep, STEPS.length - 1);
  const [dir, setDir] = useState(1);
  const [checked, setChecked] = useState(false);
  const { device } = useActiveDevice();
  const current = STEPS[step];
  const [measure, bodyHeight] = useHeight();
  const foot = useFootShape();

  const connected = Object.keys(state.credentials).length > 0;
  const answered = state.status === 'ready' || storeMirrored(state);
  const canContinue =
    current.id === 'providers' ? connected || !answered : current.id === 'review' ? checked : true;

  const go = (next: number) => {
    setDir(next > step ? 1 : -1);
    harness.step(Math.max(0, Math.min(STEPS.length - 1, next)));
  };

  const advance = () => {
    if (!canContinue) return;
    if (current.id === 'review') harness.finish();
    else go(step + 1);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        advance();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (current.id !== 'review') setChecked(false);
  }, [current.id]);

  return (
    <div {...stylex.props(s.setup)}>
      {/*
       * One row: where you are, how far the whole path has gone, and the
       * decision in front of you. The labels live in the segments' titles —
       * five names beside a counter is a list, not a progress line.
       */}
      <div {...stylex.props(s.meta)}>
        <div {...stylex.props(s.count)}>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={step}
              initial={{ y: 10 * dir, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -10 * dir, opacity: 0 }}
              transition={soft}
            >
              {step + 1}
            </motion.span>
          </AnimatePresence>
          <i {...stylex.props(s.countTotal)}>/ {STEPS.length}</i>
        </div>

        <ol {...stylex.props(s.segments)} aria-label="Setup progress">
          <li title="Pair a device" {...stylex.props(s.segment, s.segmentReached)} />
          {STEPS.map((item, index) => (
            <li
              key={item.id}
              title={item.nav}
              {...stylex.props(s.segment, index <= step && s.segmentReached)}
            />
          ))}
        </ol>

        <span {...stylex.props(s.stepname)}>{current.nav}</span>

        {onSkip ? (
          <span style={{ marginInlineStart: 'auto' }}>
            <Button size="sm" variant="ghost" onClick={onSkip}>
              Skip for now
            </Button>
          </span>
        ) : null}
      </div>

      <main {...stylex.props(s.center)}>
        <div ref={foot.card} {...stylex.props(s.card)}>
          <span {...stylex.props(s.corner, s.cornerTopStart)} aria-hidden="true" />
          <span {...stylex.props(s.corner, s.cornerTopEnd)} aria-hidden="true" />
          <span {...stylex.props(s.corner, s.cornerBottomStart)} aria-hidden="true" />
          <span {...stylex.props(s.corner, s.cornerBottomEnd)} aria-hidden="true" />
          <motion.div
            {...stylex.props(s.body)}
            animate={{ height: bodyHeight || 'auto' }}
            transition={soft}
          >
            <div ref={measure} {...stylex.props(s.bodyInner)}>
              <AnimatePresence mode="popLayout" initial={false} custom={dir}>
                <motion.div
                  key={current.id}
                  custom={dir}
                  initial={{ opacity: 0, x: 24 * dir, filter: 'blur(4px)' }}
                  animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, x: -24 * dir, filter: 'blur(4px)' }}
                  transition={soft}
                >
                  <header {...stylex.props(s.head)}>
                    <h2 {...stylex.props(s.title)}>{current.title}</h2>
                    <p {...stylex.props(s.lede)}>{current.lede}</p>
                  </header>
                  {current.id === 'providers' ? <ProvidersPanel /> : null}
                  {current.id === 'models' ? <ModelsPanel scope="profile" /> : null}
                  {current.id === 'plugins' ? <PluginsPanel /> : null}
                  {current.id === 'permissions' ? <PermissionsPanel scope="profile" /> : null}
                  {current.id === 'review' ? (
                    <Review
                      onEdit={go}
                      onChecked={() => setChecked(true)}
                      deviceName={device?.name}
                    />
                  ) : null}
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>
          <footer {...stylex.props(s.foot)}>
            <svg {...stylex.props(s.footClipDefs)} aria-hidden="true">
              <defs>
                <clipPath id={foot.clipId} clipPathUnits="userSpaceOnUse">
                  {foot.path ? <path d={foot.path} /> : null}
                </clipPath>
              </defs>
            </svg>
            <span aria-hidden="true" {...stylex.props(s.footFill, foot.docked && s.footFillAway)} />
            <span
              ref={foot.fill}
              aria-hidden="true"
              {...stylex.props(s.footFill, !foot.docked && s.footFillAway)}
              style={foot.path ? { clipPath: `url(#${foot.clipId})` } : undefined}
            />
            {step > 0 ? (
              <Button variant="ghost" onClick={() => go(step - 1)}>
                <ArrowLeft size={14} /> Back
              </Button>
            ) : (
              <span {...stylex.props(s.footHint)}>
                {connected
                  ? `${Object.keys(state.credentials).length} connected`
                  : storeMirrored(state)
                    ? 'Read-only view · connect on that machine'
                    : answered
                      ? 'Connect one to continue'
                      : 'This app cannot read this machine’s connections'}
              </span>
            )}
            <Button variant="primary" onClick={advance} disabled={!canContinue}>
              {current.id === 'review' ? 'Start building' : 'Continue'}
              {current.id === 'review' ? <ArrowRight size={14} /> : <Kbd>⌘↵</Kbd>}
            </Button>
          </footer>
        </div>
      </main>
    </div>
  );
}

/** Track an element's height so the card can animate between steps. */
function useHeight() {
  const [height, setHeight] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (!node) return;
    observer.current = new ResizeObserver(([entry]) => setHeight(entry.borderBoxSize[0].blockSize));
    observer.current.observe(node);
  }, []);
  return [ref, height] as const;
}

/**
 * The footer's two outlines: `docked` once the bar rests on the card's bottom
 * edge, and the path that clips it to the card's own bottom corners.
 *
 * The card is the bar's containing block, so "resting" is exactly "the bar's
 * bottom edge is the card's": while a step is taller than the pane, its farthest
 * stuck position leaves the card's bottom below the scrollport. The corner radius
 * is read from the card rather than repeated, so the bar's outline cannot drift
 * from the card's, and the box is re-measured because a step change animates the
 * card's height while the pane scrolls the bar against it.
 */
function useFootShape() {
  const card = useRef<HTMLDivElement | null>(null);
  const fill = useRef<HTMLSpanElement | null>(null);
  const [docked, setDocked] = useState(false);
  const [box, setBox] = useState<{ w: number; h: number; r: number } | null>(null);
  const clipId = `setup-foot-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  useLayoutEffect(() => {
    const dock = () => {
      const cardEl = card.current;
      const fillEl = fill.current;
      if (!cardEl || !fillEl) return;
      const gap = cardEl.getBoundingClientRect().bottom - fillEl.getBoundingClientRect().bottom;
      setDocked(gap <= 0.5);
    };
    const shape = () => {
      const cardEl = card.current;
      const fillEl = fill.current;
      if (!cardEl || !fillEl) return;
      const rect = fillEl.getBoundingClientRect();
      const r = Number.parseFloat(getComputedStyle(cardEl).borderBottomLeftRadius);
      setBox(Number.isFinite(r) ? { w: rect.width, h: rect.height, r } : null);
    };
    dock();
    shape();
    const observer = new ResizeObserver(() => {
      shape();
      dock();
    });
    if (card.current) observer.observe(card.current);
    if (fill.current) observer.observe(fill.current);
    window.addEventListener('scroll', dock, { capture: true, passive: true });
    window.addEventListener('resize', dock);
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', dock, true);
      window.removeEventListener('resize', dock);
    };
  }, []);

  return { card, fill, docked, clipId, path: box ? footClipPath(box) : null };
}

/**
 * The bar's outline: square at the top and sides, the card's corner arc at the
 * bottom. Coordinates are the bar's own box, which is what the `<clipPath>`
 * reads them in; `2` places of a pixel keep the path stable across scrolls.
 */
function footClipPath({ w, h, r }: { w: number; h: number; r: number }) {
  const round = (value: number) => Math.round(value * 100) / 100;
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  if (!radius) return `M0 0H${round(w)}V${round(h)}H0Z`;
  return [
    'M0 0',
    `H${round(w)}`,
    `V${round(h - radius)}`,
    `A${round(radius)} ${round(radius)} 0 0 1 ${round(w - radius)} ${round(h)}`,
    `H${round(radius)}`,
    `A${round(radius)} ${round(radius)} 0 0 1 0 ${round(h - radius)}`,
    'Z',
  ].join('');
}

/**
 * What the review step can confirm from data the page has. A check the harness
 * could not read is `unknown`, never a failure: the machine may be set up
 * behind a store this app cannot reach.
 */
type SetupCheck = { label: string; ok: boolean; unknown?: boolean };

function useSetupChecks(): SetupCheck[] {
  const state = useHarness();
  const { device } = useActiveDevice();
  const target = useSorbetTarget();
  const capabilities = useDeviceCapabilities();
  const { synced } = useWorkspaceMcpCatalog();
  const answered = state.status === 'ready' || storeMirrored(state);
  return [
    { label: 'Device online', ok: device?.status === 'online' },
    { label: 'Lody Agent set up on this device', ok: !!target },
    answered
      ? { label: 'A provider is connected', ok: Object.keys(state.credentials).length > 0 }
      : {
          label: 'Provider connections readable from this app',
          ok: false,
          unknown: true,
        },
    answered
      ? { label: 'Models available', ok: capabilities.models.length > 0 }
      : { label: 'Models readable from this app', ok: false, unknown: true },
    { label: 'Workspace MCP servers read', ok: synced },
  ];
}

function Review({
  onEdit,
  onChecked,
  deviceName,
}: {
  onEdit: (step: number) => void;
  onChecked: () => void;
  deviceName?: string;
}) {
  const state = useHarness();
  const capabilities = useDeviceCapabilities();
  const defaults = useSessionDefaults('profile');
  const { servers } = useWorkspaceMcpCatalog();
  const checks = useSetupChecks();
  const [at, setAt] = useState(0);

  useEffect(() => {
    if (at > checks.length) return;
    if (at === checks.length) {
      onChecked();
      return;
    }
    const timer = window.setTimeout(() => setAt((index) => index + 1), at === 0 ? 300 : 160);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at]);

  const providers = [
    ...PROVIDERS.filter((p) => state.credentials[p.id]).map((p) => p.name),
    ...state.customs.filter((c) => state.credentials[c.id]).map((c) => c.name),
  ];
  const providersValue = providers.length
    ? providers.join(', ')
    : state.status === 'ready' || storeMirrored(state)
      ? 'None connected'
      : 'Not readable from this app';
  const modelName = (id: string | undefined) =>
    capabilities.models.find((m) => m.id === id)?.name ?? id ?? 'Agent default';
  const effort = capabilities.effortOption?.options.find(
    (option) => option.value === defaults.values.effort
  )?.name;
  const attached = servers.filter((server) => server.enabledByDefault === true).length;
  const failed = checks.filter((check) => !check.ok && !check.unknown).length;
  const unknown = checks.filter((check) => check.unknown === true).length;
  const done = at >= checks.length;

  const rows = [
    { step: 0, label: 'Providers', value: providersValue },
    {
      step: 1,
      label: 'Models',
      value: `${modelName(defaults.values.mainModel)}${effort ? ` · ${effort} effort` : ''}`,
    },
    {
      step: 2,
      label: 'Plugins',
      value: servers.length
        ? `${attached} of ${servers.length} MCP server${servers.length > 1 ? 's' : ''} attached by default`
        : 'No MCP servers in this workspace',
    },
    {
      step: 3,
      label: 'Permissions',
      value: AUTONOMY.find((a) => a.id === defaults.values.autonomy)?.title ?? 'Agent default',
    },
  ];

  return (
    <div {...stylex.props(parts.panel)}>
      <dl {...stylex.props(panel.summary)}>
        {rows.map((row, index) => (
          <div
            key={row.label}
            {...stylex.props(panel.summaryRow, index > 0 && panel.summaryRowRuled)}
          >
            <dt {...stylex.props(panel.summaryTerm)}>{row.label}</dt>
            <dd {...stylex.props(panel.summaryValue)}>{row.value}</dd>
            <button type="button" {...stylex.props(parts.link)} onClick={() => onEdit(row.step)}>
              Edit
            </button>
          </div>
        ))}
      </dl>

      <div {...stylex.props(panel.checks, done && !failed && !unknown && panel.checksDone)}>
        <div {...stylex.props(panel.checksHead)}>
          {!done ? (
            <>
              <Spinner size={13} /> Checking {deviceName ?? 'your device'}
            </>
          ) : failed ? (
            <>
              {failed} to fix on {deviceName ?? 'your device'}
            </>
          ) : unknown ? (
            <>Checked what this app can see on {deviceName ?? 'your device'}</>
          ) : (
            <>
              <span {...stylex.props(panel.checksOk)}>
                <DrawnCheck size={11} />
              </span>
              Ready on {deviceName ?? 'your device'}
            </>
          )}
          <span {...stylex.props(panel.checksCount)}>
            {checks.slice(0, at).filter((check) => check.ok).length}/{checks.length}
          </span>
        </div>
        <ul {...stylex.props(panel.checksList)}>
          {checks.map((check, index) => {
            const shown = index < at;
            const ok = shown && check.ok;
            const unknown = shown && !check.ok && check.unknown === true;
            return (
              <li key={check.label} {...stylex.props(panel.checkRow, ok && panel.checkRowDone)}>
                <span {...stylex.props(panel.checkIcon, ok && panel.checkIconDone)}>
                  {ok ? (
                    <DrawnCheck size={10} />
                  ) : unknown ? (
                    <Minus size={10} />
                  ) : shown ? (
                    <X size={10} />
                  ) : index === at ? (
                    <Spinner size={11} />
                  ) : null}
                </span>
                {check.label}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
