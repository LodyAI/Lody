/*
 * Harness state: paired devices, provider credentials, the shared profile and
 * per-device overrides. A tiny external store persisted to localStorage, read
 * with `useSyncExternalStore`, so every panel stays in sync without a context.
 *
 * Config model: the profile applies to every device. A device can override any
 * key; the effective config is `{ ...profile, ...overrides[device] }`.
 * Credentials belong to the account and are synced to all devices.
 */
import { useSyncExternalStore } from 'react';

import {
  MODELS,
  PAIR_RESULT,
  PLUGIN_PRESETS,
  type AuthMethod,
  type Autonomy,
  type Device,
  type Effort,
  type FsScope,
  type Network,
  type PairMethod,
} from './catalog';

export interface HarnessConfig {
  mainModel: string;
  subModel: string;
  effort: Effort;
  fallback: boolean;
  plugins: string[];
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
  /** A user-defined endpoint keeps the URL it was added with. */
  baseUrl?: string;
}

/** A provider the user added: OpenAI/Anthropic-compatible base URL plus a model. */
/** The wire protocols a user-defined endpoint can speak. */
export type EndpointProtocol = 'anthropic-messages' | 'openai-responses' | 'openai-completions';

export interface EndpointModel {
  id: string;
  name?: string;
}

export interface CustomProvider {
  id: string;
  name: string;
  protocol: EndpointProtocol;
  baseUrl: string;
  /** Discovered from the endpoint; editable afterwards, never typed up front. */
  models: EndpointModel[];
}

export interface HarnessState {
  version: 1;
  devices: Device[];
  activeDevice: string | null;
  credentials: Record<string, Credential>;
  customs: CustomProvider[];
  profile: HarnessConfig;
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
  plugins: PLUGIN_PRESETS.recommended,
  autonomy: 'smart',
  fsScope: 'workspace',
  network: 'allowlist',
  guarded: ['push', 'delete', 'send', 'spend', 'deploy'],
};

const initial = (): HarnessState => ({
  version: 1,
  devices: [],
  activeDevice: null,
  credentials: {},
  customs: [],
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
    if (parsed.version === 1) state = { ...initial(), ...parsed };
  } catch {}
}

function commit(next: HarnessState) {
  state = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
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

/* ── derived ───────────────────────────────────────────────────────────── */

export function effectiveConfig(s: HarnessState, device: string | null): HarnessConfig {
  return device ? { ...s.profile, ...s.overrides[device] } : s.profile;
}

export function overriddenKeys(s: HarnessState, device: string | null): ConfigKey[] {
  return device ? (Object.keys(s.overrides[device] ?? {}) as ConfigKey[]) : [];
}

export function availableModels(s: HarnessState) {
  const custom = s.customs
    .filter((provider) => s.credentials[provider.id])
    .flatMap((provider) =>
      provider.models.map((model) => ({
        id: model.id,
        provider: provider.id,
        name: model.name ?? model.id,
        context: provider.protocol,
        tier: 'balanced' as const,
      }))
    );
  return [...MODELS.filter((model) => s.credentials[model.provider]), ...custom];
}

/** Best model for a role among the connected providers. */
function pickModel(s: HarnessState, role: 'main' | 'sub'): string {
  const pool = availableModels(s);
  const order =
    role === 'main'
      ? ['frontier', 'balanced', 'local', 'fast']
      : ['fast', 'balanced', 'local', 'frontier'];
  for (const tier of order) {
    const hit = pool.find((model) => model.tier === tier);
    if (hit) return hit.id;
  }
  return '';
}

/** Keep model picks valid after providers change. */
function reconcileModels(s: HarnessState): HarnessState {
  const valid = new Set(availableModels(s).map((model) => model.id));
  const profile = { ...s.profile };
  if (!valid.has(profile.mainModel)) profile.mainModel = pickModel(s, 'main');
  if (!valid.has(profile.subModel)) profile.subModel = pickModel(s, 'sub');
  return { ...s, profile };
}

/* ── actions ───────────────────────────────────────────────────────────── */

const uid = () => Math.random().toString(36).slice(2, 8);

export const harness = {
  pair(method: PairMethod): string {
    const base = PAIR_RESULT[method];
    const taken = state.devices.filter((device) => device.name.startsWith(base.name)).length;
    const device: Device = {
      ...base,
      name: taken ? `${base.name} ${taken + 1}` : base.name,
      id: `dev_${uid()}`,
      pairedAt: Date.now(),
    };
    commit({ ...state, devices: [...state.devices, device], activeDevice: device.id });
    return device.id;
  },

  select(device: string) {
    commit({ ...state, activeDevice: device });
  },

  rename(device: string, name: string) {
    commit({
      ...state,
      devices: state.devices.map((d) =>
        d.id === device ? { ...d, name: name.trim() || d.name } : d
      ),
    });
  },

  unpair(device: string) {
    const devices = state.devices.filter((d) => d.id !== device);
    const { [device]: _gone, ...overrides } = state.overrides;
    commit({
      ...state,
      devices,
      overrides,
      activeDevice: state.activeDevice === device ? (devices[0]?.id ?? null) : state.activeDevice,
    });
  },

  /** Adds a user-defined endpoint and connects it in one step. */
  addCustom(input: {
    name: string;
    protocol: EndpointProtocol;
    baseUrl: string;
    key: string;
  }): string {
    const id = `custom_${uid()}`;
    const custom: CustomProvider = {
      id,
      name: input.name,
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      models: [],
    };
    const credentials = {
      ...state.credentials,
      [id]: {
        provider: id,
        method: 'key' as AuthMethod,
        account: `Key ${input.key.slice(0, 6)}…${input.key.slice(-4)}`,
        addedAt: Date.now(),
        baseUrl: input.baseUrl,
      },
    };
    commit(reconcileModels({ ...state, customs: [...state.customs, custom], credentials }));
    return id;
  },

  /** The endpoint's models are discovered, then edited here. */
  setCustomModels(id: string, models: EndpointModel[]) {
    commit({
      ...state,
      customs: state.customs.map((provider) =>
        provider.id === id ? { ...provider, models } : provider
      ),
    });
  },

  removeCustom(id: string) {
    const { [id]: _credential, ...credentials } = state.credentials;
    commit(
      reconcileModels({
        ...state,
        customs: state.customs.filter((provider) => provider.id !== id),
        credentials,
      })
    );
  },

  connect(provider: string, method: AuthMethod, account: string, baseUrl?: string) {
    const credentials = {
      ...state.credentials,
      [provider]: {
        provider,
        method,
        account,
        addedAt: Date.now(),
        ...(baseUrl ? { baseUrl } : {}),
      },
    };
    commit(reconcileModels({ ...state, credentials }));
  },

  disconnect(provider: string) {
    const { [provider]: _gone, ...credentials } = state.credentials;
    commit(reconcileModels({ ...state, credentials }));
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
