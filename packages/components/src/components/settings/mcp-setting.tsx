import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useAtomValue } from 'jotai';
import { usePostHog } from '@posthog/react';
import { Plug, Plus, Trash2 } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
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
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { MCP_TRANSPORT_LABELS, McpTransportIcon } from '@/components/shared/mcp-transport';
import { AlertDialog } from '@/ui/dialog';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Dialog } from '@/ui/dialog';
import { Switch } from '@lody/ui/switch';
import { Tooltip } from '@lody/ui/tooltip';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { McpConnectionForm, type McpConnectionFormValue } from './mcp-connection-form';
import {
  SETTINGS_EDITOR_DIALOG_LAYOUT,
  settingsCatalog as catalog,
  settingsSurface as surface,
} from './surface';
import { settingsType as type } from './type.stylex';

const styles = stylex.create({
  actions: { gap: space[2] },
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
    <div {...stylex.props(surface.container)}>
      <p {...stylex.props(catalog.intro)}>{t('settings.mcp.description')}</p>

      <section {...stylex.props(surface.section)}>
        <header {...stylex.props(surface.sectionHeader)}>
          <div {...stylex.props(catalog.heading)}>
            <h3 {...stylex.props(surface.sectionTitle)}>{t('settings.mcp.catalogTitle')}</h3>
            {servers.length > 0 ? (
              <span {...stylex.props(catalog.count)}>{servers.length}</span>
            ) : null}
            {!synced ? (
              <span {...stylex.props(catalog.syncing)}>
                <Spinner size="small" aria-hidden="true" />
                {t('settings.mcp.syncing')}
              </span>
            ) : null}
          </div>
          <div {...stylex.props(surface.sectionActions)}>
            <Tooltip.Root>
              <Tooltip.Trigger
                render={
                  <Button
                    variant="ghost"
                    aria-label={addLabel}
                    size="small"
                    icon
                    onClick={() => openEditor({ mode: 'add' })}
                  >
                    <Plus {...stylex.props(catalog.icon)} />
                  </Button>
                }
              />
              <Tooltip.Content>{addLabel}</Tooltip.Content>
            </Tooltip.Root>
          </div>
        </header>

        {servers.length === 0 ? (
          <div {...stylex.props(catalog.empty)}>
            <Plug {...stylex.props(catalog.emptyIcon)} aria-hidden="true" />
            <p {...stylex.props(catalog.emptyText)}>{t('settings.mcp.empty')}</p>
            <Button size="small" variant="secondary" onClick={() => openEditor({ mode: 'add' })}>
              <Plus {...stylex.props(catalog.icon)} />
              {addLabel}
            </Button>
          </div>
        ) : (
          <div {...stylex.props(surface.card)}>
            {servers.map((server, index) => (
              <div key={server.id} {...stylex.props(surface.line, index > 0 && surface.lineRuled)}>
                <McpServerRow
                  server={server}
                  onEdit={() => openEditor({ mode: 'edit', entry: server })}
                  onToggleDefault={(enabled) => void toggleDefault(server, enabled)}
                  onRemove={() => setPendingRemoval(server)}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      <Dialog.Root
        open={editor !== null}
        onOpenChange={(open) => {
          if (open) return;
          setError(undefined);
          setEditor(null);
        }}
      >
        <Dialog.Content
          backdropClassName={
            // Desktop settings is itself a dialog; match its z-index so this
            // later overlay covers it without stacking a second /80 veil.
            isMobile ? undefined : 'z-[var(--z-dialog)] bg-black/20'
          }
          className={SETTINGS_EDITOR_DIALOG_LAYOUT}
        >
          <Dialog.Header>
            <Dialog.Title>
              {editor?.mode === 'edit' ? t('settings.mcp.editTitle') : t('settings.mcp.addTitle')}
            </Dialog.Title>
            <Dialog.Description>{t('settings.mcp.dialogDescription')}</Dialog.Description>
          </Dialog.Header>
          {editor ? (
            <McpConnectionForm
              key={editor.mode === 'edit' ? editor.entry.id : 'new'}
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
}: {
  server: WorkspaceMcpServerMeta;
  onEdit: () => void;
  onToggleDefault: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const defaultLabel = t('settings.mcp.defaultToggle', { name: server.name });
  return (
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
        {/* The switch carries its own state attributes, so the label sits
            beside it rather than wrapping it in a tooltip trigger. */}
        <label {...stylex.props(styles.default)} title={t('settings.mcp.form.defaultEnabledHint')}>
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
  );
}
