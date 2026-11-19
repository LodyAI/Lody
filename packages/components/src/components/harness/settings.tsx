/*
 * The harness after setup: an overview plus one page per area. Editing scope
 * is explicit — the shared profile, or the device selected in the navigation —
 * so multi-device inheritance is something you can see, not guess.
 *
 * The settings pane owns the page title and the close affordance; this surface
 * lives in the pane's body and keeps its own navigation, so the device the
 * surface is scoped to and the page being edited are always visible.
 */
import { useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Blocks,
  Boxes,
  ChevronRight,
  FileCode2,
  KeyRound,
  MonitorSmartphone,
  Plus,
  ShieldCheck,
  Trash2,
  type LucideIcon,
} from 'lucide-react';

import { ConfigFile } from './config-file';
import { ModelsPanel, PermissionsPanel, PluginsPanel, ProvidersPanel, Section } from './panels';
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
import { effectiveConfig, harness, overriddenKeys, useHarness, type Scope } from './store';
import { settingsStyles } from './settings.styles';

export type HarnessPage = 'devices' | 'providers' | 'models' | 'plugins' | 'permissions' | 'file';

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
  { id: 'file', label: 'Config file', icon: FileCode2 },
];

/** Pages whose values can differ per device. */
const SCOPED = new Set(['models', 'plugins', 'permissions', 'file']);

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
  const state = useHarness();
  const device = state.devices.find((d) => d.id === state.activeDevice) ?? null;
  const [scopeKind, setScopeKind] = useState<'profile' | 'device'>('profile');
  const scope: Scope = scopeKind === 'device' && device ? { device: device.id } : 'profile';
  const overrides = device ? overriddenKeys(state, device.id).length : 0;
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
            deviceCount={state.devices.length}
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
                    ? `Applies to all ${state.devices.length} device${state.devices.length > 1 ? 's' : ''}${overrides ? ` · ${overrides} override${overrides > 1 ? 's' : ''} on ${device.name}` : ''}`
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
              <Section
                title="Providers"
                hint="Account-wide. Every device signs requests with these credentials."
              >
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
              <Section
                title="Plugins"
                hint="Context, MCP servers, skills and hooks injected into every session."
              >
                <PluginsPanel scope={scope} />
              </Section>
            ) : page === 'permissions' ? (
              <Section
                title="Permissions"
                hint="How much the agent does on its own, and where it can reach."
              >
                <PermissionsPanel scope={scope} />
              </Section>
            ) : page === 'file' ? (
              <Section
                title="Config file"
                hint="The same settings as code. Commit it to share a harness with your team."
              >
                <ConfigFile
                  config={effectiveConfig(state, scope === 'profile' ? null : scope.device)}
                  state={state}
                  device={scope === 'profile' ? null : scope.device}
                />
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

/* ── devices ───────────────────────────────────────────────────────────── */

function Devices({ onPair }: { onPair: () => void }) {
  const state = useHarness();
  const [confirm, setConfirm] = useState<string | null>(null);

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
          {state.devices.map((device) => {
            const overrides = overriddenKeys(state, device.id);
            const active = device.id === state.activeDevice;
            return (
              <motion.div
                key={device.id}
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
                    <Button size="sm" variant="ghost" onClick={() => harness.select(device.id)}>
                      Select
                    </Button>
                  )}
                </div>
                <input
                  {...stylex.props(settingsStyles.deviceName)}
                  defaultValue={device.name}
                  aria-label="Device name"
                  onBlur={(event) => harness.rename(device.id, event.target.value)}
                  onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
                />
                <div {...stylex.props(settingsStyles.deviceMeta)}>
                  <span {...stylex.props(settingsStyles.deviceMetaDot)}>
                    <StatusDot status={device.status} />
                  </span>{' '}
                  Online · {device.host}
                </div>
                <dl {...stylex.props(settingsStyles.deviceFacts)}>
                  <div {...stylex.props(settingsStyles.deviceFact)}>
                    <dt {...stylex.props(settingsStyles.deviceFactLabel)}>System</dt>
                    <dd {...stylex.props(settingsStyles.deviceFactValue)}>
                      {device.os} · {device.arch}
                    </dd>
                  </div>
                  <div {...stylex.props(settingsStyles.deviceFact)}>
                    <dt {...stylex.props(settingsStyles.deviceFactLabel)}>Runtime</dt>
                    <dd {...stylex.props(settingsStyles.deviceFactValue)}>v{device.version}</dd>
                  </div>
                  <div {...stylex.props(settingsStyles.deviceFact)}>
                    <dt {...stylex.props(settingsStyles.deviceFactLabel)}>Config</dt>
                    <dd {...stylex.props(settingsStyles.deviceFactValue)}>
                      {overrides.length
                        ? `Profile + ${overrides.length} override${overrides.length > 1 ? 's' : ''}`
                        : 'Profile'}
                    </dd>
                  </div>
                </dl>
                <div {...stylex.props(settingsStyles.deviceFoot)}>
                  {confirm === device.id ? (
                    <>
                      <span {...stylex.props(settingsStyles.deviceFootText)}>
                        Unpair and revoke its key?
                      </span>
                      <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                        Keep
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => harness.unpair(device.id)}>
                        Unpair
                      </Button>
                    </>
                  ) : (
                    <button
                      type="button"
                      {...stylex.props(parts.link, parts.linkDanger)}
                      onClick={() => setConfirm(device.id)}
                    >
                      <Trash2 size={12} /> Unpair
                    </button>
                  )}
                </div>
              </motion.div>
            );
          })}
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
