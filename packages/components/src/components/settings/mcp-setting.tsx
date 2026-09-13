import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { usePostHog } from '@posthog/react';
import { Loader2, Plug, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  areWorkspaceMcpNamesEqual,
  describeMcpConnection,
  getBuiltinMcpProvider,
  getServerNow,
  type BuiltinMcpProviderId,
  type McpServerId,
  type WorkspaceMcpAuthState,
  type WorkspaceMcpServerMeta,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom, settingsSelectedMachineIdAtom, userAtom } from '@/atoms';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  useWorkspaceMcpCatalog,
  useWorkspaceMcpCatalogActions,
} from '@/hooks/use-workspace-mcp-catalog';
import { cn } from '@/lib/utils';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { MCP_TRANSPORT_LABELS, McpTransportIcon } from '@/components/shared/mcp-transport';
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
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/ui/dialog';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { settingContainerClass } from '.';
import { McpConnectionForm, type McpConnectionFormValue } from './mcp-connection-form';
import { BuiltinMcpConnectorGrid } from './builtin-mcp-connector-grid';
import { createBuiltinMcpEntry, findBuiltinMcpEntry } from '@/lib/builtin-mcp-connectors';
import { openExternalUrl } from '@/lib/native-browser';

type EditorState = { mode: 'add' } | { mode: 'edit'; entry: WorkspaceMcpServerMeta };

export function McpSetting() {
  const { t } = useTranslation();
  const postHog = usePostHog();
  const isMobile = useIsMobile();
  const user = useAtomValue(userAtom);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const requestWorkspaceMcpConnection = runtime?.requestWorkspaceMcpConnection;
  const selectedMachineId = useAtomValue(settingsSelectedMachineIdAtom);
  const { servers, synced } = useWorkspaceMcpCatalog();
  const { upsert, remove } = useWorkspaceMcpCatalogActions();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [builtinError, setBuiltinError] = useState<string>();
  const [pendingRemoval, setPendingRemoval] = useState<WorkspaceMcpServerMeta | null>(null);
  const [removing, setRemoving] = useState(false);
  const [pendingBuiltinProviderId, setPendingBuiltinProviderId] = useState<BuiltinMcpProviderId>();
  const [builtinConnectionStates, setBuiltinConnectionStates] = useState<
    Partial<Record<BuiltinMcpProviderId, WorkspaceMcpAuthState>>
  >({});
  const [secretUrlEntry, setSecretUrlEntry] = useState<WorkspaceMcpServerMeta | null>(null);
  const [secretUrl, setSecretUrl] = useState('');

  const openEditor = (next: EditorState) => {
    setError(undefined);
    setEditor(next);
  };

  const save = async (value: McpConnectionFormValue) => {
    const duplicate = servers.find(
      (server) =>
        areWorkspaceMcpNamesEqual(server.name, value.name) &&
        (editor?.mode !== 'edit' || server.id !== editor.entry.id)
    );
    if (duplicate) {
      setError(t('settings.mcp.errors.duplicateName'));
      return;
    }

    setSubmitting(true);
    setError(undefined);
    const now = getServerNow();
    const existing = editor?.mode === 'edit' ? editor.entry : undefined;
    const entry: WorkspaceMcpServerMeta = {
      id: existing?.id ?? (crypto.randomUUID() as McpServerId),
      name: value.name,
      transport: value.transport,
      ...(value.description ? { description: value.description } : {}),
      ...(value.connection ? { connection: value.connection } : {}),
      enabledByDefault: value.enabledByDefault,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.createdBy || user?.id ? { createdBy: existing?.createdBy ?? user?.id } : {}),
    };
    try {
      // Resolves on durability: the row exists, so the editor is done. The
      // upload runs on its own and is deliberately not reported.
      await upsert(entry);
      if (editor?.mode === 'add') {
        capturePostHogEvent(postHog, 'workspace/mcp_created', {
          source: 'settings',
          transport: entry.transport,
          enabled_by_default: entry.enabledByDefault,
          has_description: Boolean(entry.description),
        });
      }
      setEditor(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const toggleDefault = async (entry: WorkspaceMcpServerMeta, enabledByDefault: boolean) => {
    try {
      await upsert({ ...entry, enabledByDefault, updatedAt: getServerNow() });
    } catch (cause) {
      console.error('Failed to update MCP server default', cause);
    }
  };

  const confirmRemoval = async () => {
    if (!pendingRemoval) return;
    setRemoving(true);
    try {
      if (
        pendingRemoval.source?.kind === 'builtin' &&
        requestWorkspaceMcpConnection &&
        selectedMachineId &&
        user?.id
      ) {
        const disconnectResult = await requestWorkspaceMcpConnection(selectedMachineId, {
          action: 'disconnect',
          mcpServerId: pendingRemoval.id,
          requestedByUserId: user.id,
        });
        if (disconnectResult.type === 'workspace-mcp/connection-error') {
          setBuiltinError(disconnectResult.message);
        }
      }
      await remove(pendingRemoval.id);
    } catch (cause) {
      console.error('Failed to remove MCP server', cause);
    } finally {
      setRemoving(false);
      setPendingRemoval(null);
    }
  };

  const addLabel = t('settings.mcp.add');
  const addedBuiltinProviderIds = new Set(
    servers.flatMap((server) =>
      server.source?.kind === 'builtin' ? [server.source.providerId] : []
    )
  );

  useEffect(() => {
    if (!requestWorkspaceMcpConnection || !selectedMachineId || !user?.id) {
      setBuiltinConnectionStates({});
      return undefined;
    }
    let cancelled = false;
    let timeout: number | undefined;
    const refresh = async () => {
      const entries = servers.filter(
        (server): server is WorkspaceMcpServerMeta & { source: { kind: 'builtin' } } =>
          server.source?.kind === 'builtin'
      );
      const results = await Promise.all(
        entries.map(async (entry) => ({
          providerId: entry.source.providerId,
          result: await requestWorkspaceMcpConnection(selectedMachineId, {
            action: 'status',
            mcpServerId: entry.id,
            requestedByUserId: user.id,
          }),
        }))
      );
      if (cancelled) return;
      const nextStates = Object.fromEntries(
        results.flatMap(({ providerId, result }) =>
          result.type === 'workspace-mcp/connection-status'
            ? [[providerId, result.state] as const]
            : []
        )
      );
      setBuiltinConnectionStates(nextStates);
      timeout = window.setTimeout(
        () => void refresh(),
        Object.values(nextStates).includes('authorizing') ? 1_000 : 10_000
      );
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [
    pendingBuiltinProviderId,
    requestWorkspaceMcpConnection,
    selectedMachineId,
    servers,
    user?.id,
  ]);

  const connectBuiltin = async (providerId: BuiltinMcpProviderId) => {
    if (pendingBuiltinProviderId) return;
    setPendingBuiltinProviderId(providerId);
    setBuiltinError(undefined);
    try {
      let entry = findBuiltinMcpEntry(servers, providerId);
      if (!entry) {
        entry = createBuiltinMcpEntry({
          providerId,
          displayName: t(`settings.mcp.builtin.providers.${providerId}.name`),
          id: crypto.randomUUID() as McpServerId,
          now: getServerNow(),
          servers,
          description: t(`settings.mcp.builtin.providers.${providerId}.description`),
          createdBy: user?.id,
        });
        await upsert(entry);
      }
      const provider = getBuiltinMcpProvider(providerId);
      if (provider.authKind === 'provider_secret_url') {
        if (provider.setupUrl) void openExternalUrl(provider.setupUrl);
        setSecretUrlEntry(entry);
        setSecretUrl('');
        return;
      }
      if (!requestWorkspaceMcpConnection || !selectedMachineId || !user?.id) {
        setBuiltinError(t('settings.mcp.builtin.errors.localMachineRequired'));
        return;
      }
      const authResult = await requestWorkspaceMcpConnection(selectedMachineId, {
        action: 'start-oauth',
        mcpServerId: entry.id,
        requestedByUserId: user.id,
      });
      if (authResult.type === 'workspace-mcp/oauth-started') {
        setBuiltinConnectionStates((current) => ({ ...current, [providerId]: 'authorizing' }));
        const opened = await openExternalUrl(authResult.authorizationUrl);
        if (!opened) setBuiltinError(t('settings.mcp.builtin.errors.browserOpenFailed'));
      } else if (authResult.type === 'workspace-mcp/connection-error') {
        setBuiltinError(authResult.message);
      }
    } catch (cause) {
      setBuiltinError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPendingBuiltinProviderId(undefined);
    }
  };

  const disconnectBuiltin = async (providerId: BuiltinMcpProviderId) => {
    const entry = findBuiltinMcpEntry(servers, providerId);
    if (
      !entry ||
      !requestWorkspaceMcpConnection ||
      !selectedMachineId ||
      !user?.id ||
      pendingBuiltinProviderId
    )
      return;
    setPendingBuiltinProviderId(providerId);
    setBuiltinError(undefined);
    try {
      const result = await requestWorkspaceMcpConnection(selectedMachineId, {
        action: 'disconnect',
        mcpServerId: entry.id,
        requestedByUserId: user.id,
      });
      if (result.type === 'workspace-mcp/connection-status') {
        setBuiltinConnectionStates((current) => ({ ...current, [providerId]: result.state }));
      } else if (result.type === 'workspace-mcp/connection-error') {
        setBuiltinError(result.message);
      }
    } catch (cause) {
      setBuiltinError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPendingBuiltinProviderId(undefined);
    }
  };

  const saveSecretUrl = async () => {
    if (!secretUrlEntry || !requestWorkspaceMcpConnection || !selectedMachineId || !user?.id) {
      setBuiltinError(t('settings.mcp.builtin.errors.localMachineRequired'));
      return;
    }
    setPendingBuiltinProviderId('feishu');
    setBuiltinError(undefined);
    try {
      const result = await requestWorkspaceMcpConnection(selectedMachineId, {
        action: 'set-secret-url',
        mcpServerId: secretUrlEntry.id,
        requestedByUserId: user.id,
        secretUrl,
      });
      if (result.type === 'workspace-mcp/connection-status') {
        setBuiltinConnectionStates((current) => ({ ...current, feishu: result.state }));
        setSecretUrlEntry(null);
        setSecretUrl('');
      } else if (result.type === 'workspace-mcp/connection-error') {
        setBuiltinError(result.message);
      }
    } catch (cause) {
      setBuiltinError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPendingBuiltinProviderId(undefined);
    }
  };

  const testBuiltin = async (providerId: BuiltinMcpProviderId) => {
    const entry = findBuiltinMcpEntry(servers, providerId);
    if (
      !entry ||
      !requestWorkspaceMcpConnection ||
      !selectedMachineId ||
      !user?.id ||
      pendingBuiltinProviderId
    )
      return;
    setPendingBuiltinProviderId(providerId);
    setBuiltinError(undefined);
    try {
      const result = await requestWorkspaceMcpConnection(
        selectedMachineId,
        {
          action: 'test',
          mcpServerId: entry.id,
          requestedByUserId: user.id,
        },
        { timeoutMs: 45_000 }
      );
      if (result.type === 'workspace-mcp/connection-error') {
        setBuiltinError(result.message);
      } else if (result.type === 'workspace-mcp/connection-status') {
        setBuiltinConnectionStates((current) => ({ ...current, [providerId]: result.state }));
      }
    } catch (cause) {
      setBuiltinError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPendingBuiltinProviderId(undefined);
    }
  };

  return (
    <div className={settingContainerClass}>
      <p className="text-xs leading-snug text-muted-foreground">{t('settings.mcp.description')}</p>

      {builtinError ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-xs leading-snug text-foreground/90"
        >
          <TriangleAlert
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-warning"
            aria-hidden="true"
          />
          {builtinError}
        </p>
      ) : null}

      <BuiltinMcpConnectorGrid
        addedProviderIds={addedBuiltinProviderIds}
        connectionStates={builtinConnectionStates}
        pendingProviderId={pendingBuiltinProviderId}
        onConnect={(providerId) => void connectBuiltin(providerId)}
        onDisconnect={(providerId) => void disconnectBuiltin(providerId)}
        onTest={(providerId) => void testBuiltin(providerId)}
      />

      <Dialog
        open={secretUrlEntry !== null}
        onOpenChange={(open) => {
          if (!open) setSecretUrlEntry(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogTitle>{t('settings.mcp.builtin.feishuDialog.title')}</DialogTitle>
          <DialogDescription>
            {t('settings.mcp.builtin.feishuDialog.description')}
          </DialogDescription>
          <div className="space-y-2">
            <Label htmlFor="feishu-mcp-secret-url">
              {t('settings.mcp.builtin.feishuDialog.urlLabel')}
            </Label>
            <Input
              id="feishu-mcp-secret-url"
              type="password"
              autoComplete="off"
              value={secretUrl}
              onChange={(event) => setSecretUrl(event.target.value)}
              placeholder="https://…"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setSecretUrlEntry(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={!secretUrl.trim() || pendingBuiltinProviderId === 'feishu'}
              onClick={() => void saveSecretUrl()}
            >
              {pendingBuiltinProviderId === 'feishu' ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : null}
              {t('settings.mcp.builtin.feishuDialog.save')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <section className="flex flex-col">
        <div className="flex items-center justify-between gap-2 pb-1 pt-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="text-xs font-semibold text-muted-foreground">
              {t('settings.mcp.catalogTitle')}
            </h3>
            {servers.length > 0 ? (
              <span className="text-xs tabular-nums text-muted-foreground/70">
                {servers.length}
              </span>
            ) : null}
            {!synced ? (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground/70">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                {t('settings.mcp.syncing')}
              </span>
            ) : null}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                aria-label={addLabel}
                onClick={() => openEditor({ mode: 'add' })}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{addLabel}</TooltipContent>
          </Tooltip>
        </div>

        {servers.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/60 bg-card/30 px-6 py-8 text-center text-sm">
            <Plug className="h-6 w-6 text-muted-foreground/70" aria-hidden="true" />
            <p className="mt-2 text-muted-foreground">{t('settings.mcp.empty')}</p>
            <Button size="sm" className="mt-3" onClick={() => openEditor({ mode: 'add' })}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {addLabel}
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {servers.map((server) => (
              <McpServerRow
                key={server.id}
                server={server}
                onEdit={
                  server.source?.kind === 'builtin'
                    ? undefined
                    : () => openEditor({ mode: 'edit', entry: server })
                }
                onToggleDefault={(enabled) => void toggleDefault(server, enabled)}
                onRemove={() => setPendingRemoval(server)}
              />
            ))}
          </div>
        )}
      </section>

      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (open) return;
          setError(undefined);
          setEditor(null);
        }}
      >
        <DialogContent
          overlayClassName={
            // Desktop settings is itself a dialog; match its z-index so this
            // later overlay covers it without stacking a second /80 veil.
            isMobile ? undefined : 'z-[var(--z-dialog)] bg-black/20'
          }
          className={cn(
            'flex max-h-[min(680px,88dvh)] w-[min(620px,96dvw)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none sm:p-0',
            !isMobile && 'shadow-popover'
          )}
        >
          <header className="shrink-0 border-b border-border/60 px-5 py-3 pr-12">
            <DialogTitle className="text-sm font-semibold">
              {editor?.mode === 'edit' ? t('settings.mcp.editTitle') : t('settings.mcp.addTitle')}
            </DialogTitle>
            <DialogDescription className="mt-0.5 text-xs leading-snug text-muted-foreground">
              {t('settings.mcp.dialogDescription')}
            </DialogDescription>
          </header>
          {editor ? (
            <McpConnectionForm
              key={editor.mode === 'edit' ? editor.entry.id : 'new'}
              className="min-h-0 flex-1"
              initialEntry={editor.mode === 'edit' ? editor.entry : undefined}
              submitting={submitting}
              error={error}
              onSubmit={save}
              onCancel={() => {
                setError(undefined);
                setEditor(null);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open && !removing) setPendingRemoval(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.mcp.removeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.mcp.confirmRemove', { name: pendingRemoval?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={removing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                void confirmRemoval();
              }}
            >
              {removing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {t('common.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** One catalog entry. The row body opens the editor (same affordance as an
 *  agent provider row); the trailing cluster keeps the two quick actions. */
export function McpServerRow({
  server,
  onEdit,
  onToggleDefault,
  onRemove,
}: {
  server: WorkspaceMcpServerMeta;
  onEdit?: () => void;
  onToggleDefault: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const defaultLabel = t('settings.mcp.defaultToggle', { name: server.name });
  return (
    <div className="overflow-hidden rounded-lg bg-foreground/[0.04]">
      <div className="flex w-full min-w-0 items-center transition-colors hover:bg-hover/40">
        <button
          type="button"
          onClick={onEdit}
          disabled={!onEdit}
          aria-label={onEdit ? t('common.edit') : undefined}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3 py-2 text-left focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-foreground/[0.05] text-muted-foreground">
            <McpTransportIcon transport={server.transport} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="min-w-0 truncate text-sm font-medium leading-tight">
                {server.name}
              </span>
              <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
                {MCP_TRANSPORT_LABELS[server.transport]}
              </Badge>
              {server.source?.kind === 'builtin' ? (
                <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
                  {t('settings.mcp.builtin.badge')}
                </Badge>
              ) : null}
            </span>
            <span className="mt-0.5 block truncate font-mono text-[11px] leading-tight text-muted-foreground">
              {describeMcpConnection(server.connection) ??
                (server.source?.kind === 'builtin'
                  ? (getBuiltinMcpProvider(server.source.providerId).endpoint ??
                    t('settings.mcp.builtin.guided'))
                  : '—')}
            </span>
            {server.description ? (
              <span className="mt-0.5 block truncate text-[11px] leading-tight text-muted-foreground/80">
                {server.description}
              </span>
            ) : null}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2 py-2 pl-2 pr-2">
          {/* The switch keeps its own Radix `data-state`, so the label sits
              beside it rather than wrapping it in a tooltip trigger. */}
          <label
            className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground"
            title={t('settings.mcp.form.defaultEnabledHint')}
          >
            <span className="hidden sm:inline">{t('settings.mcp.default')}</span>
            <Switch
              checked={server.enabledByDefault === true}
              aria-label={defaultLabel}
              onCheckedChange={onToggleDefault}
            />
          </label>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            aria-label={t('common.remove')}
            onClick={onRemove}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
