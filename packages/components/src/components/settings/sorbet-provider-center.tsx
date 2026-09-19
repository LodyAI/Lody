import { useCallback, useEffect, useState } from 'react';
import { Check, Pencil, Plus, Trash2 } from 'lucide-react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import {
  machineSupportsSorbetProviderCenterProtocol,
  type AgentConfigId,
  type MachineId,
  type SorbetCustomProviderInput,
  type SorbetCustomProviderProtocol,
  type SorbetProviderCenterOperation,
  type SorbetProviderCenterResponse,
  type SorbetProviderCenterSnapshot,
  type SorbetProviderConnection,
} from '@lody/shared';

import { getMachineMetaByIdAtomFamily } from '@/atoms/machines';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Spinner } from '@/ui/spinner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/alert-dialog';
import { AcpAuthenticationPanel } from './acp-authentication-panel';

const CODEX_PROVIDER_ID = 'openai-codex';
const CLAUDE_PROVIDER_ID = 'anthropic';

const oauthMethodId = (providerId: string): string =>
  `sorbet:${encodeURIComponent(providerId)}:oauth`;

type CustomProviderDraft = {
  providerId?: string;
  original?: SorbetCustomProviderInput;
  name: string;
  protocol: SorbetCustomProviderProtocol;
  baseUrl: string;
  models: string;
  apiKey: string;
};

const EMPTY_CUSTOM_DRAFT: CustomProviderDraft = {
  name: '',
  protocol: 'openai-responses',
  baseUrl: '',
  models: '',
  apiKey: '',
};

const modelLines = (provider: SorbetProviderConnection): string =>
  (provider.custom?.models ?? provider.models).map((model) => model.id).join('\n');

function parseModelIds(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/u)
        .map((part) => part.trim())
        .filter(Boolean)
    ),
  ];
}

export function SorbetProviderCenter({
  machineId,
  configId,
  onBeforeAuthenticate,
  onChanged,
}: {
  machineId: MachineId;
  configId: AgentConfigId;
  onBeforeAuthenticate: () => void | Promise<void>;
  onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const machine = useAtomValue(getMachineMetaByIdAtomFamily(machineId));
  const supported = machineSupportsSorbetProviderCenterProtocol(machine);
  const [snapshot, setSnapshot] = useState<SorbetProviderCenterSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteProvider, setDeleteProvider] = useState<SorbetProviderConnection | null>(null);
  const [customDraft, setCustomDraft] = useState<CustomProviderDraft | null>(null);
  const [apiKeyDrafts, setApiKeyDrafts] = useState<Record<string, string>>({});

  const acceptResponse = useCallback((response: SorbetProviderCenterResponse | null) => {
    if (!response?.success || !response.snapshot) {
      throw new Error(response?.error ?? 'Provider settings did not respond.');
    }
    setSnapshot(response.snapshot);
    setError(null);
    return response;
  }, []);

  const refresh = useCallback(async () => {
    if (!runtime || !supported) return;
    setLoading(true);
    setError(null);
    try {
      acceptResponse(await runtime.requestSorbetProviderCenter(machineId, { action: 'snapshot' }));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  }, [acceptResponse, machineId, runtime, supported]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (key: string, operation: SorbetProviderCenterOperation) => {
      if (!runtime) throw new Error('Workspace runtime is unavailable.');
      setBusyAction(key);
      setError(null);
      try {
        const response = acceptResponse(
          await runtime.requestSorbetProviderCenter(machineId, operation)
        );
        onChanged?.();
        return response;
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
        throw nextError;
      } finally {
        setBusyAction(null);
      }
    },
    [acceptResponse, machineId, onChanged, runtime]
  );

  const setApiKey = useCallback(
    async (providerId: string, apiKey: string) => {
      if (!runtime) throw new Error('Workspace runtime is unavailable.');
      setBusyAction(`api-key:${providerId}`);
      setError(null);
      try {
        acceptResponse(await runtime.setSorbetProviderApiKey(machineId, providerId, apiKey));
        setApiKeyDrafts((current) => ({ ...current, [providerId]: '' }));
        onChanged?.();
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
        throw nextError;
      } finally {
        setBusyAction(null);
      }
    },
    [acceptResponse, machineId, onChanged, runtime]
  );

  const providers = snapshot?.providers ?? [];
  const oauthProviders = providers.filter((provider) => provider.kind === 'oauth');
  const customProviders = providers.filter((provider) => provider.kind === 'custom');
  const readyProviderCount = providers.filter(
    (provider) => provider.connected && provider.enabled
  ).length;

  const openCustomEditor = (provider?: SorbetProviderConnection): void => {
    if (!provider?.custom) {
      setCustomDraft({ ...EMPTY_CUSTOM_DRAFT });
      return;
    }
    setCustomDraft({
      providerId: provider.id,
      original: provider.custom,
      name: provider.custom.name,
      protocol: provider.custom.protocol,
      baseUrl: provider.custom.baseUrl,
      models: modelLines(provider),
      apiKey: '',
    });
  };

  const saveCustomProvider = async (): Promise<void> => {
    if (!customDraft) return;
    const modelIds = parseModelIds(customDraft.models);
    if (!customDraft.name.trim() || !customDraft.baseUrl.trim() || modelIds.length === 0) {
      setError('Name, Base URL, and at least one model are required.');
      return;
    }
    const existingModels = new Map(
      (customDraft.original?.models ?? []).map((model) => [model.id, model])
    );
    const provider: SorbetCustomProviderInput = {
      ...(customDraft.original ?? {}),
      name: customDraft.name.trim(),
      protocol: customDraft.protocol,
      baseUrl: customDraft.baseUrl.trim(),
      models: modelIds.map((id) => ({ ...existingModels.get(id), id })),
    };
    try {
      const response = customDraft.providerId
        ? await run(`update:${customDraft.providerId}`, {
            action: 'update-custom',
            providerId: customDraft.providerId,
            provider,
          })
        : await run('create-custom', { action: 'create-custom', provider });
      const providerId = customDraft.providerId ?? response.affectedProviderId;
      if (!providerId) throw new Error('Sorbet did not return the new Provider id.');
      if (customDraft.apiKey.trim()) await setApiKey(providerId, customDraft.apiKey.trim());
      setCustomDraft(null);
    } catch {
      // The operation helpers already expose the error next to the form.
    }
  };

  if (!supported) {
    return (
      <div className="rounded-xl border border-status-warning/30 bg-status-warning/[0.08] p-4 text-xs text-status-warning">
        {t(
          'settings.agent.sorbet.machineUpgradeRequired',
          'Update or restart this Machine before configuring providers.'
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border border-border/70 bg-muted/10 p-4">
      {loading && !snapshot ? (
        <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
          <Spinner className="h-3.5 w-3.5" />
          {t('settings.agent.sorbet.providerCenter.loading', 'Loading connections…')}
        </div>
      ) : null}

      {oauthProviders.map((provider) => {
        const isClaude = provider.id === CLAUDE_PROVIDER_ID;
        return (
          <OAuthProviderCard
            key={provider.id}
            provider={provider}
            recommended={provider.id === CODEX_PROVIDER_ID}
            isDefault={snapshot?.defaultProviderId === provider.id}
            busy={busyAction !== null}
            onEnable={
              isClaude && !provider.enabled
                ? () =>
                    void run('enable-claude', {
                      action: 'set-claude-oauth-enabled',
                      enabled: true,
                    })
                : undefined
            }
            onDisable={
              isClaude && provider.enabled
                ? () =>
                    void run('disable-claude', {
                      action: 'set-claude-oauth-enabled',
                      enabled: false,
                    })
                : undefined
            }
            onMakeDefault={() =>
              void run(`default:${provider.id}`, {
                action: 'set-default',
                providerId: provider.id,
              })
            }
            onDisconnect={() =>
              void run(`logout:${provider.id}`, { action: 'logout', providerId: provider.id })
            }
          >
            <AcpAuthenticationPanel
              machineId={machineId}
              configId={configId}
              cliType="builtin"
              agentType="sorbet"
              providerName={provider.name}
              preferredMethodId={oauthMethodId(provider.id)}
              compact
              reauthentication={provider.connected}
              onBeforeStart={onBeforeAuthenticate}
              onAuthenticated={async () => {
                await refresh();
                onChanged?.();
              }}
            />
          </OAuthProviderCard>
        );
      })}

      <div className="space-y-2 border-t border-border/60 pt-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">
              {t('settings.agent.sorbet.custom.title', 'Custom Providers')}
            </p>
            <p className="text-xs text-muted-foreground">
              {t(
                'settings.agent.sorbet.custom.description',
                'Use an OpenAI-compatible or Anthropic-compatible endpoint. API keys stay on this Machine.'
              )}
            </p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={() => openCustomEditor()}>
            <Plus className="h-3.5 w-3.5" />
            {t('common.add', 'Add')}
          </Button>
        </div>

        {customProviders.map((provider) => {
          const apiKey = apiKeyDrafts[provider.id] ?? '';
          return (
            <div key={provider.id} className="rounded-lg border bg-background/70 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{provider.name}</span>
                    <ConnectionBadge connected={provider.connected} />
                    {snapshot?.defaultProviderId === provider.id ? <DefaultBadge /> : null}
                  </div>
                  <p className="mt-1 break-all text-xs text-muted-foreground">
                    {provider.custom?.baseUrl} · {provider.custom?.protocol} ·{' '}
                    {t('settings.agent.sorbet.modelCount', '{{count}} models', {
                      count: provider.models.length,
                    })}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {provider.connected && snapshot?.defaultProviderId !== provider.id ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busyAction !== null}
                      onClick={() =>
                        void run(`default:${provider.id}`, {
                          action: 'set-default',
                          providerId: provider.id,
                        })
                      }
                    >
                      {t('settings.agent.sorbet.makeDefault', 'Use for new sessions')}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="icon"
                    className="h-8 w-8"
                    variant="ghost"
                    onClick={() => openCustomEditor(provider)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    className="h-8 w-8"
                    variant="ghost"
                    onClick={() => setDeleteProvider(provider)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={apiKey}
                  placeholder={
                    provider.connected
                      ? t('settings.agent.sorbet.apiKey.replace', 'Replace API key')
                      : t('settings.agent.sorbet.apiKey.enter', 'Enter API key')
                  }
                  onChange={(event) =>
                    setApiKeyDrafts((current) => ({
                      ...current,
                      [provider.id]: event.target.value,
                    }))
                  }
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!apiKey.trim() || busyAction !== null}
                  onClick={() => void setApiKey(provider.id, apiKey.trim())}
                >
                  {busyAction === `api-key:${provider.id}` ? (
                    <Spinner className="h-3.5 w-3.5" />
                  ) : null}
                  {t('common.save', 'Save')}
                </Button>
                {provider.connected ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busyAction !== null}
                    onClick={() =>
                      void run(`logout:${provider.id}`, {
                        action: 'logout',
                        providerId: provider.id,
                      })
                    }
                  >
                    {t('settings.agent.sorbet.disconnect', 'Disconnect')}
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}

        {customProviders.length === 0 && !customDraft ? (
          <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
            {t('settings.agent.sorbet.custom.empty', 'No custom Provider is configured.')}
          </p>
        ) : null}

        {customDraft ? (
          <div className="space-y-3 rounded-lg border bg-background p-3">
            <p className="text-sm font-medium">
              {customDraft.providerId
                ? t('settings.agent.sorbet.custom.edit', 'Edit custom Provider')
                : t('settings.agent.sorbet.custom.add', 'Add custom Provider')}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">{t('common.name', 'Name')}</Label>
                <Input
                  value={customDraft.name}
                  onChange={(event) => setCustomDraft({ ...customDraft, name: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t('settings.agent.sorbet.protocol', 'Protocol')}</Label>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={customDraft.protocol}
                  onChange={(event) =>
                    setCustomDraft({
                      ...customDraft,
                      protocol: event.target.value as SorbetCustomProviderProtocol,
                    })
                  }
                >
                  <option value="openai-responses">OpenAI Responses</option>
                  <option value="openai-completions">OpenAI Chat Completions</option>
                  <option value="anthropic-messages">Anthropic Messages</option>
                </select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Base URL</Label>
              <Input
                type="url"
                value={customDraft.baseUrl}
                placeholder="https://api.example.com/v1"
                onChange={(event) =>
                  setCustomDraft({ ...customDraft, baseUrl: event.target.value })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('settings.agent.sorbet.models', 'Model IDs')}</Label>
              <textarea
                className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={customDraft.models}
                placeholder="model-id-one\nmodel-id-two"
                onChange={(event) => setCustomDraft({ ...customDraft, models: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                {t('settings.agent.sorbet.modelsHint', 'Enter one model id per line.')}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">
                {customDraft.providerId
                  ? t(
                      'settings.agent.sorbet.apiKey.optionalReplace',
                      'API key (leave empty to keep current)'
                    )
                  : t('settings.agent.sorbet.apiKey.label', 'API key')}
              </Label>
              <Input
                type="password"
                autoComplete="new-password"
                value={customDraft.apiKey}
                onChange={(event) => setCustomDraft({ ...customDraft, apiKey: event.target.value })}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busyAction !== null}
                onClick={() => setCustomDraft(null)}
              >
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busyAction !== null}
                onClick={() => void saveCustomProvider()}
              >
                {busyAction?.startsWith('create') || busyAction?.startsWith('update') ? (
                  <Spinner className="h-3.5 w-3.5" />
                ) : null}
                {t('common.save', 'Save')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {readyProviderCount === 0 && snapshot ? (
        <p className="text-xs text-status-warning">
          {t(
            'settings.agent.sorbet.providerRequired',
            'Connect a subscription or configure a custom Provider before creating Sorbet.'
          )}
        </p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <AlertDialog
        open={deleteProvider !== null}
        onOpenChange={(open) => !open && setDeleteProvider(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('settings.agent.sorbet.custom.deleteTitle', 'Delete custom Provider?')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'settings.agent.sorbet.custom.deleteDescription',
                'Sorbet blocks deletion when a saved session or approval reviewer still references this Provider.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const provider = deleteProvider;
                setDeleteProvider(null);
                if (provider)
                  void run(`delete:${provider.id}`, {
                    action: 'delete-custom',
                    providerId: provider.id,
                  });
              }}
            >
              {t('common.delete', 'Delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function OAuthProviderCard({
  provider,
  recommended = false,
  isDefault,
  busy,
  onEnable,
  onDisable,
  onMakeDefault,
  onDisconnect,
  children,
}: {
  provider: SorbetProviderConnection;
  recommended?: boolean;
  isDefault: boolean;
  busy: boolean;
  onEnable?: () => void;
  onDisable?: () => void;
  onMakeDefault: () => void;
  onDisconnect: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border bg-background/70 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{provider.name}</span>
            {recommended ? (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                {t('common.recommended', 'Recommended')}
              </span>
            ) : null}
            <ConnectionBadge connected={provider.connected} />
            {isDefault ? <DefaultBadge /> : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(
              'settings.agent.sorbet.oauthDescription',
              'Uses OAuth credentials stored by Sorbet on this Machine.'
            )}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {provider.connected && provider.enabled && !isDefault ? (
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onMakeDefault}>
              {t('settings.agent.sorbet.makeDefault', 'Use for new sessions')}
            </Button>
          ) : null}
          {provider.connected ? (
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onDisconnect}>
              {t('settings.agent.sorbet.disconnect', 'Disconnect')}
            </Button>
          ) : null}
          {onDisable ? (
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onDisable}>
              {t('settings.agent.sorbet.claude.disable', 'Disable Claude OAuth')}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="mt-3">
        {onEnable ? (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onEnable}>
            {t('settings.agent.sorbet.claude.enable', 'Enable Claude OAuth')}
          </Button>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

function ConnectionBadge({ connected }: { connected: boolean }) {
  const { t } = useTranslation();
  return connected ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-status-success/10 px-2 py-0.5 text-[11px] font-medium text-status-success">
      <Check className="h-3 w-3" />
      {t('settings.agent.sorbet.connected', 'Connected')}
    </span>
  ) : (
    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
      {t('settings.agent.sorbet.notConnected', 'Not connected')}
    </span>
  );
}

function DefaultBadge() {
  const { t } = useTranslation();
  return (
    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
      {t('settings.agent.sorbet.defaultForNewSessions', 'New sessions')}
    </span>
  );
}
