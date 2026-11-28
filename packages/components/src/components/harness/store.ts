/*
 * Harness state: paired devices, provider credentials, the shared profile and
 * per-device overrides. A tiny external store persisted to localStorage, read
 * with `useSyncExternalStore`, so every panel stays in sync without a context.
 *
 * Config model: the profile applies to every device. A device can override any
 * key; the effective config is `{ ...profile, ...overrides[device] }`.
 * Credentials and endpoints belong to the machine's agent and are a live view,
 * written by `applyRemote`, never persisted.
 */
import { useSyncExternalStore } from 'react';

import {
  MODELS,
  type Autonomy,
  type Effort,
  type FsScope,
  type Network,
  type AuthMethod,
} from './catalog';

export interface HarnessConfig {
  mainModel: string;
  subModel: string;
  effort: Effort;
  fallback: boolean;
  autonomy: Autonomy;
  fsScope: FsScope;
  network: Network;
  guarded: string[];
}

export type ConfigKey = keyof HarnessConfig;

export interface Credential {
  provider: string;
  method: AuthMethod;
  account: string;
  addedAt: number;
}

/** The wire protocols a user-defined endpoint can speak. */
export type EndpointProtocol = 'anthropic-messages' | 'openai-responses' | 'openai-completions';

export interface EndpointModel {
  id: string;
  name?: string;
}

export interface SorbetModel {
  selector: string;
  providerId: string;
  modelId: string;
  displayName: string;
}

/** An endpoint the agent stores on the machine, read back with its models. */
export interface CustomProvider {
  id: string;
  name: string;
  protocol: EndpointProtocol;
  baseUrl: string;
  /** What the endpoint reported it serves; the agent discovers, Lody shows. */
  models: EndpointModel[];
}

/**
 * What the last machine read produced. `credentials` and `customs` belong to
 * Sorbet on the machine: they arrive over RPC and are written here by
 * `applyRemote`, never persisted — reload re-reads, it does not replay.
 */
export interface HarnessState {
  version: 1;
  /**
   * The selected machine's `MachineId`. The rows themselves are a live view
   * of the workspace's machines (see machines.tsx); the store never holds
   * them — pairing surfaces a real machine rather than minting a fake row.
   */
  activeDevice: string | null;
  credentials: Record<string, Credential>;
  customs: CustomProvider[];
  models: SorbetModel[];
  /**
   * Sorbet's machine-wide Host settings, read with `sorbet/host-settings-get`.
   * Machine-scoped, so it does not follow the profile/device split the drawn
   * toggles pretend to have; `null` until the machine answers.
   */
  hostSettings: import('@lody/shared/local-machine-rpc').SorbetHostSettings | null;
  /**
   * `unreachable` is the one that is not about the machine at all: it speaks
   * the store protocols, but only to a client on that machine, and this
   * workspace offers no encrypted plane to ask it from. See `storeUnreachable`.
   *
   * `mirrored` is the read-only answer to the same situation: the machine's
   * daemon published what it read from its Sorbet store into its Machine Flock,
   * which this client can read, but nothing here can be written back. The lists
   * are the machine's own descriptors and `mirroredAt` says how old that read is.
   */
  status:
    | 'loading'
    | 'ready'
    | 'error'
    | 'unsupported'
    | 'unreachable'
    | 'mirrored'
    | 'no-agent'
    | 'no-runtime';
  /** When the machine last read its Sorbet store; null unless `status` is `mirrored`. */
  mirroredAt: number | null;
  /** Whether the machine spoke `sorbet/host-settings-*` on the last probe. */
  hostSettingsSupported: boolean;
  profile: HarnessConfig;
  /**
   * Profile keys someone set through "Profile · all devices". Only these mark
   * a device that differs as an override; until then the profile shows the
   * selected device's own value.
   */
  profileKeys?: ConfigKey[];
  overrides: Record<string, Partial<HarnessConfig>>;
  setupDone: boolean;
  setupStep: number;
}

/** Where an edit lands: the shared profile, or one device. */
export type Scope = 'profile' | { device: string };

const KEY = 'lody-harness-v1';

const DEFAULT_PROFILE: HarnessConfig = {
  mainModel: '',
  subModel: '',
  effort: 'medium',
  fallback: true,
  autonomy: 'smart',
  fsScope: 'workspace',
  network: 'allowlist',
  guarded: ['push', 'delete', 'send', 'spend', 'deploy'],
};

const initial = (): HarnessState => ({
  version: 1,
  activeDevice: null,
  credentials: {},
  customs: [],
  models: [],
  hostSettings: null,
  hostSettingsSupported: false,
  mirroredAt: null,
  status: 'loading',
  profile: DEFAULT_PROFILE,
  overrides: {},
  setupDone: false,
  setupStep: 0,
});

let state: HarnessState = initial();
let hydrated = false;
const listeners = new Set<() => void>();

function hydrate() {
  if (hydrated || typeof window === 'undefined') return;
  hydrated = true;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as HarnessState;
    // Credentials and endpoints live on the machine; what was stored is the
    // drawn profile, so remote-owned fields always start empty.
    if (parsed.version === 1)
      state = {
        ...initial(),
        ...parsed,
        credentials: {},
        customs: [],
        models: [],
        hostSettings: null,
        hostSettingsSupported: false,
        mirroredAt: null,
        status: 'loading',
      };
  } catch {}
}

function commit(next: HarnessState) {
  state = next;
  try {
    // Only what the surface owns is persisted; machine-owned lists are a view.
    const {
      credentials: _credentials,
      customs: _customs,
      models: _models,
      hostSettings: _hostSettings,
      hostSettingsSupported: _hostSettingsSupported,
      mirroredAt: _mirroredAt,
      status: _status,
      ...persisted
    } = next;
    window.localStorage.setItem(KEY, JSON.stringify(persisted));
  } catch {}
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  hydrate();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useHarness(): HarnessState {
  return useSyncExternalStore(
    subscribe,
    () => (hydrate(), state),
    () => state
  );
}

/** Current state, for event handlers. */
export const getHarness = () => state;

/**
 * An empty list from a store this client could not reach says nothing about the
 * machine: no claim of "no connections", and no write.
 */
export const storeUnreadable = (s: Pick<HarnessState, 'status'>): boolean =>
  s.status === 'unsupported' || s.status === 'unreachable';

/** The machine's store read through its own mirror rows: readable, never writable. */
export const storeMirrored = (s: Pick<HarnessState, 'status'>): boolean =>
  s.status === 'mirrored';

/**
 * Whether the store's write controls must be drawn disabled. A mirrored view is
 * the machine's last read, not a channel back to it, so every write — sign-in
 * included — happens on the machine that owns the store.
 */
export const storeLocked = (s: Pick<HarnessState, 'status'>): boolean =>
  storeUnreadable(s) || storeMirrored(s);

/* ── derived ───────────────────────────────────────────────────────────── */

export function effectiveConfig(s: HarnessState, device: string | null): HarnessConfig {
  return device ? { ...s.profile, ...s.overrides[device] } : s.profile;
}

export function overriddenKeys(s: HarnessState, device: string | null): ConfigKey[] {
  return device ? (Object.keys(s.overrides[device] ?? {}) as ConfigKey[]) : [];
}

/**
 * The static-catalogue model pool — kept for reconciling legacy picks. The
 * Models page itself reads the machine's ACP capability entry instead
 * (`device-capabilities.ts`); an endpoint's models still count here because
 * that entry is exactly what the probe that discovered them writes.
 */
export function availableModels(s: HarnessState) {
  if (s.models.length > 0) {
    return s.models.map((model) => ({
      id: model.selector,
      provider: model.providerId,
      name: model.displayName,
      context: model.modelId,
      tier: 'balanced' as const,
    }));
  }
  return MODELS.filter((model) => s.credentials[model.provider]);
}

/**
 * A model pick stays valid while its provider is still in the machine's last
 * read — the Models page's real pool comes from the capability probe, which
 * only exists because a provider signed in. Unknown ids clear; the page shows
 * the list with nothing selected rather than a pick it cannot name.
 */
function reconcileModels(s: HarnessState): HarnessState {
  const valid = new Set(availableModels(s).map((model) => model.id));
  const profile = { ...s.profile };
  if (profile.mainModel && !valid.has(profile.mainModel)) profile.mainModel = '';
  if (profile.subModel && !valid.has(profile.subModel)) profile.subModel = '';
  return { ...s, profile };
}

/* ── actions ───────────────────────────────────────────────────────────── */

export const harness = {
  /**
   * The machine's answer to a credentials/providers read. Reconciliation keeps
   * the model picks pointing at providers that still exist. Only a `mirrored`
   * patch keeps a mirror stamp; every other status is a live answer or no answer,
   * and neither may be aged by an earlier row.
   */
  applyRemote(
    patch: Pick<HarnessState, 'credentials' | 'customs' | 'models' | 'status'> &
      Partial<Pick<HarnessState, 'mirroredAt'>>
  ) {
    commit(
      reconcileModels({
        ...state,
        mirroredAt: patch.status === 'mirrored' ? (patch.mirroredAt ?? null) : null,
        ...patch,
      })
    );
  },

  /**
   * The machine's Host settings, applied separately from the credentials
   * read: it depends on the host-settings capability, not the providers one.
   */
  applyHostSettings(hostSettings: HarnessState['hostSettings'], supported: boolean) {
    commit({ ...state, hostSettings, hostSettingsSupported: supported });
  },

  select(device: string) {
    commit({ ...state, activeDevice: device });
  },

  /**
   * Per-device overrides are keyed by `MachineId`; the machine doc owns the
   * name and the row. Call this when a machine leaves the workspace so its
   * overrides do not linger under an id another surface can no longer scope.
   */
  forgetDevice(device: string) {
    const { [device]: _gone, ...overrides } = state.overrides;
    commit({
      ...state,
      overrides,
      activeDevice: state.activeDevice === device ? null : state.activeDevice,
    });
  },

  set<K extends ConfigKey>(scope: Scope, key: K, value: HarnessConfig[K]) {
    if (scope === 'profile') {
      commit({ ...state, profile: { ...state.profile, [key]: value } });
      return;
    }
    const current = { ...state.overrides[scope.device] };
    // Writing the profile's own value back clears the override.
    if (JSON.stringify(state.profile[key]) === JSON.stringify(value)) delete current[key];
    else current[key] = value;
    commit({ ...state, overrides: { ...state.overrides, [scope.device]: current } });
  },

  /** A profile value that was also written to every device's Lody Agent. */
  setProfileDefault<K extends ConfigKey>(key: K, value: HarnessConfig[K]) {
    const profileKeys = state.profileKeys?.includes(key)
      ? state.profileKeys
      : [...(state.profileKeys ?? []), key];
    commit({ ...state, profile: { ...state.profile, [key]: value }, profileKeys });
  },

  resetOverride(device: string, keys: ConfigKey[]) {
    const current = { ...state.overrides[device] };
    keys.forEach((key) => delete current[key]);
    commit({ ...state, overrides: { ...state.overrides, [device]: current } });
  },

  step(index: number) {
    commit({ ...state, setupStep: index });
  },

  finish() {
    commit({ ...state, setupDone: true });
  },

  /** Replay setup without losing devices. */
  rerunSetup() {
    commit({ ...state, setupDone: false, setupStep: 0 });
  },

  reset() {
    commit(initial());
  },
};
