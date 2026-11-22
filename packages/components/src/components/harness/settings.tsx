/*
 * The harness after setup: an overview plus one page per area. Editing scope
 * is explicit — the shared profile, or the device selected in the navigation —
 * so multi-device inheritance is something you can see, not guess.
 *
 * The settings pane owns the page title and the close affordance; this surface
 * lives in the pane's body and keeps its own navigation, so the device the
 * surface is scoped to and the page being edited are always visible.
 */
import { useAtomValue } from 'jotai';
import { useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Blocks,
  Boxes,
  KeyRound,
  MonitorSmartphone,
  Plus,
  ShieldCheck,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import type { MachineId, MachineViewMeta } from '@lody/shared';

import { localMachineIdAtom } from '@/atoms/local-probe';
import { presumedOnlineMachineIdsAtom } from '@/atoms/presence';
import { useMachineActions } from '@/hooks/use-machine-actions';
import { canDeleteOfflineMachine } from '@/lib/machine-deletion';

import { ModelsPanel, PermissionsPanel, PluginsPanel, ProvidersPanel, Section } from './panels';
import {
  useActiveDevice,
  useDeviceManagement,
  useDeviceStatus,
  useHarnessDevices,
} from './machines';
import type { Device } from './catalog';
import {
  Button,
  DeviceGlyph,
  Segmented,
  SelectionIndicator,
  StatusDot,
  soft,
  useSlidingSelection,
} from './primitives';
import { parts } from './parts';
import { useSessionDefaults } from './session-defaults';
import { harness, useHarness, type Scope } from './store';
import { settingsStyles } from './settings.styles';

export type HarnessPage = 'devices' | 'providers' | 'models' | 'plugins' | 'permissions';

export interface NavItem {
  id: HarnessPage;
  label: string;
  icon: LucideIcon;
}

const NAV: NavItem[] = [
  { id: 'providers', label: 'Providers', icon: KeyRound },
  { id: 'models', label: 'Models', icon: Boxes },
  { id: 'plugins', label: 'Plugins', icon: Blocks },
  { id: 'permissions', label: 'Permissions', icon: ShieldCheck },
  { id: 'devices', label: 'Devices', icon: MonitorSmartphone },
];

/** Pages whose values differ per device; MCP defaults on Plugins are workspace-wide. */
const SCOPED = new Set(['models', 'permissions']);

/**
 * The pairing/empty and setup states a harness page can be in. `settings` is
 * the ordinary state: a paired device whose setup is done.
 */
export type HarnessStage = 'empty' | 'setup' | 'settings';

export function Settings({
  stage,
  page,
  onPage,
  onPair,
  renderEmpty,
}: {
  stage: HarnessStage;
  page: HarnessPage;
  onPage: (page: HarnessPage) => void;
  onPair: () => void;
  /** The pairing surface, drawn where the overview would be. */
  renderEmpty?: () => ReactNode;
}) {
  const { device, devices } = useActiveDevice();
  const [scopeKind, setScopeKind] = useState<'profile' | 'device'>('profile');
  const scope: Scope = scopeKind === 'device' && device ? { device: device.id } : 'profile';
  const defaults = useSessionDefaults(scope);
  const overrides = device ? defaults.overridesFor(device.id) : 0;
  const tabs = useSlidingSelection(page);

  return (
    <div {...stylex.props(settingsStyles.page)}>
      <nav {...stylex.props(settingsStyles.nav)} aria-label="Lody Agent">
        <div {...stylex.props(settingsStyles.tabs)} ref={tabs.containerRef}>
          <SelectionIndicator box={tabs.box} radius={8} />
          <NavRows
            items={NAV}
            page={page}
            onPage={onPage}
            deviceCount={devices.length}
            register={tabs.register}
          />
        </div>
      </nav>

      <div {...stylex.props(settingsStyles.main)}>
        <AnimatePresence initial={false}>
          {SCOPED.has(page) && device && stage === 'settings' ? (
            <motion.div
              {...stylex.props(settingsStyles.scope)}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={soft}
            >
              <div {...stylex.props(settingsStyles.scopeInner)}>
                <span {...stylex.props(settingsStyles.scopeLabel)}>Editing</span>
                <Segmented
                  size="sm"
                  label="Editing scope"
                  value={scopeKind}
                  onChange={setScopeKind}
                  options={[
                    { id: 'profile', label: 'Profile · all devices' },
                    {
                      id: 'device',
                      label: (
                        <>
                          <DeviceGlyph kind={device.kind} size={13} /> {device.name}
                        </>
                      ),
                    },
                  ]}
                />
                <span {...stylex.props(settingsStyles.scopeHint)}>
                  {scopeKind === 'profile'
                    ? `Applies to all ${devices.length} device${devices.length > 1 ? 's' : ''}${overrides ? ` · ${overrides} override${overrides > 1 ? 's' : ''} on ${device.name}` : ''}`
                    : overrides
                      ? `${overrides} override${overrides > 1 ? 's' : ''} on ${device.name} · the rest comes from the profile`
                      : `Nothing overridden yet · only ${device.name}`}
                </span>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={page}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
          >
            {page === 'providers' && stage === 'empty' && renderEmpty ? (
              renderEmpty()
            ) : page === 'devices' ? (
              <Devices onPair={onPair} />
            ) : page === 'providers' ? (
              <Section title="Providers" hint="Which agents and endpoints sign requests.">
                <ProvidersStatus />
                <ProvidersPanel />
              </Section>
            ) : page === 'models' ? (
              <Section
                title="Models"
                hint="Which model plays which role, and what happens when one is unavailable."
              >
                <ModelsPanel scope={scope} />
              </Section>
            ) : page === 'plugins' ? (
              <Section title="Plugins" hint="MCP servers and plugins new conversations start with.">
                <PluginsPanel />
              </Section>
            ) : page === 'permissions' ? (
              <Section
                title="Permissions"
                hint="How much the agent does on its own, and where it can reach."
              >
                <PermissionsPanel scope={scope} />
              </Section>
            ) : null}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function NavRows({
  items,
  page,
  onPage,
  deviceCount,
  register,
}: {
  items: NavItem[];
  page: HarnessPage;
  onPage: (page: HarnessPage) => void;
  deviceCount?: number;
  register: (id: string) => (element: HTMLElement | null) => void;
}) {
  return (
    <>
      {items.map((item) => {
        const Icon = item.icon;
        const active = page === item.id;
        return (
          <button
            key={item.id}
            ref={register(item.id)}
            type="button"
            {...stylex.props(settingsStyles.navItem, active && settingsStyles.navItemActive)}
            aria-current={active ? 'page' : undefined}
            onClick={() => onPage(item.id)}
          >
            <Icon size={15} {...stylex.props(settingsStyles.navItemLayer)} />
            <span {...stylex.props(settingsStyles.navItemLayer)}>{item.label}</span>
            {item.id === 'devices' && deviceCount ? (
              <span {...stylex.props(settingsStyles.navItemLayer, settingsStyles.navCount)}>
                {deviceCount}
              </span>
            ) : null}
          </button>
        );
      })}
    </>
  );
}

/**
 * What the machine read is doing right now, one line above the provider rows.
 * A ready read needs no line — the rows are the answer.
 */
function ProvidersStatus() {
  const state = useHarness();
  const text =
    state.status === 'loading'
      ? 'Reading connections from this machine…'
      : state.status === 'error'
        ? 'Could not read this machine’s connections.'
        : state.status === 'unsupported'
          ? 'This machine’s daemon is older; update it to manage connections.'
          : state.status === 'no-agent'
            ? 'Lody Agent is not set up on this machine yet.'
            : state.status === 'no-runtime'
              ? 'The workspace runtime is unavailable.'
              : null;
  if (!text) return null;
  return <p {...stylex.props(parts.provMeta)}>{text}</p>;
}

/* ── devices ───────────────────────────────────────────────────────────── */

function Devices({ onPair }: { onPair: () => void }) {
  const defaults = useSessionDefaults('profile');
  const { devices, machines, activeDevice, select, isLoading } = useHarnessDevices();

  return (
    <Section
      title="Devices"
      hint="Every machine that can run your agent. Each inherits the profile unless it overrides a value."
      aside={
        <Button variant="primary" size="sm" onClick={onPair}>
          <Plus size={13} /> Pair a device
        </Button>
      }
    >
      <div {...stylex.props(settingsStyles.devices)}>
        <AnimatePresence initial={false}>
          {!isLoading && !devices.length ? (
            <motion.p
              {...stylex.props(settingsStyles.deviceAddHint)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            >
              No machines are paired to this workspace yet.
            </motion.p>
          ) : null}
          {devices.map((device) => (
            <DeviceCard
              key={device.id}
              device={device}
              machine={machines.get(device.id as MachineId)}
              active={device.id === activeDevice}
              overrides={defaults.overridesFor(device.id)}
              onSelect={() => select(device.id as MachineId)}
            />
          ))}
        </AnimatePresence>
        <motion.button
          layout
          type="button"
          {...stylex.props(settingsStyles.device, settingsStyles.deviceAdd)}
          onClick={onPair}
          transition={soft}
        >
          <span {...stylex.props(settingsStyles.devicePlus)}>
            <Plus size={16} />
          </span>
          <b {...stylex.props(settingsStyles.deviceAddName)}>Pair a device</b>
          <small {...stylex.props(settingsStyles.deviceAddHint)}>
            Laptop, server or cloud sandbox
          </small>
        </motion.button>
      </div>
    </Section>
  );
}

/** A word the machine's meta line can show; 'unknown' never claims offline. */
const ONLINE_WORD = {
  online: 'Online',
  offline: 'Offline',
  unknown: 'Status unknown',
} as const;

function DeviceCard({
  device,
  machine,
  active,
  overrides,
  onSelect,
}: {
  device: Device;
  machine: MachineViewMeta | undefined;
  active: boolean;
  overrides: number;
  onSelect: () => void;
}) {
  const online = useDeviceStatus(device.id as MachineId);
  const { accountId, canManageOthers } = useDeviceManagement();
  const localMachineId = useAtomValue(localMachineIdAtom);
  const presumedOnline = useAtomValue(presumedOnlineMachineIdsAtom);
  const [confirm, setConfirm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actions = useMachineActions({
    currentUserId: accountId,
    localMachineId,
    canManageAllMachines: canManageOthers,
  });

  // Rename is a machine-doc write; unpair is the same offline-machine delete
  // the machine settings page gates — an online machine can never be removed.
  const canUnpair =
    !!machine &&
    canDeleteOfflineMachine({
      machine,
      isOnline: presumedOnline.has(device.id as MachineId),
      currentUserId: accountId,
      localMachineId,
      canManageAllMachines: canManageOthers,
    });

  const rename = async (name: string) => {
    setEditing(false);
    const trimmed = name.trim();
    if (!trimmed || trimmed === device.name) return;
    setPending(true);
    try {
      await actions.renameMachine(device.id as MachineId, trimmed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  const unpair = async () => {
    setPending(true);
    try {
      await actions.deleteMachine(machine!);
      // The row disappears with the doc; drop its overrides and selection.
      harness.forgetDevice(device.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setConfirm(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <motion.div
      layout
      {...stylex.props(settingsStyles.device, active && settingsStyles.deviceActive)}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={soft}
    >
      <div {...stylex.props(settingsStyles.deviceTop)}>
        <span {...stylex.props(settingsStyles.deviceGlyph)}>
          <DeviceGlyph kind={device.kind} size={28} />
        </span>
        {active ? (
          <span {...stylex.props(parts.tag, parts.tagOk)}>Selected</span>
        ) : (
          <Button size="sm" variant="ghost" onClick={onSelect}>
            Select
          </Button>
        )}
      </div>
      {editing ? (
        <input
          {...stylex.props(settingsStyles.deviceName)}
          defaultValue={device.name}
          aria-label="Device name"
          autoFocus
          disabled={pending}
          onBlur={(event) => void rename(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') {
              event.currentTarget.value = device.name;
              event.currentTarget.blur();
            }
          }}
        />
      ) : (
        <button
          type="button"
          {...stylex.props(settingsStyles.deviceName, settingsStyles.deviceNameButton)}
          title="Rename"
          onClick={() => setEditing(true)}
        >
          {device.name}
        </button>
      )}
      <div {...stylex.props(settingsStyles.deviceMeta)}>
        <span {...stylex.props(settingsStyles.deviceMetaDot)}>
          <StatusDot
            status={online === 'online' ? 'online' : online === 'offline' ? 'offline' : 'idle'}
          />
        </span>{' '}
        {ONLINE_WORD[online]} · {device.host}
      </div>
      <dl {...stylex.props(settingsStyles.deviceFacts)}>
        <div {...stylex.props(settingsStyles.deviceFact)}>
          <dt {...stylex.props(settingsStyles.deviceFactLabel)}>System</dt>
          <dd {...stylex.props(settingsStyles.deviceFactValue)}>{device.os || '—'}</dd>
        </div>
        <div {...stylex.props(settingsStyles.deviceFact)}>
          <dt {...stylex.props(settingsStyles.deviceFactLabel)}>Runtime</dt>
          <dd {...stylex.props(settingsStyles.deviceFactValue)}>
            {device.version ? `v${device.version}` : '—'}
          </dd>
        </div>
        <div {...stylex.props(settingsStyles.deviceFact)}>
          <dt {...stylex.props(settingsStyles.deviceFactLabel)}>Config</dt>
          <dd {...stylex.props(settingsStyles.deviceFactValue)}>
            {overrides ? `Profile + ${overrides} override${overrides > 1 ? 's' : ''}` : 'Profile'}
          </dd>
        </div>
      </dl>
      {error ? <p {...stylex.props(settingsStyles.deviceFootText)}>{error}</p> : null}
      <div {...stylex.props(settingsStyles.deviceFoot)}>
        {confirm ? (
          <>
            <span {...stylex.props(settingsStyles.deviceFootText)}>Unpair and revoke its key?</span>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
              Keep
            </Button>
            <Button size="sm" variant="danger" disabled={pending} onClick={() => void unpair()}>
              Unpair
            </Button>
          </>
        ) : canUnpair ? (
          <button
            type="button"
            {...stylex.props(parts.link, parts.linkDanger)}
            onClick={() => setConfirm(true)}
          >
            <Trash2 size={12} /> Unpair
          </button>
        ) : null}
      </div>
    </motion.div>
  );
}
