import React, { useMemo, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { usePostHog } from '@posthog/react';
import { useCloudQuery, usePlatformCapability } from '@lody/platform/react';
import { getServerNow, type LocalProjectId, type MachineId, type WorkspaceId } from '@lody/shared';
import {
  getShortcutEmoji,
  getShortcutMentionGate,
  getShortcutMentionScopeIssues,
  type PromptShortcut,
  type PromptShortcutIndexEntry,
} from '@lody/shared/prompt-shortcuts';
import { Plus, SquareSlash, Trash2 } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { promptShortcutsFeatureEnabledAtom } from '@/atoms/settings';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { withClassName } from '@/lib/stylex';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { getPromptShortcutAnalyticsProperties } from '@/lib/prompt-shortcut-analytics';
import { usePromptShortcuts } from '../../providers/prompt-shortcut-provider';
import { useIsMobile } from '@/hooks/use-mobile';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useVisibleLocalProjectsFromMachineIndex } from '@/hooks/use-visible-local-projects';
import { useMachineFlockAgentConfigsForMachineIds } from '@/hooks/use-machine-flock-agent-configs';
import { CombinedMentionTextarea } from '@/components/mentions/combined-mention-textarea';
import { getComposerMentionChip } from '@/components/mentions/mention-chips';
import { toPersistedMentionRanges } from '@/components/mentions/mention-persistence';
import type { MentionProjectSource } from '@/components/mentions/mention-project-file-source';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Dialog } from '@/ui/dialog';
import { Dialog as UiDialog } from '@lody/ui/dialog';
import { Tooltip } from '@lody/ui/tooltip';
import { AlertDialog } from '@/ui/dialog';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space } from '@lody/ui/tokens/scales.stylex';
import { Section } from './form-primitives';
import {
  PromptShortcutForm,
  type ShortcutPromptEditorProps,
  type ShortcutScopeOptions,
} from './prompt-shortcut-form';
import { ScopePills } from './prompt-shortcut-scope';
import {
  SETTINGS_EDITOR_DIALOG_LAYOUT,
  settingsCatalog as catalog,
  settingsSurface as surface,
} from './surface';

/** The well's ink without its alpha, for the chip cover below. */
const WELL_INK = `rgb(from ${colors.wellBackground} r g b)`;

const styles = stylex.create({
  /** The row's body is two columns that wrap, so its glyph sits on the first line. */
  rowMainTop: { alignItems: 'flex-start', paddingBlock: '10px' },
  actionsTop: { alignSelf: 'flex-start', paddingBlock: space[2] },
  body: { gap: space[1] },
  titleLine: { rowGap: space[1] },
  slug: {
    flexShrink: 0,
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '0.7em',
    color: colors.secondaryLabel,
  },
  scope: { flexShrink: 0, marginInlineStart: 'auto' },
  statusLine: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space[3],
    rowGap: space[1],
    minWidth: 0,
  },
  warning: {
    flexShrink: 0,
    marginInlineStart: 'auto',
    fontSize: '0.7em',
    lineHeight: 1.25,
    color: colors.warning,
  },
  /** The read-only view's identity line: the glyph, the name, the command. */
  identity: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space[2],
    rowGap: space[1],
    minWidth: 0,
  },
  identityGlyph: { fontSize: '14px', lineHeight: 1 },
  identityName: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '14px',
    color: colors.label,
  },
  description: { margin: 0, fontSize: '12px', lineHeight: 1.375, color: colors.secondaryLabel },
  /** A saved prompt read back: the region rung, the editor's own type, no edge. */
  promptText: {
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    fontSize: '14px',
    lineHeight: '24px',
    color: colors.label,
  },
  /**
   * The prompt field is the composer's mention textarea, so it is given the
   * well by hand: the recess, and the ring on `:focus-within` because the
   * element that takes focus is the textarea inside it.
   *
   * A mention chip covers the textarea's glyphs with `--mention-chip-surface`,
   * which has to be opaque and equal to what shows through the well. The well is
   * translucent ink over the dialog, so the cover is that ink mixed into the
   * page at the well's own strength — close in both palettes, where a raw
   * surface colour would leave a faint box under every chip.
   */
  promptWell: {
    boxSizing: 'border-box',
    width: '100%',
    paddingInline: space[3],
    paddingBlock: '10px',
    backgroundColor: colors.wellBackground,
    boxShadow: {
      default: shadow.inset,
      ':focus-within': `${shadow.inset}, 0 0 0 2px ${colors.accent}`,
    },
    borderRadius: radius.medium,
    cornerShape: corner.round,
    '--mention-chip-surface': `color-mix(in srgb, ${colors.background} 95%, ${WELL_INK})`,
  },
  promptInput: {
    minHeight: '112px',
    width: '100%',
    padding: 0,
    borderWidth: 0,
    outline: 'none',
    fontSize: '14px',
    lineHeight: '24px',
    color: colors.label,
    '::placeholder': { color: colors.tertiaryLabel },
  },
});

export function PromptShortcutsSetting() {
  const enabled = useAtomValue(promptShortcutsFeatureEnabledAtom);
  const { t } = useTranslation();
  if (!enabled)
    return (
      <p {...stylex.props(surface.container)} role="status">
        {t(
          'settings.promptShortcuts.disabled',
          'Enable Prompt Shortcuts under Developer mode in Settings → About to use this feature.'
        )}
      </p>
    );
  return <EnabledPromptShortcutsSetting />;
}

function EnabledPromptShortcutsSetting() {
  const state = usePromptShortcuts();
  return (
    <PromptShortcutsSettingContent
      key={
        state.runtime
          ? JSON.stringify([state.runtime.workspaceId, state.runtime.userId])
          : 'unavailable'
      }
      state={state}
    />
  );
}

/** Drafts and late async reads must not survive an account/workspace switch. */
function PromptShortcutsSettingContent({
  state,
}: {
  state: ReturnType<typeof usePromptShortcuts>;
}) {
  const { t } = useTranslation();
  const postHog = usePostHog();
  const isMobile = useIsMobile();
  const { runtime, entries, loading } = state;
  const scope = useShortcutScopeOptions(runtime?.workspaceId);
  const [editor, setEditor] = useState<{
    value: PromptShortcut;
    base: PromptShortcutIndexEntry | null;
  } | null>(null);
  const [removal, setRemoval] = useState<PromptShortcutIndexEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const edit = async (entry: PromptShortcutIndexEntry) => {
    if (!runtime) return;
    setBusy(true);
    try {
      setEditor({ value: await runtime.read(entry), base: entry });
    } catch (error) {
      console.warn('Failed to read Prompt Shortcut', error);
    } finally {
      setBusy(false);
    }
  };
  const create = () => {
    if (!runtime) return;
    const now = getServerNow();
    setEditor({
      base: null,
      value: {
        v: 1,
        id: crypto.randomUUID(),
        revision: crypto.randomUUID(),
        workspaceId: runtime.workspaceId,
        ownerUserId: runtime.userId,
        visibility: 'private',
        name: '',
        slug: '',
        prompt: '',
        scope: {},
        mentions: [],
        createdAt: now,
        updatedAt: now,
      },
    });
  };
  const owned = editor ? editor.value.ownerUserId === runtime?.userId : false;
  return (
    <div {...stylex.props(surface.container)}>
      <p {...stylex.props(catalog.intro)}>
        {t(
          'settings.promptShortcuts.intro',
          'Saved Prompts you can call with a slash command. Each one says where it applies; a Shortcut with nothing set works anywhere in this workspace. Private until you share it.'
        )}
      </p>

      <PromptShortcutsList
        entries={entries}
        options={scope.options}
        currentUserId={runtime?.userId ?? null}
        loading={loading}
        busy={busy}
        canCreate={!!runtime}
        onCreate={create}
        onOpen={(entry) => void edit(entry)}
        onDelete={setRemoval}
      />

      <Dialog.Root
        open={!!editor && !!runtime}
        onOpenChange={(open) => {
          if (!open && !busy) setEditor(null);
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
              {!editor?.base
                ? t('settings.promptShortcuts.new', 'New Prompt Shortcut')
                : owned
                  ? t('settings.promptShortcuts.edit', 'Edit Prompt Shortcut')
                  : t('settings.promptShortcuts.view', 'Prompt Shortcut')}
            </Dialog.Title>
            <Dialog.Description>
              {owned
                ? t(
                    'settings.promptShortcuts.editorHelp',
                    'Saved to this workspace and sent as one message.'
                  )
                : t(
                    'settings.promptShortcuts.readOnlyHelp',
                    'Shared by another member. Only its author can change it.'
                  )}
            </Dialog.Description>
          </Dialog.Header>
          {editor && runtime ? (
            owned ? (
              <ShortcutEditor
                key={editor.value.id}
                initial={editor.value}
                isNew={!editor.base}
                canShare={runtime.canShare}
                saving={busy}
                scope={scope}
                onCancel={() => setEditor(null)}
                onSave={async (value) => {
                  setBusy(true);
                  try {
                    await runtime.save({
                      value: { ...value, revision: crypto.randomUUID(), updatedAt: getServerNow() },
                      base: editor.base,
                      bodyDocId:
                        !editor.base || editor.base.visibility !== value.visibility
                          ? crypto.randomUUID()
                          : editor.base.bodyDocId,
                    });
                    capturePostHogEvent(
                      postHog,
                      editor.base ? 'prompt_shortcut/updated' : 'prompt_shortcut/created',
                      {
                        ...getPromptShortcutAnalyticsProperties(value, value.mentions.length),
                        ...(editor.base
                          ? { visibility_changed: editor.base.visibility !== value.visibility }
                          : {}),
                      }
                    );
                    setEditor(null);
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            ) : (
              <PromptShortcutReadOnlyView
                shortcut={editor.value}
                options={scope.options}
                onClose={() => setEditor(null)}
              />
            )
          ) : null}
        </Dialog.Content>
      </Dialog.Root>

      <AlertDialog.Root
        open={!!removal}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoval(null);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {t('settings.promptShortcuts.deleteTitle', 'Delete Prompt Shortcut')}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {t('settings.promptShortcuts.deleteHelp', {
                defaultValue:
                  'Delete “{{name}}”? Prompts already inserted into drafts or sent messages are unchanged.',
                name: removal?.name ?? '',
              })}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={busy}>{t('common.cancel', 'Cancel')}</AlertDialog.Cancel>
            <Button
              disabled={busy}
              variant="destructive"
              onClick={() => {
                if (!runtime || !removal) return;
                setBusy(true);
                const deleted = removal;
                void runtime
                  .remove(deleted)
                  .then(() => {
                    capturePostHogEvent(
                      postHog,
                      'prompt_shortcut/deleted',
                      getPromptShortcutAnalyticsProperties(
                        deleted,
                        deleted.dependencySummary.length
                      )
                    );
                    setRemoval(null);
                  })
                  .catch((error) => console.warn('Failed to delete Prompt Shortcut', error))
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? <Spinner size="small" aria-hidden="true" /> : null}
              {t('common.delete', 'Delete')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </div>
  );
}

/**
 * The catalog, including the Shortcuts that cannot run right now.
 *
 * Settings is where a Shortcut gets FIXED, so a row that vanishes when its
 * machine sleeps is a row nobody can repair — unlike the `/` menu, which shows
 * only what the current chat can actually call.
 */
export function PromptShortcutsList({
  entries,
  options,
  currentUserId,
  loading,
  busy,
  canCreate,
  onCreate,
  onOpen,
  onDelete,
}: {
  entries: readonly PromptShortcutIndexEntry[];
  options?: ShortcutScopeOptions;
  currentUserId: string | null;
  loading: boolean;
  busy: boolean;
  canCreate: boolean;
  onCreate: () => void;
  onOpen: (entry: PromptShortcutIndexEntry) => void;
  onDelete: (entry: PromptShortcutIndexEntry) => void;
}) {
  const { t } = useTranslation();
  const addLabel = t('settings.promptShortcuts.new', 'New Prompt Shortcut');
  return (
    <section {...stylex.props(surface.section)}>
      <header {...stylex.props(surface.sectionHeader)}>
        <div {...stylex.props(catalog.heading)}>
          <h3 {...stylex.props(surface.sectionTitle)}>
            {t('settings.tabs.promptShortcuts', 'Prompt Shortcuts')}
          </h3>
          {entries.length > 0 ? (
            <span {...stylex.props(catalog.count)}>{entries.length}</span>
          ) : null}
          {loading ? (
            <span role="status" {...stylex.props(catalog.syncing)}>
              <Spinner size="small" aria-hidden="true" />
              {t('common.loading', 'Loading…')}
            </span>
          ) : null}
        </div>
        <div {...stylex.props(surface.sectionActions)}>
          <Tooltip.Root>
            <Tooltip.Trigger
              render={
                <Button
                  variant="ghost"
                  size="small"
                  icon
                  aria-label={addLabel}
                  disabled={!canCreate || busy}
                  onClick={onCreate}
                >
                  <Plus {...stylex.props(catalog.icon)} />
                </Button>
              }
            />
            <Tooltip.Content>{addLabel}</Tooltip.Content>
          </Tooltip.Root>
        </div>
      </header>

      {entries.length === 0 ? (
        loading ? null : (
          <div {...stylex.props(catalog.empty)}>
            <SquareSlash {...stylex.props(catalog.emptyIcon)} aria-hidden="true" />
            <p {...stylex.props(catalog.emptyText)}>
              {t(
                'settings.promptShortcuts.empty',
                'No Prompt Shortcuts yet. Save a Prompt you retype often and call it with /.'
              )}
            </p>
            <Button
              size="small"
              variant="secondary"
              disabled={!canCreate || busy}
              onClick={onCreate}
            >
              <Plus {...stylex.props(catalog.icon)} />
              {addLabel}
            </Button>
          </div>
        )
      ) : (
        <div {...stylex.props(surface.card)}>
          {entries.map((entry, index) => (
            <div key={entry.id} {...stylex.props(surface.line, index > 0 && surface.lineRuled)}>
              <PromptShortcutRow
                entry={entry}
                options={options}
                canManage={entry.ownerUserId === currentUserId}
                busy={busy}
                onOpen={() => onOpen(entry)}
                onDelete={() => onDelete(entry)}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * One catalog row: a line of the catalog's card, not a card of its own.
 *
 * States what the author decided — the command, who can read it, where it
 * applies, how many values a caller has to fill in — and, separately, anything
 * that stops it working. Scope pills are the author's intent; the status line
 * below them is a fact about right now, and the two never merge.
 */
export function PromptShortcutRow({
  entry,
  options,
  canManage,
  busy,
  onOpen,
  onDelete,
}: {
  entry: PromptShortcutIndexEntry;
  options?: ShortcutScopeOptions;
  canManage: boolean;
  busy: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  // Derived from the index alone: the saved dependencies against the saved
  // scope. It is not live availability — that needs the machine and the body —
  // so the row says what to repair rather than claiming a Shortcut is ready.
  const outOfScope = entry.dependencySummary.some(
    (target) => getShortcutMentionScopeIssues(entry.scope, target).length > 0
  );
  return (
    <div {...stylex.props(catalog.row, surface.pressableLine)}>
      <button
        type="button"
        onClick={onOpen}
        disabled={busy}
        aria-label={canManage ? t('common.edit', 'Edit') : t('common.view', 'View')}
        {...stylex.props(catalog.rowMain, styles.rowMainTop)}
      >
        <span aria-hidden="true" {...stylex.props(catalog.glyph)}>
          {getShortcutEmoji(entry)}
        </span>
        {/* Two columns, not one stack: identity reads down the left, and what
            the author set plus what is happening to it sit against the right
            edge. Both halves wrap instead of relying on a viewport breakpoint —
            settings render in a panel far narrower than the window. */}
        <span {...stylex.props(catalog.body, styles.body)}>
          <span {...stylex.props(catalog.titleLine, styles.titleLine)}>
            <span {...stylex.props(catalog.name)}>{entry.name}</span>
            <span {...stylex.props(styles.slug)}>/{entry.slug}</span>
            {/* Visibility, not scope: the pills say where it can be called,
                this says who can read it. */}
            <Badge>
              {entry.visibility === 'workspace'
                ? t('settings.promptShortcuts.shared', 'Shared')
                : t('settings.promptShortcuts.private', 'Private')}
            </Badge>
            {/* Owned by someone else: the missing delete button is the only
                other sign, and an absence is not a signal. */}
            {canManage ? null : (
              <Badge>{t('settings.promptShortcuts.readOnly', 'Read-only')}</Badge>
            )}
            <span {...stylex.props(styles.scope)}>
              <ScopePills scope={entry.scope} options={options} />
            </span>
          </span>
          {entry.description || outOfScope ? (
            <span {...stylex.props(styles.statusLine)}>
              {entry.description ? (
                <span {...stylex.props(catalog.meta)}>
                  <span {...stylex.props(catalog.truncate)}>{entry.description}</span>
                </span>
              ) : null}
              {/* The one status worth a row: the Shortcut's own references no
                  longer fit the scope it was saved with, which only its author
                  can repair. Publication state is deliberately absent — a local
                  save is already durable and the runtime retries on its own. */}
              {outOfScope ? (
                <span {...stylex.props(styles.warning)}>
                  {t(
                    'settings.promptShortcuts.needsAttention',
                    'A reference is outside this scope'
                  )}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
      </button>
      <div {...stylex.props(catalog.actions, styles.actionsTop)}>
        {canManage ? (
          <Button
            type="button"
            size="small"
            icon
            variant="ghost"
            tone="destructive"
            disabled={busy}
            aria-label={t('settings.promptShortcuts.delete', 'Delete shortcut')}
            onClick={onDelete}
          >
            <Trash2 {...stylex.props(catalog.icon)} />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Someone else's shared Shortcut.
 *
 * Read-only because only its author may change it (a copy-to-mine action is not
 * built yet). Rendered with the editor's own sections so the same Shortcut looks
 * like the same thing whether or not you own it.
 */
export function PromptShortcutReadOnlyView({
  shortcut,
  options,
  onClose,
  className,
}: {
  shortcut: PromptShortcut;
  options?: ShortcutScopeOptions;
  onClose: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div {...withClassName(stylex.props(catalog.editorForm), className)}>
      <div {...withClassName(stylex.props(catalog.editorBody), 'scrollbar-pro')}>
        <div {...stylex.props(styles.identity)}>
          <span aria-hidden="true" {...stylex.props(styles.identityGlyph)}>
            {getShortcutEmoji(shortcut)}
          </span>
          <span {...stylex.props(styles.identityName)}>{shortcut.name}</span>
          <span {...stylex.props(styles.slug)}>/{shortcut.slug}</span>
          <Badge>{t('settings.promptShortcuts.shared', 'Shared')}</Badge>
        </div>
        {shortcut.description ? (
          <p {...stylex.props(styles.description)}>{shortcut.description}</p>
        ) : null}
        <Section title={t('settings.promptShortcuts.scope', 'Applies to')}>
          <ScopePills scope={shortcut.scope} options={options} />
        </Section>
        <Section title={t('settings.promptShortcuts.prompt', 'Prompt')}>
          {/* Same type as the editor's own prompt field: one Shortcut should not
              look like two different things depending on who opened it. */}
          <div {...stylex.props(surface.formBlock, styles.promptText)}>{shortcut.prompt}</div>
        </Section>
      </div>
      <UiDialog.Footer>
        <Button type="button" variant="secondary" onClick={onClose}>
          {t('common.close', 'Close')}
        </Button>
      </UiDialog.Footer>
    </div>
  );
}

/**
 * Everything the scope axes can be set to, resolved once for the whole panel.
 *
 * The list needs the same labels as the editor's selectors — a row that printed
 * a raw machine id next to a selector that prints its name is two different
 * answers to one question.
 */
function useShortcutScopeOptions(workspaceIdInput?: string) {
  const workspaceId = workspaceIdInput as WorkspaceId | undefined;
  const machineIndex = useVisibleMachineMetas(workspaceId ? { workspaceId } : undefined);
  const machineIds = useMemo(() => [...machineIndex.machines.keys()], [machineIndex.machines]);
  useMachineFlockAgentConfigsForMachineIds(machineIds);
  const { projects } = useVisibleLocalProjectsFromMachineIndex(
    machineIndex,
    workspaceId ? { workspaceId } : undefined
  );
  const configs = useAtomValue(getAllAgentConfigAtom);
  const repositories = useCloudQuery(
    cloudOperations.github.getWorkspaceRepositories,
    workspaceId ? { workspaceId } : 'skip'
  );
  const providers = useMemo(
    () =>
      new Map(
        configs
          .filter((config) => machineIndex.machines.has(config.machineId))
          .map((config) => [`${config.cliType}:${config.agentType}`, config])
      ),
    [configs, machineIndex.machines]
  );
  const options: ShortcutScopeOptions = {
    projects: [
      ...(repositories ?? []).map((repo) => ({
        value: { kind: 'github' as const, repository: repo.fullName },
        label: repo.fullName,
      })),
      ...[...projects.values()].map(({ project, machine }) => ({
        value: { kind: 'local' as const, id: project.id, machineId: machine.id },
        label: `${project.name} · ${machine.name}`,
      })),
    ],
    machines: [...machineIndex.machines.values()].map((machine) => ({
      value: machine.id,
      label: machine.name,
    })),
    providers: [...providers].map(([value, config]) => ({ value, label: config.name })),
  };
  return { options, providers, repositories, workspaceId };
}

type ShortcutScopeData = ReturnType<typeof useShortcutScopeOptions>;

/**
 * The editor, wired to this workspace's mention sources.
 *
 * The prompt field is the composer's own mention textarea in template mode:
 * `@` / `$` / `#` complete from what "Applies to" allows, and the semantic
 * target is frozen at selection instead of re-parsed from a label at save time.
 */
function ShortcutEditor({
  scope,
  ...props
}: {
  initial: PromptShortcut;
  isNew: boolean;
  canShare: boolean;
  saving: boolean;
  scope: ShortcutScopeData;
  className?: string;
  onCancel(): void;
  onSave(value: PromptShortcut): Promise<void>;
}) {
  const allowMachineSelection = usePlatformCapability('remoteMachines');
  const { options, providers, repositories, workspaceId } = scope;
  const renderPrompt = (editor: ShortcutPromptEditorProps) => {
    const { project } = editor.scope;
    const mentionSource: MentionProjectSource | undefined =
      getShortcutMentionGate('file', editor.scope).enabled && project
        ? project.kind === 'github'
          ? {
              kind: 'github',
              repoFullName: project.repository,
              isPublic:
                repositories?.find((repo) => repo.fullName === project.repository)?.private ===
                false,
            }
          : {
              kind: 'local',
              workspaceId: workspaceId as WorkspaceId,
              machineId: project.machineId as MachineId,
              localProjectId: project.id as LocalProjectId,
            }
        : undefined;
    const config = editor.scope.providerKey ? providers.get(editor.scope.providerKey) : undefined;
    return (
      <ShortcutPromptField
        editor={editor}
        mentionSource={mentionSource}
        disabled={props.saving}
        skillAgent={
          config
            ? {
                cliType: config.cliType,
                agentType: config.agentType,
                machineId: editor.scope.machineId,
              }
            : undefined
        }
      />
    );
  };
  return (
    <PromptShortcutForm
      {...props}
      allowMachineSelection={allowMachineSelection}
      options={options}
      renderPrompt={renderPrompt}
    />
  );
}

/**
 * The prompt field: the composer's own mention textarea, in template mode.
 *
 * Exported so Storybook renders the field that ships rather than a plain
 * textarea — the chip cover colour has to match the surface behind it, and that
 * is only visible in the real thing.
 */
export function ShortcutPromptField({
  editor,
  mentionSource,
  skillAgent,
  disabled,
}: {
  editor: ShortcutPromptEditorProps;
  mentionSource?: MentionProjectSource;
  skillAgent?: React.ComponentProps<typeof CombinedMentionTextarea>['skillAgent'];
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <CombinedMentionTextarea
      // Scope owns the candidate sources, so a change rebuilds them; the draft's
      // own ranges come back through `persistedMentions`.
      key={JSON.stringify(editor.scope)}
      id="shortcut-prompt"
      aria-label={t('settings.promptShortcuts.prompt', 'Prompt')}
      placeholder={t(
        'settings.promptShortcuts.promptPlaceholder',
        'Write the prompt you would otherwise retype.'
      )}
      value={editor.value}
      onValueChange={editor.onValueChange}
      templateScope={editor.scope}
      mentionSource={mentionSource}
      persistedMentions={editor.initialRanges}
      getMentionChip={getComposerMentionChip}
      commandsEnabled={false}
      disabled={disabled}
      rows={4}
      // A value holder, so the well every other field in the form is.
      containerClassName={stylex.props(styles.promptWell).className}
      className={withClassName(stylex.props(styles.promptInput), 'input-scrollbar').className}
      skillAgent={skillAgent}
      onMentionRangesChange={(ranges) => editor.onRangesChange(toPersistedMentionRanges(ranges))}
    />
  );
}
