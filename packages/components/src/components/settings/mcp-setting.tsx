import { useState } from 'react';
import { useAtomValue } from 'jotai';
import { usePostHog } from '@posthog/react';
import { Loader2, Plug, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  describeMcpConnection,
  getServerNow,
  type McpServerId,
  type WorkspaceMcpServerMeta,
} from '@lody/shared';
import { userAtom } from '@/atoms';
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
import { Switch } from '@/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { SettingsEmptyState, SettingsPage } from './settings-page';
import { McpConnectionForm, type McpConnectionFormValue } from './mcp-connection-form';

type EditorState = { mode: 'add' } | { mode: 'edit'; entry: WorkspaceMcpServerMeta };

export function McpSetting() {
  const { t } = useTranslation();
  const postHog = usePostHog();
  const isMobile = useIsMobile();
  const user = useAtomValue(userAtom);
  const { servers, synced } = useWorkspaceMcpCatalog();
  const { upsert, remove } = useWorkspaceMcpCatalogActions();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [pendingRemoval, setPendingRemoval] = useState<WorkspaceMcpServerMeta | null>(null);
  const [removing, setRemoving] = useState(false);

  const openEditor = (next: EditorState) => {
    setError(undefined);
    setEditor(next);
  };

  const save = async (value: McpConnectionFormValue) => {
    const duplicate = servers.find(
      (server) =>
        server.name.localeCompare(value.name, undefined, { sensitivity: 'accent' }) === 0 &&
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
      await remove(pendingRemoval.id);
    } catch (cause) {
      console.error('Failed to remove MCP server', cause);
    } finally {
      setRemoving(false);
      setPendingRemoval(null);
    }
  };

  const addLabel = t('settings.mcp.add');
  return (
    <SettingsPage title={t('settings.tabs.mcp')} description={t('settings.mcp.description')}>
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
          <SettingsEmptyState
            icon={<Plug aria-hidden="true" />}
            message={t('settings.mcp.empty')}
            action={
              <Button size="sm" onClick={() => openEditor({ mode: 'add' })}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                {addLabel}
              </Button>
            }
          />
        ) : (
          <div className="space-y-2">
            {servers.map((server) => (
              <McpServerRow
                key={server.id}
                server={server}
                onEdit={() => openEditor({ mode: 'edit', entry: server })}
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
    </SettingsPage>
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
  onEdit: () => void;
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
          aria-label={t('common.edit')}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3 py-2 text-left focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
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
            </span>
            <span className="mt-0.5 block truncate font-mono text-[11px] leading-tight text-muted-foreground">
              {describeMcpConnection(server.connection) ?? '—'}
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
