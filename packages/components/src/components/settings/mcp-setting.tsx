import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { useEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { SettingsPageActions, SettingsPageLead, useSettingsPane } from './settings-page-header';
import { SettingsEmptyList, settingsRecordsCard } from './compact-layout';
import { useAtomValue } from 'jotai';
import { usePostHog } from '@posthog/react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';
import {
  describeMcpConnection,
  getServerNow,
  type McpServerId,
  type McpToolListResult,
  type WorkspaceMcpServerMeta,
} from '@lody/shared';
import { userAtom } from '@/atoms';
import { useDialogExitSnapshot } from '@/hooks/use-dialog-exit-snapshot';
import {
  useWorkspaceMcpCatalog,
  useWorkspaceMcpCatalogActions,
} from '@/hooks/use-workspace-mcp-catalog';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { MCP_TRANSPORT_LABELS, McpTransportIcon } from '@/components/shared/mcp-transport';
import { AlertDialog } from '@/ui/dialog';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Dialog } from '@/ui/dialog';
import { Switch } from '@lody/ui/switch';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { McpConnectionForm, type McpConnectionFormValue } from './mcp-connection-form';
import {
  SETTINGS_EDITOR_DIALOG_LAYOUT,
  SETTINGS_EDITOR_DIALOG_WIDTH,
  settingsCatalog as catalog,
  settingsSurface as surface,
} from './surface';
import { settingsType as type } from './type.stylex';

const styles = stylex.create({
  actions: { gap: space[2] },
  tools: {
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
    paddingInline: space[3],
    paddingBlock: space[2],
    fontSize: type.caption,
    color: colors.secondaryLabel,
  },
  toolList: { display: 'flex', minWidth: 0, flexWrap: 'wrap', gap: space[1.5] },
  toolName: { overflowWrap: 'anywhere', whiteSpace: 'normal' },
  error: { color: colors.destructive },
  default: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    fontSize: type.caption,
    color: colors.secondaryLabel,
    cursor: 'pointer',
  },
  /** The word beside the switch is dropped on a narrow panel; the switch keeps its label. */
  defaultText: { display: { default: 'none', '@media (min-width: 640px)': 'inline' } },
});

type EditorState = { mode: 'add' } | { mode: 'edit'; entry: WorkspaceMcpServerMeta };

export function McpSetting() {
  const { t } = useTranslation();
  const postHog = usePostHog();
  const user = useAtomValue(userAtom);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const localMachineId = useAtomValue(localMachineIdAtom);
  const { servers, synced } = useWorkspaceMcpCatalog();
  const { upsert, remove } = useWorkspaceMcpCatalogActions();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const { shown: shownEditor, onOpenChangeComplete } = useDialogExitSnapshot(editor);
  const settingsPane = useSettingsPane();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [pendingRemoval, setPendingRemoval] = useState<WorkspaceMcpServerMeta | null>(null);
  const [removing, setRemoving] = useState(false);

  const [toolLists, setToolLists] = useState<
    Record<string, { connection: WorkspaceMcpServerMeta['connection']; state: McpToolListState }>
  >({});
  const scope = useRef(0);
  useEffect(() => {
    setToolLists({});
    return () => {
      scope.current += 1;
    };
  }, [runtime, localMachineId]);

  const discoverTools = async (entry: WorkspaceMcpServerMeta) => {
    if (!runtime || !localMachineId || !entry.connection) return;
    const requestScope = scope.current;
    const pending = { connection: entry.connection, state: { status: 'loading' } as const };
    setToolLists((current) => ({ ...current, [entry.id]: pending }));
    try {
      const { tools } = await runtime.requestLocalMcpTools(localMachineId, entry);
      if (requestScope === scope.current)
        setToolLists((current) =>
          current[entry.id] === pending
            ? { ...current, [entry.id]: { ...pending, state: { status: 'success', tools } } }
            : current
        );
    } catch {
      if (requestScope === scope.current)
        setToolLists((current) =>
          current[entry.id] === pending
            ? { ...current, [entry.id]: { ...pending, state: { status: 'error' } } }
            : current
        );
    }
  };

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
      if (entry.connection) void discoverTools(entry);
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
    <div {...stylex.props(surface.container)}>
      <SettingsPageLead>{t('settings.mcp.description')}</SettingsPageLead>

      <SettingsPageActions>
        {!synced ? (
          <span {...stylex.props(catalog.syncing)}>
            <Spinner size="small" aria-hidden="true" />
            {t('settings.mcp.syncing')}
          </span>
        ) : null}
        <Button size="small" variant="secondary" onClick={() => openEditor({ mode: 'add' })}>
          <Plus {...stylex.props(catalog.icon)} />
          {addLabel}
        </Button>
      </SettingsPageActions>

      {servers.length === 0 ? (
        <SettingsEmptyList>{t('settings.mcp.empty')}</SettingsEmptyList>
      ) : (
        <div {...stylex.props(settingsRecordsCard)}>
          {servers.map((server, index) => (
            <div key={server.id} {...stylex.props(surface.line, index > 0 && surface.lineRuled)}>
              <McpServerRow
                toolList={
                  JSON.stringify(toolLists[server.id]?.connection) ===
                  JSON.stringify(server.connection)
                    ? toolLists[server.id]?.state
                    : undefined
                }
                server={server}
                onDiscoverTools={() => void discoverTools(server)}
                canDiscoverTools={Boolean(runtime && localMachineId && server.connection)}
                onEdit={() => openEditor({ mode: 'edit', entry: server })}
                onToggleDefault={(enabled) => void toggleDefault(server, enabled)}
                onRemove={() => setPendingRemoval(server)}
              />
            </div>
          ))}
        </div>
      )}

      <Dialog.Root
        open={editor !== null}
        onOpenChange={(open) => {
          if (open) return;
          setError(undefined);
          setEditor(null);
        }}
        onOpenChangeComplete={onOpenChangeComplete}
      >
        <Dialog.Content
          width={SETTINGS_EDITOR_DIALOG_WIDTH}
          centerOn={settingsPane}
          className={SETTINGS_EDITOR_DIALOG_LAYOUT}
        >
          <Dialog.Header>
            <Dialog.Title>
              {shownEditor?.mode === 'edit'
                ? t('settings.mcp.editTitle')
                : t('settings.mcp.addTitle')}
            </Dialog.Title>
            <Dialog.Description>{t('settings.mcp.dialogDescription')}</Dialog.Description>
          </Dialog.Header>
          {shownEditor ? (
            <McpConnectionForm
              key={shownEditor.mode === 'edit' ? shownEditor.entry.id : 'new'}
              initialEntry={shownEditor.mode === 'edit' ? shownEditor.entry : undefined}
              submitting={submitting}
              error={error}
              onSubmit={save}
              onCancel={() => {
                setError(undefined);
                setEditor(null);
              }}
            />
          ) : null}
        </Dialog.Content>
      </Dialog.Root>

      <AlertDialog.Root
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open && !removing) setPendingRemoval(null);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{t('settings.mcp.removeTitle')}</AlertDialog.Title>
            <AlertDialog.Description>
              {t('settings.mcp.confirmRemove', { name: pendingRemoval?.name ?? '' })}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={removing}>{t('common.cancel')}</AlertDialog.Cancel>
            <Button
              disabled={removing}
              variant="destructive"
              onClick={() => {
                void confirmRemoval();
              }}
            >
              {removing ? <Spinner size="small" /> : null}
              {t('common.remove')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </div>
  );
}

/** One catalog entry, as a line of the catalog's card. The row body opens the
 *  editor (same affordance as an agent provider row); the trailing cluster keeps
 *  the two quick actions. */
export function McpServerRow({
  server,
  onEdit,
  onToggleDefault,
  onRemove,
  onDiscoverTools,
  canDiscoverTools,
  toolList,
}: {
  toolList?: McpToolListState;
  onDiscoverTools: () => void;
  canDiscoverTools: boolean;
  server: WorkspaceMcpServerMeta;
  onEdit: () => void;
  onToggleDefault: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const defaultLabel = t('settings.mcp.defaultToggle', { name: server.name });
  return (
    <div>
      <div {...stylex.props(catalog.row, surface.pressableLine)}>
        <button
          type="button"
          onClick={onEdit}
          aria-label={t('common.edit')}
          {...stylex.props(catalog.rowMain)}
        >
          <span {...stylex.props(catalog.glyph)}>
            <McpTransportIcon transport={server.transport} />
          </span>
          <span {...stylex.props(catalog.body)}>
            <span {...stylex.props(catalog.titleLine)}>
              <span {...stylex.props(catalog.name)}>{server.name}</span>
              <Badge>{MCP_TRANSPORT_LABELS[server.transport]}</Badge>
            </span>
            <span {...stylex.props(catalog.meta)}>
              <span {...stylex.props(catalog.truncate, catalog.mono)}>
                {describeMcpConnection(server.connection) ?? '—'}
              </span>
            </span>
            {server.description ? (
              <span {...stylex.props(catalog.meta, catalog.metaHint)}>
                <span {...stylex.props(catalog.truncate)}>{server.description}</span>
              </span>
            ) : null}
          </span>
        </button>
        <div {...stylex.props(catalog.actions, styles.actions)}>
          {server.connection ? (
            <Button
              type="button"
              size="small"
              variant="ghost"
              disabled={!canDiscoverTools || toolList?.status === 'loading'}
              onClick={onDiscoverTools}
            >
              {toolList?.status === 'loading' ? (
                <Spinner size="small" />
              ) : (
                <RefreshCw {...stylex.props(catalog.icon)} />
              )}
              {t('settings.mcp.tools.discover')}
            </Button>
          ) : null}
          {/* The switch carries its own state attributes, so the label sits
            beside it rather than wrapping it in a tooltip trigger. */}
          <label
            {...stylex.props(styles.default)}
            title={t('settings.mcp.form.defaultEnabledHint')}
          >
            <span {...stylex.props(styles.defaultText)}>{t('settings.mcp.default')}</span>
            <Switch
              checked={server.enabledByDefault === true}
              aria-label={defaultLabel}
              onCheckedChange={onToggleDefault}
            />
          </label>
          <Button
            type="button"
            variant="ghost"
            aria-label={t('common.remove')}
            size="small"
            icon
            tone="destructive"
            onClick={onRemove}
          >
            <Trash2 {...stylex.props(catalog.icon)} />
          </Button>
        </div>
      </div>
      {server.connection && toolList ? (
        <div {...stylex.props(styles.tools)} aria-live="polite">
          {toolList.status === 'loading' ? (
            <Spinner size="small" aria-label={t('common.loading')} />
          ) : null}
          {toolList.status === 'error' ? (
            <span {...stylex.props(styles.error)}>{t('settings.mcp.tools.failed')}</span>
          ) : null}
          {toolList?.status === 'success' && toolList.tools.length > 0 ? (
            <div {...stylex.props(styles.toolList)} aria-label={t('settings.mcp.tools.label')}>
              {toolList.tools.map((tool) => (
                <Badge key={tool.name} title={tool.description}>
                  <span {...stylex.props(styles.toolName)}>{tool.name}</span>
                </Badge>
              ))}
            </div>
          ) : null}
          {toolList?.status === 'success' && toolList.tools.length === 0 ? (
            <span>{t('settings.mcp.tools.empty')}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type McpToolListState =
  | { status: 'loading' | 'error' }
  | { status: 'success'; tools: McpToolListResult['tools'] };
