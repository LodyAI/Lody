/*
 * Harness surface: the body of Settings → Lody Agent.
 *
 * It has three lives, chosen by state rather than by route:
 *   1. no device   → the overview *is* pairing; nothing else is possible yet
 *   2. paired      → the setup wizard, which writes the shared profile
 *   3. configured  → overview and pages, scoped to the profile or one device
 *
 * The settings pane owns the frame, the page title and the close affordance, so
 * this surface draws no chrome of its own: its navigation sits inside the pane,
 * under the pane's header, and the device switcher rides at the top of it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as stylex from '@stylexjs/stylex';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronsUpDown, Plus, Settings2, X } from 'lucide-react';
import { Button } from '@lody/ui';

import { SettingsPageActions } from '@/components/settings/settings-page-header';

import { BRAND, type PairMethod } from './catalog';
import { useHarnessDevices } from './machines';
import { PairPanel, type PairPhase } from './pair';
import { DeviceGlyph, Kbd, StatusDot, soft, spring } from './primitives';
import { parts } from './parts';
import { Settings, type HarnessPage, type HarnessStage } from './settings';
import { Setup } from './setup';
import { SorbetBridge } from './sorbet';
import { useSessionDefaults } from './session-defaults';
import { harness, useHarness } from './store';
import { shell } from './shell.styles';

export type { HarnessPage } from './settings';

export function Harness() {
  const state = useHarness();
  const { devices } = useHarnessDevices();
  const [page, setPage] = useState<HarnessPage>('providers');
  const [pairing, setPairing] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const stage: HarnessStage = !devices.length ? 'empty' : !state.setupDone ? 'setup' : 'settings';

  // Pairing a device opens the wizard once; dismissing it leaves the reminder
  // on the overview instead of reopening on every render.
  useEffect(() => {
    if (stage === 'setup') setSetupOpen(true);
  }, [stage]);

  // "P" pairs a device from anywhere once the first one exists.
  useEffect(() => {
    if (stage === 'empty') return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target.closest('input, textarea, [contenteditable]')
      )
        return;
      if (event.key.toLowerCase() === 'p') setPairing(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stage]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return (
    <SorbetBridge>
      <div {...stylex.props(shell.surface)}>
        {/*
         * Which device the surface is scoped to is a page-level target, so it
         * sits in the settings pane's own header beside the page title — not in
         * the harness's tab row, where it competed with the pages.
         */}
        <SettingsPageActions>
          {devices.length ? (
            // The switcher sits outside the harness surface; its menu draws with
            // the sheet's own tokens because they are module-scoped, not inherited.
            <div>
              <DeviceSwitcher onPair={() => setPairing(true)} onManage={() => setPage('devices')} />
            </div>
          ) : (
            <Button size="small" variant="secondary" onClick={() => setPairing(true)}>
              <Plus size={13} /> Pair a device
            </Button>
          )}
        </SettingsPageActions>

        <div {...stylex.props(shell.body)}>
          {stage === 'setup' && setupOpen ? (
            <SetupPage
              onSkip={() => {
                harness.finish();
                setSetupOpen(false);
              }}
            />
          ) : (
            <Settings
              stage={stage}
              page={page}
              onPage={setPage}
              onPair={() => setPairing(true)}
              renderEmpty={() => <Empty />}
            />
          )}
        </div>

        <PairSheet
          open={pairing}
          onClose={() => setPairing(false)}
          onPaired={(id) => {
            setPairing(false);
            const device = devices.find((d) => d.id === id);
            setToast(`${device?.name ?? 'Device'} paired · inherits your profile`);
          }}
        />

        <AnimatePresence>
          {toast ? (
            <motion.div
              {...stylex.props(shell.toast)}
              role="status"
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={spring}
            >
              <span {...stylex.props(shell.toastIcon)}>
                <Check size={12} strokeWidth={2.6} />
              </span>
              {toast}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </SorbetBridge>
  );
}

function DeviceSwitcher({ onPair, onManage }: { onPair: () => void; onManage: () => void }) {
  const defaults = useSessionDefaults('profile');
  const { devices, activeDevice, select } = useHarnessDevices();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = devices.find((d) => d.id === activeDevice) ?? devices[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) =>
      !ref.current?.contains(event.target as Node) && setOpen(false);
    const esc = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  if (!active) return null;

  return (
    <div {...stylex.props(shell.switcherWrap)} ref={ref}>
      <button
        type="button"
        {...stylex.props(shell.switcher)}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span {...stylex.props(shell.switcherGlyph)}>
          <DeviceGlyph kind={active.kind} size={15} />
          <span {...stylex.props(shell.dotOnGlyph)}>
            <StatusDot status={active.status} />
          </span>
        </span>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={active.id}
            {...stylex.props(shell.switcherName)}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={spring}
          >
            {active.name}
          </motion.span>
        </AnimatePresence>
        <ChevronsUpDown size={12} {...stylex.props(shell.switcherChev)} />
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            {...stylex.props(parts.pop, shell.switcherMenu)}
            role="menu"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
          >
            <div {...stylex.props(parts.popLabel)}>Run agents on</div>
            {devices.map((device) => {
              const overrides = defaults.overridesFor(device.id);
              return (
                <button
                  key={device.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={device.id === active.id}
                  {...stylex.props(parts.popItem, parts.popItemDevice)}
                  onClick={() => {
                    select(device.id as Parameters<typeof select>[0]);
                    setOpen(false);
                  }}
                >
                  <span {...stylex.props(parts.popGlyph)}>
                    <DeviceGlyph kind={device.kind} size={18} />
                    <span {...stylex.props(shell.dotOnGlyph)}>
                      <StatusDot status={device.status} />
                    </span>
                  </span>
                  <span {...stylex.props(parts.popTwo)}>
                    <span {...stylex.props(parts.popTwoName)}>{device.name}</span>
                    <span {...stylex.props(parts.popTwoMeta)}>
                      {device.os ? `${device.os} · ` : ''}
                      {overrides ? `${overrides} override${overrides > 1 ? 's' : ''}` : 'profile'}
                    </span>
                  </span>
                  <span {...stylex.props(parts.popCheck)}>
                    {device.id === active.id ? <Check size={13} strokeWidth={2.4} /> : null}
                  </span>
                </button>
              );
            })}
            <div {...stylex.props(parts.popSep)} />
            <button
              type="button"
              role="menuitem"
              {...stylex.props(parts.popItem)}
              onClick={() => {
                setOpen(false);
                onPair();
              }}
            >
              <span {...stylex.props(parts.popPlus)}>
                <Plus size={13} />
              </span>
              <span {...stylex.props(parts.popGrow)}>Pair a device</span>
              <span {...stylex.props(parts.popMeta)}>
                <Kbd>P</Kbd>
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              {...stylex.props(parts.popItem)}
              onClick={() => {
                setOpen(false);
                onManage();
              }}
            >
              <span {...stylex.props(parts.popPlus)}>
                <Settings2 size={13} />
              </span>
              <span>Manage devices</span>
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Empty() {
  const [method, setMethod] = useState<PairMethod | null>(null);
  const [phase, setPhase] = useState<PairPhase>('idle');
  const onMethod = useCallback((m: PairMethod | null) => setMethod(m), []);
  const onPhase = useCallback((p: PairPhase) => setPhase(p), []);
  void method;
  void phase;

  return (
    <div {...stylex.props(shell.empty)}>
      <div {...stylex.props(shell.emptyGrid)} aria-hidden="true" />
      <div {...stylex.props(shell.emptyInner)}>
        <motion.div
          {...stylex.props(shell.emptyCopy)}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...soft, delay: 0.05 }}
        >
          <h1 {...stylex.props(shell.emptyTitle)}>Where should your agent run?</h1>
          <p {...stylex.props(shell.emptyLede)}>
            Pair a machine and {BRAND} sets up the harness on it — providers, models, plugins and
            permissions. About two minutes. You can add more devices later.
          </p>
        </motion.div>
        <PairPanel onMethod={onMethod} onPhase={onPhase} />
      </div>
    </div>
  );
}

function PairSheet({
  open,
  onClose,
  onPaired,
}: {
  open: boolean;
  onClose: () => void;
  onPaired: (id: string) => void;
}) {
  const [phase, setPhase] = useState<PairPhase>('idle');
  const onPhase = useCallback((p: PairPhase) => setPhase(p), []);

  useEffect(() => {
    if (!open) return;
    const esc = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open, onClose]);

  // The sheet covers the window, so it mounts on `body`: inside the settings
  // dialog it would be clipped by the dialog's own box.
  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          {...stylex.props(shell.sheet)}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onPointerDown={(event) =>
            event.target === event.currentTarget && phase === 'idle' && onClose()
          }
        >
          <motion.div
            {...stylex.props(shell.sheetPanel)}
            role="dialog"
            aria-modal="true"
            aria-label="Pair a device"
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={spring}
          >
            <header {...stylex.props(shell.sheetHead)}>
              <div>
                <h2 {...stylex.props(shell.sheetTitle)}>Pair a device</h2>
                <p {...stylex.props(shell.sheetLede)}>
                  It inherits your profile. Override anything per device in settings.
                </p>
              </div>
              <button
                type="button"
                {...stylex.props(parts.iconBtn)}
                aria-label="Close"
                onClick={onClose}
              >
                <X size={14} />
              </button>
            </header>
            <PairPanel onPhase={onPhase} onPaired={onPaired} />
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body
  );
}

/**
 * The first-run wizard, drawn as the page itself: the setup sheet's own three
 * columns — where you are, the one decision, the path and the file it writes —
 * with its dashed guides, not a card inside a dialog card.
 */
function SetupPage({ onSkip }: { onSkip: () => void }) {
  return (
    <div {...stylex.props(shell.setupPage)}>
      <Setup onSkip={onSkip} />
    </div>
  );
}
