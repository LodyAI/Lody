/*
 * The four configuration panels. Setup walks through them one at a time;
 * settings shows them as pages. Same components, so what you chose during
 * setup is exactly what you find later.
 *
 * Every panel takes a `scope`: the shared profile, or one device. In device
 * scope a value that differs from the profile is marked and can be reset.
 */
import { useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { AnimatePresence, motion } from 'framer-motion';
import { Globe, HardDrive, Lock, LogOut, Plus, Search, Trash2 } from 'lucide-react';
import { Input, Select } from '@lody/ui';

import { AcpAuthenticationPanel } from '@/components/settings/acp-authentication-panel';

import {
  AUTONOMY,
  CONTEXT_BUDGET,
  GUARDED_ACTIONS,
  MODELS,
  PLUGIN_GROUPS,
  PLUGIN_PRESETS,
  PLUGINS,
  PROVIDERS,
  type Autonomy,
  type PluginPreset,
  type Provider,
  type ProviderKind,
} from './catalog';
import {
  Button,
  DrawnCheck,
  ProviderMark,
  Row,
  Segmented,
  Spinner,
  Switch,
  soft,
  spring,
} from './primitives';
import { useDeviceCapabilities, type HarnessModel } from './device-capabilities';
import { parts } from './parts';
import { panelStyles as ps } from './panels.styles';
import { settingsStyles as page } from './settings.styles';
import { sorbet, useSorbetTarget } from './sorbet';
import {
  effectiveConfig,
  harness,
  overriddenKeys,
  useHarness,
  type ConfigKey,
  type HarnessConfig,
  type Scope,
  type CustomProvider,
  type EndpointProtocol,
} from './store';
import { ENDPOINT_PROTOCOLS, PROTOCOL_LABEL } from './endpoint-models';

function useScoped(scope: Scope) {
  const state = useHarness();
  const device = scope === 'profile' ? null : scope.device;
  const config = effectiveConfig(state, device);
  const overridden = new Set(overriddenKeys(state, device));
  const set = <K extends ConfigKey>(key: K, value: HarnessConfig[K]) =>
    harness.set(scope, key, value);
  return { state, device, config, overridden, set };
}

/** Marks a value that this device sets differently from the profile. */
export function Override({ scope, keys }: { scope: Scope; keys: ConfigKey[] }) {
  const { device, overridden } = useScoped(scope);
  const hit = keys.filter((key) => overridden.has(key));
  return (
    <AnimatePresence initial={false}>
      {device && hit.length > 0 ? (
        <motion.span
          {...stylex.props(parts.override)}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={spring}
        >
          This device
          <button
            type="button"
            {...stylex.props(parts.overrideReset)}
            onClick={() => harness.resetOverride(device, hit)}
            aria-label="Reset to profile"
          >
            Reset
          </button>
        </motion.span>
      ) : null}
    </AnimatePresence>
  );
}

/** A titled section: its name, what it is for, and the block under it. */
export function Section({
  title,
  hint,
  children,
  aside,
}: {
  title?: string;
  hint?: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section {...stylex.props(page.section)}>
      <header {...stylex.props(page.sectionHead)}>
        <div>
          {title ? <h3 {...stylex.props(page.sectionTitle)}>{title}</h3> : null}
          {hint ? <p {...stylex.props(page.sectionHint)}>{hint}</p> : null}
        </div>
        {aside}
      </header>
      {children}
    </section>
  );
}

/* ── providers ─────────────────────────────────────────────────────────── */

/**
 * Providers are grouped by how you reach them — subscription, token, local
 * runtime, or an endpoint you added — because that is what changes the row:
 * a sign-in, a key, a scan, or a base URL plus a key.
 */
const PROVIDER_GROUPS: { kind: ProviderKind; label: string; hint: string }[] = [
  {
    kind: 'subscription',
    label: 'Subscriptions',
    hint: 'Sign in once; the runtime keeps the session per device.',
  },
  {
    kind: 'token',
    label: 'API keys',
    hint: 'Brand tokens. Pick the endpoint your key belongs to.',
  },
  { kind: 'local', label: 'Local runtimes', hint: 'Models on the paired device.' },
  {
    kind: 'custom',
    label: 'Custom endpoints',
    hint: 'Any OpenAI- or Anthropic-compatible base URL.',
  },
];

export function ProvidersPanel() {
  const state = useHarness();
  const [adding, setAdding] = useState(false);

  return (
    <div {...stylex.props(parts.panel)}>
      {PROVIDER_GROUPS.map((group) => {
        const providers = PROVIDERS.filter((provider) => provider.kind === group.kind);
        const customs = group.kind === 'custom' ? state.customs : [];
        if (!providers.length && !customs.length && group.kind !== 'custom') return null;
        return (
          <section key={group.kind} {...stylex.props(ps.plugroup)}>
            <header {...stylex.props(ps.plugroupHead)}>
              <h4 {...stylex.props(ps.plugroupTitle)}>{group.label}</h4>
              <span {...stylex.props(ps.plugroupHint)}>{group.hint}</span>
              {group.kind === 'custom' ? (
                <span style={{ marginInlineStart: 'auto' }}>
                  <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
                    <Plus size={13} /> Add endpoint
                  </Button>
                </span>
              ) : null}
            </header>
            <div {...stylex.props(parts.list)}>
              {providers.map((provider, index) => (
                <ProviderRow key={provider.id} provider={provider} ruled={index > 0} />
              ))}
              {customs.map((custom, index) => (
                <CustomRow
                  key={custom.id}
                  custom={custom}
                  ruled={index > 0 || providers.length > 0}
                />
              ))}
              {group.kind === 'custom' && adding ? (
                <AddEndpointForm onDone={() => setAdding(false)} />
              ) : null}
              {group.kind === 'custom' && !customs.length && !adding ? (
                <div {...stylex.props(parts.emptyInline)}>
                  No endpoints yet. Add one when your gateway speaks the OpenAI or Anthropic API.
                </div>
              ) : null}
            </div>
          </section>
        );
      })}
      <p {...stylex.props(parts.footnote)}>
        <Lock size={12} {...stylex.props(parts.footnoteGlyph)} />
        Credentials live in the agent's own store on this machine; Lody never sees the secret.
      </p>
    </div>
  );
}

/**
 * The button that opens the agent's own sign-in for one method. The panel draws
 * the key field or the browser hand-off itself — the key never passes through
 * this row — and the agent's store answers the next read, which settles the row.
 */
function SignInAction({ provider, method }: { provider: Provider; method: 'api_key' | 'oauth' }) {
  const target = useSorbetTarget();
  if (!target) return null;
  return (
    <AcpAuthenticationPanel
      machineId={target.machineId}
      configId={target.configId}
      cliType={target.config.cliType}
      agentType={target.config.agentType}
      providerName={provider.name}
      runtimeOverrides={target.config.runtimeOverrides}
      env={target.config.env}
      compact
      layout="action"
      onlyMethodId={`sorbet:${provider.id}:${method}`}
      onAuthenticated={sorbet.refresh}
    />
  );
}

function ProviderRow({ provider, ruled }: { provider: Provider; ruled: boolean }) {
  const state = useHarness();
  const credential = state.credentials[provider.id];
  const [pending, setPending] = useState(false);

  const providerModels = MODELS.filter((model) => model.provider === provider.id).length;

  return (
    <div {...stylex.props(parts.prov, ruled && parts.listRuled, credential && parts.provConnected)}>
      <ProviderMark provider={provider} />
      <div {...stylex.props(parts.provText)}>
        <div {...stylex.props(parts.provName)}>
          {provider.name}
          <AnimatePresence initial={false}>
            {credential ? (
              <motion.span
                {...stylex.props(parts.tag, parts.tagOk)}
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                transition={spring}
              >
                <DrawnCheck size={10} />
                {credential.method === 'oauth'
                  ? 'Signed in'
                  : credential.method === 'key'
                    ? 'API key'
                    : 'Local'}
              </motion.span>
            ) : null}
          </AnimatePresence>
        </div>
        <div {...stylex.props(parts.provSub)}>
          {credential ? `${credential.account} · ${providerModels} models` : provider.blurb}
        </div>
        {provider.runtime || provider.endpoints?.length ? (
          <div {...stylex.props(parts.provMeta)}>
            {[
              provider.runtime ? `via ${provider.runtime}` : null,
              provider.endpoints?.length
                ? provider.allowCustomEndpoint
                  ? 'brand endpoints or your own base URL'
                  : 'brand endpoints'
                : null,
              provider.scope === 'machine' ? 'per device' : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        ) : null}
      </div>

      <div {...stylex.props(parts.provActions)}>
        {credential ? (
          <button
            type="button"
            {...stylex.props(parts.iconBtn)}
            aria-label={`Disconnect ${provider.name}`}
            title="Disconnect"
            disabled={pending}
            onClick={() => {
              setPending(true);
              sorbet.disconnect(provider.id).finally(() => setPending(false));
            }}
          >
            <LogOut size={13} />
          </button>
        ) : (
          <>
            {provider.auth.includes('key') ? (
              <SignInAction provider={provider} method="api_key" />
            ) : null}
            {provider.auth.includes('oauth') ? (
              <SignInAction provider={provider} method="oauth" />
            ) : null}
            {/*
             * Detecting a local runtime has no Sorbet RPC — Sorbet reports a
             * `local` credential once it finds one. The button stays visible
             * as the design drew it but does nothing until that lands.
             */}
            {provider.auth.includes('local') ? (
              <Button size="sm" variant="secondary" disabled title="Detection is not available yet">
                <Search size={13} /> Detect
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** A provider the user added: its base URL is the row's subtitle, its models the chips. */
function CustomRow({ custom, ruled }: { custom: CustomProvider; ruled: boolean }) {
  const state = useHarness();
  const credential = state.credentials[custom.id];
  // Model picks land on the agent's own list; they are not edited here — the
  // next read reflects what the endpoint actually serves.

  return (
    <div {...stylex.props(parts.prov, ruled && parts.listRuled, credential && parts.provConnected)}>
      <ProviderMark
        provider={
          {
            id: custom.id,
            name: custom.name,
            mark: custom.name[0] ?? 'E',
            tint: '#64748b',
          } as Provider
        }
      />
      <div {...stylex.props(parts.provText)}>
        <div {...stylex.props(parts.provName)}>
          {custom.name}
          <span {...stylex.props(parts.tag)}>{PROTOCOL_LABEL[custom.protocol]}</span>
          {credential ? <span {...stylex.props(parts.tag, parts.tagOk)}>Connected</span> : null}
        </div>
        <div {...stylex.props(parts.provSub)} style={{ fontFamily: 'var(--font-mono)' }}>
          {custom.baseUrl}
        </div>
        <div {...stylex.props(ps.provModels)}>
          {custom.models.length ? (
            custom.models.map((model) => (
              <span key={model.id} {...stylex.props(ps.modelChip)}>
                {model.name ?? model.id}
              </span>
            ))
          ) : (
            <span {...stylex.props(parts.provMeta)}>No models discovered yet</span>
          )}
        </div>
      </div>
      <div {...stylex.props(parts.provActions)}>
        {credential ? null : (
          <SignInAction
            provider={
              {
                id: custom.id,
                name: custom.name,
                mark: custom.name[0] ?? 'E',
                tint: '#64748b',
                kind: 'custom',
                auth: ['key'],
                blurb: custom.baseUrl,
              } as Provider
            }
            method="api_key"
          />
        )}
        <button
          type="button"
          {...stylex.props(parts.iconBtn)}
          aria-label={`Remove ${custom.name}`}
          title="Remove"
          onClick={() => {
            void sorbet.deleteEndpoint(custom.id);
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

/**
 * Adding an endpoint grows the group instead of opening a second dialog: the
 * settings dialog already is one. Nothing here asks for a model — the endpoint
 * is discovered once it answers, and edited afterwards on its row.
 */
function AddEndpointForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [protocol, setProtocol] = useState<EndpointProtocol>('openai-completions');
  const [baseUrl, setBaseUrl] = useState('https://');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const valid = name.trim() && /^https?:\/\/\S+$/.test(baseUrl.trim());

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError('');
    try {
      // Sorbet assigns the endpoint's id and can discover its models; the key
      // is the sign-in the row then offers on its own.
      await sorbet.createEndpoint({
        name: name.trim(),
        protocol,
        baseUrl: baseUrl.trim(),
      });
      try {
        await sorbet.reprobe();
      } catch {
        // The endpoint is stored; its sign-in method simply lands on the next probe.
      }
      onDone();
    } catch {
      setError('Could not reach the agent. The endpoint is not stored.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      {...stylex.props(ps.endpointForm)}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div {...stylex.props(ps.endpointFields)}>
        <label {...stylex.props(ps.field)}>
          <span {...stylex.props(ps.fieldLabel)}>Name</span>
          <Input
            size="small"
            value={name}
            placeholder="Company gateway"
            autoFocus
            onValueChange={(value) => setName(value)}
          />
        </label>
        <label {...stylex.props(ps.field)}>
          <span {...stylex.props(ps.fieldLabel)}>Protocol</span>
          <Select.Root
            items={ENDPOINT_PROTOCOLS.map((value) => ({ value, label: PROTOCOL_LABEL[value] }))}
            value={protocol}
            onValueChange={(value) => setProtocol(String(value) as EndpointProtocol)}
          >
            <Select.Trigger size="small">
              <Select.Value />
            </Select.Trigger>
            <Select.Content align="end">
              {ENDPOINT_PROTOCOLS.map((value) => (
                <Select.Item key={value} value={value}>
                  {PROTOCOL_LABEL[value]}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </label>
        <label {...stylex.props(ps.field)}>
          <span {...stylex.props(ps.fieldLabel)}>Base URL</span>
          <Input size="small" value={baseUrl} onValueChange={(value) => setBaseUrl(value)} />
        </label>
      </div>

      <div {...stylex.props(ps.endpointFoot)}>
        <span {...stylex.props(parts.provMeta)}>
          {busy
            ? 'Saving on this machine…'
            : 'The endpoint is stored on the agent; its row then takes the key.'}
        </span>
        {error ? (
          <span {...stylex.props(parts.error)} role="alert">
            {error}
          </span>
        ) : null}
        <div {...stylex.props(ps.endpointActions)}>
          <Button size="sm" variant="ghost" type="button" onClick={onDone} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" type="submit" disabled={!valid || busy}>
            {busy ? (
              <>
                <Spinner size={12} /> Adding
              </>
            ) : (
              'Add endpoint'
            )}
          </Button>
        </div>
      </div>
    </form>
  );
}

/* ── models ────────────────────────────────────────────────────────────── */

export function ModelsPanel({ scope }: { scope: Scope }) {
  const { state, config, set } = useScoped(scope);
  const capabilities = useDeviceCapabilities();
  const connected = Object.keys(state.credentials).length;
  const effortOption =
    capabilities.effortOption?.type === 'select' && capabilities.effortOption.options.length
      ? capabilities.effortOption
      : null;
  // The agent's current effort is the initial pick until the user chooses one;
  // a stored pick the agent does not advertise selects nothing rather than
  // pointing at the wrong rung.
  const effortValue: string | null =
    effortOption &&
    (effortOption.options.some((option) => option.value === config.effort)
      ? config.effort
      : typeof effortOption.currentValue === 'string'
        ? effortOption.currentValue
        : config.effort);

  if (!capabilities.models.length) {
    return (
      <div {...stylex.props(parts.panel)}>
        <div {...stylex.props(parts.emptyInline)}>
          Connect a provider first — the models it offers will show up here.
        </div>
      </div>
    );
  }

  return (
    <div {...stylex.props(parts.panel)}>
      <div {...stylex.props(parts.rows)}>
        <Row
          title="Main model"
          hint="Plans, writes code and talks to you."
          badge={<Override scope={scope} keys={['mainModel']} />}
        >
          <ModelSelect value={config.mainModel} onChange={(id) => set('mainModel', id)} />
        </Row>
        <div {...stylex.props(parts.listRuled)}>
          <Row
            title="Subagent model"
            hint="Searches, summarises and runs parallel tasks."
            badge={<Override scope={scope} keys={['subModel']} />}
          >
            <ModelSelect value={config.subModel} onChange={(id) => set('subModel', id)} />
          </Row>
        </div>
        <div {...stylex.props(parts.listRuled)}>
          <Row
            title="Reasoning effort"
            hint={
              effortOption
                ? 'Higher thinks longer before acting; slower and costlier.'
                : 'Not advertised by this agent.'
            }
            badge={<Override scope={scope} keys={['effort']} />}
          >
            <Segmented
              label="Reasoning effort"
              value={effortValue}
              onChange={(v) => set('effort', v)}
              disabled={!effortOption}
              options={
                effortOption
                  ? effortOption.options.map((option) => ({
                      id: option.value,
                      label: option.name,
                    }))
                  : [
                      { id: 'low', label: 'Low' },
                      { id: 'medium', label: 'Medium' },
                      { id: 'high', label: 'High' },
                    ]
              }
            />
          </Row>
        </div>
        <div {...stylex.props(parts.listRuled)}>
          <Row
            title="Fallback"
            hint={
              connected > 1
                ? 'On rate limits or outages, retry on the next connected provider.'
                : 'Connect a second provider to enable fallback.'
            }
            badge={<Override scope={scope} keys={['fallback']} />}
          >
            <Switch
              label="Fallback"
              checked={config.fallback && connected > 1}
              disabled={connected < 2}
              onChange={(v) => set('fallback', v)}
            />
          </Row>
        </div>
      </div>
    </div>
  );
}

/**
 * The model picker, in the shape the harness drew it: a mark and a detail on
 * the closed control, then one group per provider the models name. The pool is
 * the agent's real list — its model select when it advertises one, else the
 * probe's model list — so an option's own group becomes the provider group,
 * and ungrouped ids are read back to the catalogue's providers by prefix.
 */
function ModelSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { models } = useDeviceCapabilities();
  const current = models.find((model) => model.id === value);
  const groups = modelGroups(models);
  const currentGroup = current
    ? groups.find((group) => group.key === modelGroupKey(current))
    : null;
  const items = models.map((model) => ({ value: model.id, label: model.name }));

  return (
    <Select.Root items={items} value={value} onValueChange={(next) => onChange(String(next))}>
      <Select.Trigger size="small">
        {currentGroup?.provider ? (
          <ProviderMark provider={currentGroup.provider} size={16} />
        ) : null}
        <Select.Value placeholder="Connect a provider first" />
        {current?.meta ? <span {...stylex.props(ps.modelMeta)}>{current.meta}</span> : null}
      </Select.Trigger>
      <Select.Content align="end">
        {groups.map((group) => (
          <Select.Group key={group.key}>
            <Select.GroupLabel>{group.label}</Select.GroupLabel>
            {group.models.map((model) => (
              <Select.Item
                key={model.id}
                value={model.id}
                endContent={
                  model.meta ? <span {...stylex.props(ps.modelMeta)}>{model.meta}</span> : undefined
                }
              >
                {group.provider ? <ProviderMark provider={group.provider} size={14} /> : null}
                {model.name}
              </Select.Item>
            ))}
          </Select.Group>
        ))}
      </Select.Content>
    </Select.Root>
  );
}

/**
 * Which catalogue provider a model id belongs to. Sorbet's ids are
 * `provider/model` (`anthropic/claude-opus-4-5`); a bare id still matches the
 * catalogue's own models. Ungrouped entries get one shared group — ACP does
 * not name the provider, so inventing one would be a guess.
 */
const modelProvider = (id: string): Provider | undefined => {
  const owner = id.split('/')[0];
  return (
    PROVIDERS.find((provider) => provider.id === owner) ??
    PROVIDERS.find((provider) => provider.id === MODELS.find((model) => model.id === id)?.provider)
  );
};

const modelGroupKey = (model: HarnessModel): string =>
  model.group ?? modelProvider(model.id)?.id ?? 'models';

interface ModelGroup {
  key: string;
  label: string;
  provider?: Provider;
  models: HarnessModel[];
}

/** The select's groups, in pool order: real group names first, catalogue providers, then the rest. */
function modelGroups(models: HarnessModel[]): ModelGroup[] {
  const groups = new Map<string, ModelGroup>();
  for (const model of models) {
    const key = modelGroupKey(model);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: model.group ?? modelProvider(model.id)?.name ?? 'Models',
        provider: model.group ? undefined : modelProvider(model.id),
        models: [],
      };
      groups.set(key, group);
    }
    group.models.push(model);
  }
  return [...groups.values()];
}

/* ── plugins ───────────────────────────────────────────────────────────── */

function presetOf(ids: string[]): PluginPreset | 'custom' {
  const key = [...ids].sort().join();
  for (const [name, list] of Object.entries(PLUGIN_PRESETS)) {
    if ([...list].sort().join() === key) return name as PluginPreset;
  }
  return 'custom';
}

export function contextTokens(ids: string[]) {
  return PLUGINS.filter((plugin) => ids.includes(plugin.id)).reduce(
    (sum, plugin) => sum + plugin.tokens,
    0
  );
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

/** A plugin group's colour, stated once: the bar and its legend read it. */
const TONE = {
  context: ps.toneContext,
  mcp: ps.toneMcp,
  skills: ps.toneSkills,
  hooks: ps.toneHooks,
} as const;

export function PluginsPanel({ scope }: { scope: Scope }) {
  const { config, set } = useScoped(scope);
  const enabled = new Set(config.plugins);
  const preset = presetOf(config.plugins);
  const total = contextTokens(config.plugins);

  const toggle = (id: string, on: boolean) => {
    const next = on ? [...config.plugins, id] : config.plugins.filter((p) => p !== id);
    set('plugins', next);
  };

  return (
    <div {...stylex.props(parts.panel)}>
      <div {...stylex.props(ps.plugroupHead)}>
        <Segmented
          label="Preset"
          value={preset}
          onChange={(v) => v !== 'custom' && set('plugins', PLUGIN_PRESETS[v])}
          options={[
            { id: 'minimal', label: 'Minimal' },
            { id: 'recommended', label: 'Recommended' },
            { id: 'everything', label: 'Everything' },
            ...(preset === 'custom' ? [{ id: 'custom' as const, label: 'Custom' }] : []),
          ]}
        />
        <Override scope={scope} keys={['plugins']} />
      </div>

      <div {...stylex.props(ps.meter)} aria-label={`${total} of ${CONTEXT_BUDGET} tokens`}>
        <div {...stylex.props(ps.meterHead)}>
          <span>Idle context cost</span>
          <span {...stylex.props(ps.meterValue)}>
            {k(total)}{' '}
            <i {...stylex.props(ps.meterUnit)}>/ {k(CONTEXT_BUDGET)} tokens per request</i>
          </span>
        </div>
        <div {...stylex.props(ps.meterTrack)}>
          <AnimatePresence initial={false}>
            {PLUGINS.filter((plugin) => enabled.has(plugin.id) && plugin.tokens > 0).map(
              (plugin, index) => (
                <motion.span
                  key={plugin.id}
                  layout
                  title={`${plugin.name} · ${plugin.tokens} tokens`}
                  {...stylex.props(
                    ps.meterSeg,
                    index === 0 && ps.meterSegFirst,
                    TONE[plugin.group]
                  )}
                  initial={{ width: 0 }}
                  animate={{ width: `${(plugin.tokens / CONTEXT_BUDGET) * 100}%` }}
                  exit={{ width: 0 }}
                  transition={soft}
                />
              )
            )}
          </AnimatePresence>
        </div>
        <div {...stylex.props(ps.meterLegend)}>
          {PLUGIN_GROUPS.map((group) => (
            <span key={group.id} {...stylex.props(ps.meterLegendItem)}>
              <i {...stylex.props(ps.meterSwatch, TONE[group.id])} />
              {group.label}
            </span>
          ))}
        </div>
      </div>

      {PLUGIN_GROUPS.map((group) => (
        <section key={group.id} {...stylex.props(ps.plugroup)}>
          <header {...stylex.props(ps.plugroupHead)}>
            <h4 {...stylex.props(ps.plugroupTitle)}>{group.label}</h4>
            <span {...stylex.props(ps.plugroupHint)}>{group.hint}</span>
          </header>
          <div {...stylex.props(ps.plugs)}>
            {PLUGINS.filter((plugin) => plugin.group === group.id).map((plugin) => {
              const on = enabled.has(plugin.id);
              return (
                <div
                  key={plugin.id}
                  {...stylex.props(ps.plug, on && ps.plugOn)}
                  role="button"
                  tabIndex={0}
                  onClick={() => toggle(plugin.id, !on)}
                  onKeyDown={(event) => {
                    if (event.key === ' ' || event.key === 'Enter') {
                      event.preventDefault();
                      toggle(plugin.id, !on);
                    }
                  }}
                >
                  <div {...stylex.props(ps.plugText)}>
                    <b {...stylex.props(ps.plugName)}>
                      {plugin.name}
                      {plugin.needsAuth ? <span {...stylex.props(parts.tag)}>Sign-in</span> : null}
                    </b>
                    <span {...stylex.props(ps.plugBody)}>{plugin.body}</span>
                  </div>
                  <div {...stylex.props(ps.plugSide)}>
                    <Switch
                      label={plugin.name}
                      checked={on}
                      onChange={(v) => toggle(plugin.id, v)}
                    />
                    <span {...stylex.props(ps.plugCost)}>
                      {plugin.tokens ? `${k(plugin.tokens)} tok` : '0 tok'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/* ── permissions ───────────────────────────────────────────────────────── */

/** Three gates, filled by how much runs without asking. */
function AutonomyGlyph({ level, active }: { level: Autonomy; active: boolean }) {
  const open = level === 'ask' ? 0 : level === 'smart' ? 2 : 3;
  return (
    <span {...stylex.props(ps.autoGlyph)} aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <i
          key={i}
          {...stylex.props(
            ps.autoGate,
            i < open ? ps.autoGateOpen : active && ps.autoGateClosedActive
          )}
        />
      ))}
    </span>
  );
}

export function PermissionsPanel({ scope }: { scope: Scope }) {
  const { config, set } = useScoped(scope);
  return (
    <div {...stylex.props(parts.panel)}>
      <div {...stylex.props(ps.sub)}>
        <span>Autonomy</span>
        <Override scope={scope} keys={['autonomy']} />
      </div>
      <div {...stylex.props(ps.auto)} role="radiogroup" aria-label="Autonomy">
        {AUTONOMY.map((level) => {
          const active = config.autonomy === level.id;
          return (
            <button
              key={level.id}
              type="button"
              role="radio"
              aria-checked={active}
              {...stylex.props(ps.autoCard)}
              onClick={() => set('autonomy', level.id)}
            >
              {active ? <span {...stylex.props(ps.autoRing)} aria-hidden="true" /> : null}
              <AutonomyGlyph level={level.id} active={active} />
              <b {...stylex.props(ps.autoName)}>{level.title}</b>
              <span {...stylex.props(ps.autoBody)}>{level.body}</span>
              <small {...stylex.props(ps.autoExample)}>{level.example}</small>
            </button>
          );
        })}
      </div>

      <div {...stylex.props(parts.rows)}>
        <Row
          title={
            <>
              <HardDrive size={13} {...stylex.props(parts.rowTitleGlyph)} /> File access
            </>
          }
          hint="Where the agent can read and write."
          badge={<Override scope={scope} keys={['fsScope']} />}
        >
          <Segmented
            label="File access"
            value={config.fsScope}
            onChange={(v) => set('fsScope', v)}
            options={[
              { id: 'workspace', label: 'Workspace' },
              { id: 'home', label: 'Home' },
              { id: 'full', label: 'Full disk' },
            ]}
          />
        </Row>
        <div {...stylex.props(parts.listRuled)}>
          <Row
            title={
              <>
                <Globe size={13} {...stylex.props(parts.rowTitleGlyph)} /> Network
              </>
            }
            hint={
              config.network === 'allowlist'
                ? 'Package registries, docs and your connected services.'
                : 'Outbound requests from tools and shell.'
            }
            badge={<Override scope={scope} keys={['network']} />}
          >
            <Segmented
              label="Network"
              value={config.network}
              onChange={(v) => set('network', v)}
              options={[
                { id: 'off', label: 'Off' },
                { id: 'allowlist', label: 'Allowlist' },
                { id: 'on', label: 'Open' },
              ]}
            />
          </Row>
        </div>
      </div>

      <div {...stylex.props(ps.sub)}>
        <span>Always ask before</span>
        <Override scope={scope} keys={['guarded']} />
      </div>
      <div {...stylex.props(ps.chips)}>
        {GUARDED_ACTIONS.map((action) => {
          const on = config.guarded.includes(action.id);
          return (
            <button
              key={action.id}
              type="button"
              aria-pressed={on}
              {...stylex.props(ps.chip, on && ps.chipOn)}
              onClick={() =>
                set(
                  'guarded',
                  on
                    ? config.guarded.filter((g) => g !== action.id)
                    : [...config.guarded, action.id]
                )
              }
            >
              <span {...stylex.props(ps.chipBox, on && ps.chipBoxOn)}>
                {on ? <DrawnCheck size={10} /> : null}
              </span>
              {action.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
