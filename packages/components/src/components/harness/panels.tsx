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
import { useAtomValue } from 'jotai';
import {
  Globe,
  HardDrive,
  Lock,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { Input, Select } from '@lody/ui';

import { getServerNow, type WorkspaceMcpServerMeta } from '@lody/shared';

import { localMachineIdAtom } from '@/atoms/local-probe';
import {
  useWorkspaceMcpCatalog,
  useWorkspaceMcpCatalogActions,
} from '@/hooks/use-workspace-mcp-catalog';
import { AcpAuthenticationPanel } from '@/components/settings/acp-authentication-panel';

import {
  AUTONOMY,
  GUARDED_ACTIONS,
  MODELS,
  PROVIDERS,
  type Autonomy,
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
  spring,
} from './primitives';
import { useDeviceCapabilities, type HarnessModel } from './device-capabilities';
import {
  useSessionDefaults,
  type SessionDefaultKey,
  type SessionDefaults,
} from './session-defaults';
import { parts } from './parts';
import { panelStyles as ps } from './panels.styles';
import { settingsStyles as page } from './settings.styles';
import { sorbet, supportsSorbetEndpointEdit, useHarnessMachine, useSorbetTarget } from './sorbet';
import { useHarness, type Scope, type CustomProvider, type EndpointProtocol } from './store';
import { ENDPOINT_PROTOCOLS, PROTOCOL_LABEL } from './endpoint-models';

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
        Credentials stay in Sorbet’s store on the selected machine; Lody never stores the secret.
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

/** How many model chips a row draws before it offers the rest. */
const ENDPOINT_MODEL_PREVIEW = 12;

/**
 * A provider the user added: its base URL is the row's subtitle, the models
 * Sorbet discovered on it are the chips. The row refreshes discovery and, on a
 * daemon that supports it, edits the endpoint in place.
 */
function CustomRow({ custom, ruled }: { custom: CustomProvider; ruled: boolean }) {
  const state = useHarness();
  const credential = state.credentials[custom.id];
  const { machine } = useHarnessMachine();
  const localMachineId = useAtomValue(localMachineIdAtom);
  const canEdit = !!machine && supportsSorbetEndpointEdit(machine, localMachineId);
  const [editing, setEditing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState('');

  // The machine's model catalog is what the agent can actually select; the
  // stored definition's own list is only a fallback for older reads.
  const discovered = state.models
    .filter((model) => model.providerId === custom.id)
    .map((model) => ({ id: model.modelId, name: model.displayName }));
  const models = discovered.length ? discovered : custom.models;
  const shown = showAll ? models : models.slice(0, ENDPOINT_MODEL_PREVIEW);

  const refresh = async () => {
    setRefreshing(true);
    setError('');
    try {
      await sorbet.refresh(custom.id);
    } catch {
      setError('Could not refresh models on this machine.');
    } finally {
      setRefreshing(false);
    }
  };

  if (editing) {
    return (
      <div {...stylex.props(ruled && parts.listRuled)}>
        <EndpointForm
          initial={custom}
          submitLabel="Save"
          busyLabel="Saving"
          hint="Models stay as discovered; refresh after changing the URL or protocol."
          onCancel={() => setEditing(false)}
          onSubmit={async (endpoint) => {
            await sorbet.updateEndpoint(custom.id, endpoint);
            setEditing(false);
            void refresh();
          }}
          failure="Could not save the endpoint on this machine."
        />
      </div>
    );
  }

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
          {models.length ? (
            <>
              {shown.map((model) => (
                <span key={model.id} {...stylex.props(ps.modelChip)} title={model.id}>
                  {model.name ?? model.id}
                </span>
              ))}
              {models.length > ENDPOINT_MODEL_PREVIEW ? (
                <button
                  type="button"
                  {...stylex.props(parts.link)}
                  onClick={() => setShowAll((value) => !value)}
                >
                  {showAll ? 'Show fewer' : `+${models.length - ENDPOINT_MODEL_PREVIEW} more`}
                </button>
              ) : null}
            </>
          ) : (
            <span {...stylex.props(parts.provMeta)}>
              {refreshing
                ? 'Discovering models…'
                : credential
                  ? 'No models discovered yet — refresh to ask the endpoint again.'
                  : 'Add a key, then refresh to discover models.'}
            </span>
          )}
        </div>
        {error ? (
          <span {...stylex.props(parts.error)} role="alert">
            {error}
          </span>
        ) : null}
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
          aria-label={`Refresh models for ${custom.name}`}
          title="Refresh models"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          {refreshing ? <Spinner size={12} /> : <RefreshCw size={13} />}
        </button>
        {canEdit ? (
          <button
            type="button"
            {...stylex.props(parts.iconBtn)}
            aria-label={`Edit ${custom.name}`}
            title="Edit"
            onClick={() => setEditing(true)}
          >
            <Pencil size={13} />
          </button>
        ) : null}
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
  return (
    <EndpointForm
      submitLabel="Add endpoint"
      busyLabel="Adding"
      hint="The endpoint is stored on the agent; its row then takes the key."
      failure="Could not reach the agent. The endpoint is not stored."
      onCancel={onDone}
      onSubmit={async (endpoint) => {
        // Sorbet assigns the endpoint's id and can discover its models; the key
        // is the sign-in the row then offers on its own.
        await sorbet.createEndpoint(endpoint);
        try {
          await sorbet.reprobe();
        } catch {
          // The endpoint is stored; its sign-in method simply lands on the next probe.
        }
        onDone();
      }}
    />
  );
}

/** The endpoint fields, shared by adding a new endpoint and editing a stored one. */
function EndpointForm({
  initial,
  submitLabel,
  busyLabel,
  hint,
  failure,
  onCancel,
  onSubmit,
}: {
  initial?: { name: string; protocol: EndpointProtocol; baseUrl: string };
  submitLabel: string;
  busyLabel: string;
  hint: string;
  failure: string;
  onCancel: () => void;
  onSubmit: (endpoint: {
    name: string;
    protocol: EndpointProtocol;
    baseUrl: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [protocol, setProtocol] = useState<EndpointProtocol>(
    initial?.protocol ?? 'openai-completions'
  );
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? 'https://');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const valid = name.trim() && /^https?:\/\/\S+$/.test(baseUrl.trim());

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit({ name: name.trim(), protocol, baseUrl: baseUrl.trim() });
    } catch {
      setError(failure);
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
        <span {...stylex.props(parts.provMeta)}>{busy ? 'Saving on this machine…' : hint}</span>
        {error ? (
          <span {...stylex.props(parts.error)} role="alert">
            {error}
          </span>
        ) : null}
        <div {...stylex.props(ps.endpointActions)}>
          <Button size="sm" variant="ghost" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" type="submit" disabled={!valid || busy}>
            {busy ? (
              <>
                <Spinner size={12} /> {busyLabel}
              </>
            ) : (
              submitLabel
            )}
          </Button>
        </div>
      </div>
    </form>
  );
}

/* ── models ────────────────────────────────────────────────────────────── */

/** Shown on a control Lody Agent has no setting for yet: visible, not editable. */
const UNSUPPORTED = 'Not supported by Lody Agent yet';

function Unsupported() {
  return <span {...stylex.props(parts.tag)}>{UNSUPPORTED}</span>;
}

/** Marks a real setting this device runs differently from the profile. */
function DefaultsOverride({
  defaults,
  keys,
}: {
  defaults: SessionDefaults;
  keys: SessionDefaultKey[];
}) {
  const hit = keys.filter((key) => defaults.overridden.has(key));
  return (
    <AnimatePresence initial={false}>
      {hit.length > 0 ? (
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
            onClick={() => void defaults.reset(hit)}
            aria-label="Reset to profile"
          >
            Reset
          </button>
        </motion.span>
      ) : null}
    </AnimatePresence>
  );
}

/** Where a write stands: nothing to say once it landed. */
function DefaultsStatus({ defaults }: { defaults: SessionDefaults }) {
  const text = !defaults.available
    ? 'Lody Agent is not set up on this device yet, so there is nothing to save to.'
    : defaults.error
      ? defaults.error
      : defaults.saving
        ? 'Saving…'
        : null;
  if (!text) return null;
  return (
    <p {...stylex.props(defaults.error ? parts.error : parts.provMeta)} role="status">
      {text}
    </p>
  );
}

export function ModelsPanel({ scope }: { scope: Scope }) {
  const capabilities = useDeviceCapabilities();
  const defaults = useSessionDefaults(scope);
  const effortOption =
    capabilities.effortOption?.type === 'select' && capabilities.effortOption.options.length
      ? capabilities.effortOption
      : null;
  // A stored rung the agent does not advertise selects nothing rather than
  // pointing at the wrong one.
  const effortValue =
    effortOption && effortOption.options.some((option) => option.value === defaults.values.effort)
      ? (defaults.values.effort ?? null)
      : null;

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
      <DefaultsStatus defaults={defaults} />
      <div {...stylex.props(parts.rows)}>
        <Row
          title="Main model"
          hint="New conversations start on this model. You can still switch in the composer."
          badge={<DefaultsOverride defaults={defaults} keys={['mainModel']} />}
        >
          <ModelSelect
            value={defaults.values.mainModel ?? ''}
            disabled={!defaults.available}
            onChange={(id) => void defaults.set('mainModel', id)}
          />
        </Row>
        <div {...stylex.props(parts.listRuled)}>
          <Row
            title="Subagent model"
            hint="Searches, summarises and runs parallel tasks."
            badge={<Unsupported />}
          >
            <ModelSelect value="" placeholder="—" disabled onChange={() => {}} />
          </Row>
        </div>
        <div {...stylex.props(parts.listRuled)}>
          <Row
            title="Reasoning effort"
            hint={
              effortOption
                ? 'Where new conversations start; higher thinks longer, slower and costlier.'
                : 'Not advertised by this agent.'
            }
            badge={<DefaultsOverride defaults={defaults} keys={['effort']} />}
          >
            <Segmented
              label="Reasoning effort"
              value={effortValue}
              onChange={(value) => void defaults.set('effort', value)}
              disabled={!effortOption || !defaults.available}
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
            hint="On rate limits or outages, retry on the next connected provider."
            badge={<Unsupported />}
          >
            <Switch label="Fallback" checked={false} disabled onChange={() => {}} />
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
function ModelSelect({
  value,
  onChange,
  disabled,
  placeholder = 'Connect a provider first',
}: {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const { models } = useDeviceCapabilities();
  const current = models.find((model) => model.id === value);
  const groups = modelGroups(models);
  const currentGroup = current
    ? groups.find((group) => group.key === modelGroupKey(current))
    : null;
  const items = models.map((model) => ({ value: model.id, label: model.name }));

  return (
    <Select.Root
      items={items}
      value={value}
      disabled={disabled}
      onValueChange={(next) => onChange(String(next))}
    >
      <Select.Trigger size="small">
        {currentGroup?.provider ? (
          <ProviderMark provider={currentGroup.provider} size={16} />
        ) : null}
        <Select.Value placeholder={placeholder} />
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

/**
 * Plugins Lody Agent installs in every conversation. Sorbet keeps each one's
 * on/off state per conversation (its Plugin controls), so there is no default
 * for this page to change: they are listed as they run.
 */
const SORBET_BUILTIN_PLUGINS = [
  {
    id: 'prompt-suggestion',
    name: 'Prompt suggestions',
    body: 'Suggests what to ask next after each turn.',
  },
  {
    id: 'codemode',
    name: 'CodeMode',
    body: 'Lets the agent chain tool calls in one script instead of one call per step.',
  },
];

/**
 * What a new conversation starts with besides the model: the workspace's MCP
 * servers it attaches by default, and the plugins Lody Agent brings itself.
 * MCP defaults are workspace-wide — the same switches as Settings › MCP.
 */
export function PluginsPanel() {
  const { servers, synced } = useWorkspaceMcpCatalog();
  const { upsert } = useWorkspaceMcpCatalogActions();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');

  const toggle = async (server: WorkspaceMcpServerMeta, enabledByDefault: boolean) => {
    setPending(server.id);
    setError('');
    try {
      await upsert({ ...server, enabledByDefault, updatedAt: getServerNow() });
    } catch {
      setError(`Could not update ${server.name}.`);
    } finally {
      setPending(null);
    }
  };

  return (
    <div {...stylex.props(parts.panel)}>
      <section {...stylex.props(ps.plugroup)}>
        <header {...stylex.props(ps.plugroupHead)}>
          <h4 {...stylex.props(ps.plugroupTitle)}>MCP servers</h4>
          <span {...stylex.props(ps.plugroupHint)}>
            Attached to new conversations · whole workspace
          </span>
        </header>
        {error ? (
          <span {...stylex.props(parts.error)} role="alert">
            {error}
          </span>
        ) : null}
        {servers.length ? (
          <div {...stylex.props(ps.plugs)}>
            {servers.map((server) => {
              const on = server.enabledByDefault === true;
              return (
                <div key={server.id} {...stylex.props(ps.plug, on && ps.plugOn)}>
                  <div {...stylex.props(ps.plugText)}>
                    <b {...stylex.props(ps.plugName)}>
                      {server.name}
                      <span {...stylex.props(parts.tag)}>
                        {server.transport === 'http' ? 'HTTP' : 'Local'}
                      </span>
                    </b>
                    <span {...stylex.props(ps.plugBody)}>
                      {server.description || 'No description.'}
                    </span>
                  </div>
                  <div {...stylex.props(ps.plugSide)}>
                    <Switch
                      label={`Attach ${server.name} by default`}
                      checked={on}
                      disabled={pending === server.id}
                      onChange={(value) => void toggle(server, value)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div {...stylex.props(parts.emptyInline)}>
            {synced
              ? 'No MCP servers in this workspace yet. Add one in Settings › MCP.'
              : 'Reading this workspace’s MCP servers…'}
          </div>
        )}
      </section>

      <section {...stylex.props(ps.plugroup)}>
        <header {...stylex.props(ps.plugroupHead)}>
          <h4 {...stylex.props(ps.plugroupTitle)}>Built into Lody Agent</h4>
          <span {...stylex.props(ps.plugroupHint)}>On in every conversation</span>
        </header>
        <div {...stylex.props(ps.plugs)}>
          {SORBET_BUILTIN_PLUGINS.map((plugin) => (
            <div key={plugin.id} {...stylex.props(ps.plug, ps.plugOn)}>
              <div {...stylex.props(ps.plugText)}>
                <b {...stylex.props(ps.plugName)}>
                  {plugin.name}
                  <span {...stylex.props(parts.tag)}>Set per conversation</span>
                </b>
                <span {...stylex.props(ps.plugBody)}>{plugin.body}</span>
              </div>
              <div {...stylex.props(ps.plugSide)}>
                <Switch label={plugin.name} checked disabled onChange={() => {}} />
              </div>
            </div>
          ))}
        </div>
      </section>
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
  const defaults = useSessionDefaults(scope);
  const current = defaults.values.autonomy;
  return (
    <div {...stylex.props(parts.panel)}>
      <DefaultsStatus defaults={defaults} />
      <div {...stylex.props(ps.sub)}>
        <span>Autonomy</span>
        <DefaultsOverride defaults={defaults} keys={['autonomy']} />
      </div>
      <div {...stylex.props(ps.auto)} role="radiogroup" aria-label="Autonomy">
        {AUTONOMY.map((level) => {
          const active = current === level.id;
          const offered = !defaults.autonomyOffered || defaults.autonomyOffered.has(level.id);
          return (
            <button
              key={level.id}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={!offered || !defaults.available}
              {...stylex.props(ps.autoCard)}
              onClick={() => void defaults.set('autonomy', level.id)}
            >
              {active ? <span {...stylex.props(ps.autoRing)} aria-hidden="true" /> : null}
              <AutonomyGlyph level={level.id} active={active} />
              <b {...stylex.props(ps.autoName)}>{level.title}</b>
              <span {...stylex.props(ps.autoBody)}>{level.body}</span>
              <small {...stylex.props(ps.autoExample)}>
                {offered ? level.example : 'Not offered by this device’s agent.'}
              </small>
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
          badge={<Unsupported />}
        >
          <Segmented
            label="File access"
            value="workspace"
            disabled
            onChange={() => {}}
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
            hint="Outbound requests from tools and shell."
            badge={<Unsupported />}
          >
            <Segmented
              label="Network"
              value="allowlist"
              disabled
              onChange={() => {}}
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
        <Unsupported />
      </div>
      <div {...stylex.props(ps.chips)}>
        {GUARDED_ACTIONS.map((action) => (
          <button
            key={action.id}
            type="button"
            aria-pressed={false}
            disabled
            {...stylex.props(ps.chip)}
          >
            <span {...stylex.props(ps.chipBox)} />
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}
