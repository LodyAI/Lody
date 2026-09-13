import { Loader2, Plus, RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  BUILTIN_MCP_PROVIDERS,
  type BuiltinMcpProviderDefinition,
  type BuiltinMcpProviderId,
  type WorkspaceMcpAuthState,
} from '@lody/shared';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';

export function BuiltinMcpConnectorGrid({
  addedProviderIds,
  connectionStates,
  pendingProviderId,
  onConnect,
  onDisconnect,
  onTest,
}: {
  addedProviderIds: ReadonlySet<BuiltinMcpProviderId>;
  connectionStates?: Partial<Record<BuiltinMcpProviderId, WorkspaceMcpAuthState>>;
  pendingProviderId?: BuiltinMcpProviderId;
  onConnect: (providerId: BuiltinMcpProviderId) => void;
  onDisconnect?: (providerId: BuiltinMcpProviderId) => void;
  onTest?: (providerId: BuiltinMcpProviderId) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-xs font-semibold text-muted-foreground">
          {t('settings.mcp.builtin.title')}
        </h3>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground/80">
          {t('settings.mcp.builtin.description')}
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {BUILTIN_MCP_PROVIDERS.map((provider) => (
          <BuiltinMcpConnectorCard
            key={provider.id}
            provider={provider}
            added={addedProviderIds.has(provider.id)}
            state={connectionStates?.[provider.id]}
            pending={pendingProviderId === provider.id}
            onConnect={() => onConnect(provider.id)}
            onDisconnect={onDisconnect ? () => onDisconnect(provider.id) : undefined}
            onTest={onTest ? () => onTest(provider.id) : undefined}
          />
        ))}
      </div>
    </section>
  );
}

export function BuiltinMcpConnectorCard({
  provider,
  added,
  state,
  pending,
  onConnect,
  onDisconnect,
  onTest,
}: {
  provider: BuiltinMcpProviderDefinition;
  added: boolean;
  state?: WorkspaceMcpAuthState;
  pending: boolean;
  onConnect: () => void;
  onDisconnect?: () => void;
  onTest?: () => void;
}) {
  const { t } = useTranslation();
  const providerName = t(`settings.mcp.builtin.providers.${provider.id}.name`);
  const authLabel =
    provider.authKind === 'mcp_oauth'
      ? t('settings.mcp.builtin.oauth')
      : t('settings.mcp.builtin.guided');
  const connected = state === 'connected';
  const authorizing = state === 'authorizing';
  const needsReconnect = state === 'expired' || state === 'error';
  return (
    <article className="flex min-w-0 flex-col rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background text-xs font-semibold text-foreground"
          aria-hidden="true"
        >
          {providerName.slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h4 className="truncate text-sm font-medium">{providerName}</h4>
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
              {authLabel}
            </Badge>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
            {t(`settings.mcp.builtin.providers.${provider.id}.description`)}
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted-foreground/80">
          {connected
            ? t('settings.mcp.builtin.connected')
            : authorizing
              ? t('settings.mcp.builtin.authorizing')
              : t(
                  provider.defaultAccessProfile === 'readonly'
                    ? 'settings.mcp.builtin.readonly'
                    : 'settings.mcp.builtin.providerPermissions'
                )}
        </span>
        <div className="flex items-center gap-1">
          {connected && onDisconnect ? (
            <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onDisconnect}>
              {t('settings.mcp.builtin.disconnect')}
            </Button>
          ) : null}
          {connected && onTest ? (
            <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onTest}>
              {t('settings.mcp.builtin.test')}
            </Button>
          ) : null}
          {!connected ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending || authorizing}
              onClick={onConnect}
            >
              {pending || authorizing ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : needsReconnect ? (
                <RotateCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              )}
              {t(
                authorizing
                  ? 'settings.mcp.builtin.authorizing'
                  : needsReconnect
                    ? 'settings.mcp.builtin.reconnect'
                    : added
                      ? 'settings.mcp.builtin.connect'
                      : 'settings.mcp.builtin.addAndConnect'
              )}
            </Button>
          ) : null}
        </div>
      </div>
    </article>
  );
}
