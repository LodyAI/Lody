import { useState } from 'react';
import { useAtomValue } from 'jotai';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { Switch } from '@lody/ui/switch';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text as uiText } from '@lody/ui/tokens/scales.stylex';
import { getEffectiveDefaultMcpIds, getProjectMcpKey, type McpServerId, type WorkspaceMcpServerMeta } from '@lody/shared';
import {
  putProjectMcpDefault,
  resolveProjectMcpDefaultManagement,
  type ProjectMcpDefaultAccess,
  type ProjectMcpDefaultManagement,
  type ProjectMcpDefaultTarget,
} from '@/lib/workspace-catalog-write';
import { CompactRow, CompactSection, SettingsEmptyList } from './compact-layout';

export type ProjectDefaultMcpViewProps = {
  status: 'loading' | 'failed' | 'ready';
  servers: readonly WorkspaceMcpServerMeta[];
  selectedIds: readonly McpServerId[];
  customized: boolean;
  readOnlyReason: Extract<ProjectMcpDefaultManagement, { kind: 'read_only' }>['reason'] | null;
  saving: boolean;
  saveFailed: boolean;
  onToggle: (id: McpServerId, enabled: boolean) => void;
  /** The catalog is managed in Settings > MCP; omitted where that page is unreachable. */
  onManageMcp?: () => void;
};

/**
 * Which workspace MCP servers a new conversation in this project starts with.
 *
 * A switch means "preselected", never "connected": a server with no connection
 * stays selectable, and says it has nothing to connect to.
 */
export function ProjectDefaultMcpView({
  status,
  servers,
  selectedIds,
  customized,
  readOnlyReason,
  saving,
  saveFailed,
  onToggle,
  onManageMcp,
}: ProjectDefaultMcpViewProps) {
  const { t } = useTranslation();
  const selected = new Set(selectedIds);
  const manageAction = onManageMcp ? (
    <Button type="button" size="small" variant="secondary" onClick={onManageMcp}>
      {t('workspace.projects.defaultMcp.manage', 'Manage MCP servers')}
    </Button>
  ) : undefined;

  if (status === 'loading') {
    return (
      <SettingsEmptyList>
        <span {...stylex.props(styles.inline)}>
          <Spinner size="small" aria-hidden="true" />
          {t('workspace.projects.defaultMcp.loading', 'Loading the workspace MCP catalog…')}
        </span>
      </SettingsEmptyList>
    );
  }
  if (status === 'failed') {
    return (
      <SettingsEmptyList>
        <span {...stylex.props(styles.error)}>
          {t(
            'workspace.projects.defaultMcp.loadFailed',
            'The workspace MCP catalog couldn’t be read, so this project’s defaults are unavailable.'
          )}
        </span>
      </SettingsEmptyList>
    );
  }
  if (servers.length === 0) {
    return (
      <SettingsEmptyList action={manageAction}>
        {t(
          'workspace.projects.defaultMcp.empty',
          'No MCP servers are configured for this workspace.'
        )}
      </SettingsEmptyList>
    );
  }

  const readOnlyNote =
    readOnlyReason === 'signed_out'
      ? t(
          'workspace.projects.defaultMcp.readOnlySignedOut',
          'Sign in to change this project’s defaults.'
        )
      : readOnlyReason === 'not_in_workspace'
        ? t(
            'workspace.projects.defaultMcp.readOnlyNotInWorkspace',
            'This repository isn’t connected to the workspace, so its defaults can’t be changed.'
          )
        : readOnlyReason
          ? t(
              'workspace.projects.defaultMcp.readOnlyNotOwner',
              'Only the owner of this project’s machine can change its defaults.'
            )
          : null;

  return (
    <>
      <p {...stylex.props(styles.note)}>
        {customized
          ? t(
              'workspace.projects.defaultMcp.custom',
              'This project has its own list; servers later turned on for the whole workspace don’t join it.'
            )
          : t(
              'workspace.projects.defaultMcp.inherited',
              'Following the workspace defaults until you change a switch here.'
            )}
      </p>
      {readOnlyNote ? <p {...stylex.props(styles.note)}>{readOnlyNote}</p> : null}
      {saveFailed ? (
        <p role="alert" {...stylex.props(styles.note, styles.error)}>
          {t('workspace.projects.defaultMcp.saveFailed', 'The change wasn’t saved. Try again.')}
        </p>
      ) : null}
      <CompactSection boxed>
        {servers.map((server) => {
          const missingConnection = !server.connection;
          const helper = missingConnection ? (
            <span {...stylex.props(styles.warning)}>
              {t(
                'workspace.projects.defaultMcp.missingConnection',
                'No connection is configured; it won’t load until one is added.'
              )}
            </span>
          ) : (
            server.description
          );
          return (
            <CompactRow
              key={server.id}
              label={server.name}
              helper={helper || undefined}
              disabled={readOnlyReason !== null}
            >
              <Switch
                checked={selected.has(server.id)}
                disabled={readOnlyReason !== null || saving}
                aria-label={t(
                  'workspace.projects.defaultMcp.toggle',
                  'Start new conversations with {{name}}',
                  {
                    name: server.name,
                  }
                )}
                onCheckedChange={(enabled) => onToggle(server.id, enabled)}
              />
            </CompactRow>
          );
        })}
      </CompactSection>
    </>
  );
}

/** The live Tab: the project's defaults from the catalog room, written with its authority. */
export function ProjectDefaultMcpTab({
  target,
  access,
  onManageMcp,
}: {
  target: ProjectMcpDefaultTarget;
  access: ProjectMcpDefaultAccess;
  onManageMcp?: () => void;
}) {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const catalog = useWorkspaceCatalog();
  const projectKey = getProjectMcpKey(target.project, target.machineId);
  const preference = projectKey ? catalog.projectMcpDefaults[projectKey] : undefined;
  const selectedIds = getEffectiveDefaultMcpIds(catalog.servers, preference);
  const management = resolveProjectMcpDefaultManagement(target, access);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'failed'>('idle');

  const setServerEnabled = async (id: McpServerId, enabled: boolean) => {
      // The first edit writes the whole effective list with this change, so a
      // project that customizes one switch keeps every other default it had.
      const next = enabled
        ? [...selectedIds.filter((selected) => selected !== id), id]
        : selectedIds.filter((selected) => selected !== id);
      setSaveState('saving');
      try {
        if (!runtime) throw new Error('Workspace runtime is unavailable');
        await putProjectMcpDefault(runtime, target, access, next);
        setSaveState('idle');
      } catch (error) {
        setSaveState('failed');
        console.error('Failed to save project default MCP servers', error);
      }
  };

  const status: 'ready' | 'failed' | 'loading' = catalog.loaded
    ? 'ready'
    : catalog.failed
      ? 'failed'
      : 'loading';

  return (
    <ProjectDefaultMcpView
      status={status}
      servers={catalog.servers}
      selectedIds={selectedIds}
      customized={preference !== undefined}
      readOnlyReason={management.kind === 'read_only' ? management.reason : null}
      saving={saveState === 'saving'}
      saveFailed={saveState === 'failed'}
      onToggle={(id, enabled) => {
        void setServerEnabled(id, enabled);
      }}
      onManageMcp={onManageMcp}
    />
  );
}

const styles = stylex.create({
  inline: { display: 'inline-flex', alignItems: 'center', gap: space[2] },
  note: {
    margin: 0,
    fontSize: uiText.footnoteSize,
    lineHeight: 1.375,
    color: colors.secondaryLabel,
  },
  error: { color: colors.destructive },
  warning: { color: colors.warning },
});
