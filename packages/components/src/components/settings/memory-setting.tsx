import { useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Check, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Tooltip } from '@lody/ui/tooltip';
import { Popover } from '@lody/ui/popover';
import { useIsMobile } from '@/hooks/use-mobile';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Textarea } from '@lody/ui/textarea';
import { Tabs } from '@lody/ui/tabs';
import { Radio, RadioGroup } from '@lody/ui/radio';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { Dialog } from '@/ui/dialog';
import {
  MEMORY_PROVIDERS,
  getAgentRoleEmoji,
  type AgentRole,
  MemoryCreateInputSchema,
  isMemoryIdentityMissing,
  machineSupportsMemoryProviders,
  type MachineId,
  type MemoryAssociation,
  type MemoryBinding,
  type MemoryCreateInput,
  type MemoryIdentity,
  type MemoryProviderResponse,
} from '@lody/shared';
import nowledgeLogo from '@/assets/nowledge-mem.png';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useMachineOnlineStatus, useOnlineMachineIds } from '@/hooks/use-machine-online-status';
import { useMemoryProvider } from '@/hooks/use-memory-provider';
import { useOpenSettings } from '@/hooks/use-open-settings';
import { useWorkspaceAgentRoles } from '@/hooks/use-workspace-agent-roles';
import { useMemoryAssociations } from '@/hooks/use-memory-associations';
import { useAppCapability } from '@/lib/app-platform';
import { openExternalUrl } from '@/lib/native-browser';
import { MachinePills } from './machine-pills';
import { Field, FormMessage } from './form-primitives';
import { settingsCatalog as catalog, settingsSurface as surface } from './surface';
import { SettingsEmptyList, settingsRecordsCard } from './compact-layout';
import { SettingsLineTabs } from './settings-line-tabs';
import { SettingsPageActions, SettingsPageLead, useInSettingsPane } from './settings-page-header';

type ProviderDefinition = {
  id: string;
  name: string;
  installUrl?: string;
  createFields: readonly (keyof MemoryCreateInput)[];
};
const styles = stylex.create({
  stack: { display: 'flex', flexDirection: 'column', gap: space[4], minWidth: 0 },
  row: { display: 'flex', alignItems: 'center', gap: space[2] },
  machineDot: {
    flexShrink: 0,
    width: '6px',
    height: '6px',
    borderRadius: '999px',
    backgroundColor: colors.tertiaryLabel,
  },
  machineDotOnline: { backgroundColor: colors.success },
  recordLogo: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    flexShrink: 0,
    width: '32px',
    height: '32px',
  },
  assignedRoles: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space[1],
    maxWidth: '45%',
  },
  assignedLabel: { whiteSpace: 'nowrap' },
  unlinkRow: { display: 'flex', justifyContent: 'flex-end' },
  record: { position: 'relative' },
  actions: {
    opacity: {
      default: 0,
      [stylex.when.ancestor(':hover')]: 1,
      [stylex.when.ancestor(':focus-within')]: 1,
      '@media (hover: none)': 1,
    },
    pointerEvents: {
      default: 'none',
      [stylex.when.ancestor(':hover')]: 'auto',
      [stylex.when.ancestor(':focus-within')]: 'auto',
      '@media (hover: none)': 'auto',
    },
  },
  logo: {
    width: '20px',
    height: '20px',
    flexShrink: 0,
    objectFit: 'contain',
    filter: 'grayscale(1)',
  },
  description: {
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
    overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap',
  },
  note: { padding: space[4] },
  layout: {
    display: 'flex',
    height: '100%',
    minHeight: 0,
    '@media (max-width: 600px)': { flexDirection: 'column' },
  },
  rail: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    flexShrink: 0,
    width: '292px',
    paddingBlock: space[4],
    paddingInline: space[2],
    boxSizing: 'border-box',
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 3%)`,
    borderInlineEnd: `1px solid ${colors.separator}`,
    '@media (max-width: 600px)': {
      width: '100%',
      borderInlineEnd: 'none',
      borderBottom: `1px solid ${colors.separator}`,
    },
  },
  railTitle: { paddingInline: space[2] },
  railItem: { gap: '10px', fontSize: '13px' },
  railIcon: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
  },
  detail: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    padding: space[6],
    gap: space[4],
  },
  form: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: space[4] },
  scroll: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[4],
    overflowY: 'auto',
    flex: 1,
    minHeight: 0,
    padding: space[1],
  },
  fields: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: space[4] },
  fullField: { gridColumn: '1 / -1' },
});

export function MemoryProviderLogo({ providerId }: { providerId: string }) {
  return providerId === 'nowledge-mem' ? (
    <img src={nowledgeLogo} alt="Nowledge Mem" {...stylex.props(styles.logo)} />
  ) : null;
}

function MemoryRoleAvatar({ role }: { role: AgentRole }) {
  const mobile = useIsMobile();
  const trigger = (
    <Button type="button" variant="ghost" size="small" icon aria-label={role.name}>
      <span aria-hidden="true">{getAgentRoleEmoji(role)}</span>
    </Button>
  );
  return mobile ? (
    <Popover.Root>
      <Popover.Trigger render={trigger} />
      <Popover.Content>{role.name}</Popover.Content>
    </Popover.Root>
  ) : (
    <Tooltip.Root>
      <Tooltip.Trigger render={trigger} />
      <Tooltip.Content>{role.name}</Tooltip.Content>
    </Tooltip.Root>
  );
}

/** The list is Lody's saved associations, never the complete external inventory. */
export function MemoryAssociationList({
  entries,
  inventory,
  onEdit,
  onRemove,
  onSelect,
  selected,
  onAssociateRole,
  getAssignedRoles,
}: {
  onAssociateRole?: (entry: MemoryAssociation) => void;
  getAssignedRoles?: (entry: MemoryAssociation) => readonly AgentRole[];
  entries: MemoryAssociation[];
  inventory?: MemoryProviderResponse;
  onEdit?: (entry: MemoryAssociation) => void;
  onRemove?: (entry: MemoryAssociation) => void;
  onSelect?: (entry: MemoryAssociation) => void;
  selected?: MemoryBinding;
}) {
  const { t } = useTranslation();
  if (!entries.length)
    return <SettingsEmptyList>{t('settings.memory.emptyLinked')}</SettingsEmptyList>;
  return (
    <div {...stylex.props(settingsRecordsCard)}>
      {entries.map((entry, index) => {
        const assignedRoles = getAssignedRoles?.(entry) ?? [];
        const Main = onSelect ? 'button' : 'div';
        const missing = isMemoryIdentityMissing(entry, inventory);
        const linked =
          selected?.providerId === entry.providerId && selected.memoryId === entry.memoryId;
        return (
          <div
            key={`${entry.providerId}:${entry.memoryId}`}
            {...stylex.props(
              stylex.defaultMarker(),
              catalog.row,
              styles.record,
              surface.line,
              linked && surface.listRowSelected,
              index > 0 && surface.lineRuled
            )}
          >
            <Main
              type={onSelect ? 'button' : undefined}
              disabled={onSelect ? missing : undefined}
              onClick={onSelect ? () => onSelect(entry) : undefined}
              aria-pressed={onSelect ? linked : undefined}
              {...stylex.props(catalog.rowMain)}
            >
              <span {...stylex.props(styles.recordLogo)}>
                <MemoryProviderLogo providerId={entry.providerId} />
              </span>
              <div {...stylex.props(catalog.body)}>
                <div {...stylex.props(catalog.titleLine)}>
                  <span {...stylex.props(catalog.name)}>{entry.name}</span>
                </div>
                {entry.description ? (
                  <span {...stylex.props(styles.description)}>{entry.description}</span>
                ) : null}
                {missing ? (
                  <FormMessage tone="warning">{t('settings.memory.missing')}</FormMessage>
                ) : null}
              </div>
            </Main>
            {assignedRoles.length > 0 ? (
              <div {...stylex.props(styles.assignedRoles)}>
                <span {...stylex.props(catalog.meta, styles.assignedLabel)}>
                  {t('settings.memory.assignedRoles')}
                </span>
                {assignedRoles.map((role) => (
                  <MemoryRoleAvatar key={role.id} role={role} />
                ))}
              </div>
            ) : onAssociateRole ? (
              <Button
                type="button"
                size="small"
                variant="secondary"
                onClick={() => onAssociateRole(entry)}
              >
                {t('settings.memory.associateRole')}
              </Button>
            ) : null}
            <div {...stylex.props(catalog.actions, !onSelect && styles.actions)}>
              {onSelect ? (
                <Button
                  type="button"
                  size="small"
                  variant={linked ? 'secondary' : 'ghost'}
                  disabled={missing}
                  aria-pressed={linked}
                  onClick={() => onSelect(entry)}
                >
                  {linked ? <Check size={14} /> : null}
                  {t(linked ? 'settings.memory.linked' : 'settings.memory.link')}
                </Button>
              ) : (
                <>
                  <Button
                    type="button"
                    size="small"
                    variant="ghost"
                    icon
                    aria-label={t('settings.memory.editName', { name: entry.name })}
                    onClick={() => onEdit?.(entry)}
                  >
                    <Pencil size={14} />
                  </Button>
                  <Button
                    type="button"
                    size="small"
                    variant="ghost"
                    icon
                    aria-label={t('settings.memory.deleteName', { name: entry.name })}
                    onClick={() => onRemove?.(entry)}
                  >
                    <Trash2 size={14} />
                  </Button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Single selection of provider identities in the Link tab. */
export function MemoryIdentityList({
  memories,
  linkedIds = [],
  selected,
  onSelect,
}: {
  memories: MemoryIdentity[];
  linkedIds?: string[];
  selected?: string;
  onSelect?: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (!memories.length) return <SettingsEmptyList>{t('settings.memory.empty')}</SettingsEmptyList>;
  return (
    <RadioGroup
      aria-label={t('settings.memory.identities')}
      value={selected ?? ''}
      onValueChange={(value) => onSelect?.(String(value))}
    >
      {memories.map((memory) => (
        <label
          key={memory.id}
          {...stylex.props(
            surface.listRow,
            selected === memory.id && surface.listRowSelected,
            styles.row,
            styles.note
          )}
        >
          <Radio
            value={memory.id}
            aria-label={memory.name}
            disabled={linkedIds.includes(memory.id)}
          />
          <div {...stylex.props(catalog.body)}>
            <span {...stylex.props(catalog.name)}>
              {memory.name}
              {linkedIds.includes(memory.id) ? ` · ${t('settings.memory.imported')}` : null}
            </span>
            {memory.description ? (
              <span {...stylex.props(styles.description)}>{memory.description}</span>
            ) : null}
          </div>
        </label>
      ))}
    </RadioGroup>
  );
}

export function MemorySetting() {
  const { t } = useTranslation();
  const { machines, accessByMachineId } = useVisibleMachineMetas();
  const localId = useAtomValue(localMachineIdAtom);
  const onlineIds = useOnlineMachineIds();
  const remote = useAppCapability('remoteMachines');
  const inPane = useInSettingsPane();
  const [selected, setSelected] = useState<MachineId | null>(null);
  const machineId = remote
    ? selected && machines.has(selected)
      ? selected
      : localId
        ? localId
        : (machines.keys().next().value ?? null)
    : localId;
  const pills = useMemo(
    () =>
      [...machines.values()]
        .map((machine) => ({
          id: machine.id,
          label: machine.name || machine.id,
          online: onlineIds.has(machine.id),
          private: !(accessByMachineId.get(machine.id)?.sharedWithTeam ?? false),
        }))
        .sort(
          (a, b) =>
            Number(b.id === localId) - Number(a.id === localId) ||
            Number(b.online) - Number(a.online) ||
            a.label.localeCompare(b.label)
        ),
    [machines, onlineIds, accessByMachineId, localId]
  );
  return (
    <div {...stylex.props(surface.container, styles.stack)}>
      <SettingsPageLead>{t('settings.memory.description')}</SettingsPageLead>
      {remote && !inPane ? (
        <MachinePills
          pills={pills}
          selectedId={machineId}
          onSelect={(id) => setSelected(id as MachineId)}
        />
      ) : null}
      {remote && inPane && pills.length > 1 ? (
        <SettingsLineTabs
          tabs={pills.map((pill) => ({
            ...pill,
            leading: (
              <span
                aria-hidden="true"
                {...stylex.props(styles.machineDot, pill.online && styles.machineDotOnline)}
              />
            ),
          }))}
          current={machineId ?? ''}
          onChange={(id) => setSelected(id as MachineId)}
          label={t('settings.agent.machineTabs.machine', 'Machine')}
        />
      ) : null}
      {machineId ? (
        <MachineMemories
          key={machineId}
          machineId={machineId}
          supported={machineSupportsMemoryProviders(machines.get(machineId))}
        />
      ) : (
        <p>{t('settings.memory.noMachine')}</p>
      )}
    </div>
  );
}

type Editor = { providerId: string; entry?: MemoryAssociation };
function MachineMemories({ machineId, supported }: { machineId: MachineId; supported: boolean }) {
  const { t } = useTranslation();
  const associations = useMemoryAssociations(machineId);
  const { roles, synced } = useWorkspaceAgentRoles();
  const { openSettings } = useOpenSettings();
  const getAssignedRoles = (entry: MemoryAssociation) =>
    roles.filter(
      (role) =>
        role.machineId === machineId &&
        role.runConfig.memory?.providerId === entry.providerId &&
        role.runConfig.memory.memoryId === entry.memoryId
    );

  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const online = useMachineOnlineStatus(machineId) === 'online';
  const providers: ProviderDefinition[] = [...MEMORY_PROVIDERS];
  for (const entry of associations.entries)
    if (!providers.some((p) => p.id === entry.providerId))
      providers.push({ id: entry.providerId, name: entry.providerId, createFields: [] });
  return (
    <>
      <SettingsPageActions>
        <Button
          type="button"
          size="small"
          variant="ghost"
          icon
          disabled={!online || !supported}
          aria-label={t('settings.memory.refresh')}
          onClick={() => setRefreshToken((value) => value + 1)}
        >
          <RefreshCw size={14} />
        </Button>
        <Button
          type="button"
          size="small"
          variant="secondary"
          onClick={() => setEditor({ providerId: MEMORY_PROVIDERS[0].id })}
        >
          <Plus size={14} />
          {t('settings.memory.add')}
        </Button>
      </SettingsPageActions>
      {error ? <FormMessage tone="error">{t('settings.memory.saveError')}</FormMessage> : null}
      {providers.map((provider) => (
        <ProviderRecords
          key={provider.id}
          machineId={machineId}
          provider={provider}
          refreshToken={refreshToken}
          getAssignedRoles={getAssignedRoles}
          onAssociateRole={synced ? () => openSettings('agent-roles', { machineId }) : undefined}
          supported={supported}
          entries={associations.entries.filter((entry) => entry.providerId === provider.id)}
          editor={editor?.providerId === provider.id ? editor : null}
          setEditor={setEditor}
          save={async (entry, edit) => {
            await (edit ? associations.edit : associations.link)(entry);
          }}
          remove={async (entry) => {
            setError(false);
            try {
              await associations.remove(entry);
            } catch {
              setError(true);
            }
          }}
        />
      ))}
    </>
  );
}

function ProviderRecords({
  machineId,
  provider,
  supported,
  refreshToken,
  entries,
  editor,
  setEditor,
  save,
  remove,
  getAssignedRoles,
  onAssociateRole,
}: {
  getAssignedRoles: (entry: MemoryAssociation) => readonly AgentRole[];
  onAssociateRole?: (entry: MemoryAssociation) => void;
  machineId: MachineId;
  provider: ProviderDefinition;
  supported: boolean;
  refreshToken: number;
  entries: MemoryAssociation[];
  editor: Editor | null;
  setEditor: (editor: Editor | null) => void;
  save: (entry: MemoryAssociation, edit: boolean) => Promise<void>;
  remove: (entry: MemoryAssociation) => Promise<void>;
}) {
  const online = useMachineOnlineStatus(machineId) === 'online';
  const state = useMemoryProvider(machineId, provider.id, online && supported, refreshToken);
  return (
    <div {...stylex.props(styles.stack)}>
      {!online || !supported || (state.result && state.result.status !== 'ready') ? (
        <MemoryProviderStatus
          provider={provider}
          online={online}
          supported={supported}
          busy={false}
          result={state.result}
        />
      ) : null}
      <MemoryAssociationList
        entries={entries}
        inventory={state.result}
        getAssignedRoles={getAssignedRoles}
        onAssociateRole={onAssociateRole}
        onEdit={(entry) => setEditor({ providerId: provider.id, entry })}
        onRemove={(entry) => void remove(entry)}
      />
      {editor ? (
        <MemoryEditor
          key={editor.entry?.memoryId ?? 'new'}
          machineId={machineId}
          provider={provider}
          entry={editor.entry}
          entries={entries}
          online={online}
          supported={supported}
          state={state}
          onProvider={(providerId) => setEditor({ providerId })}
          onClose={() => setEditor(null)}
          save={save}
        />
      ) : null}
    </div>
  );
}

export function MemoryProviderStatus({
  provider,
  online,
  supported,
  busy,
  result,
}: {
  provider: ProviderDefinition;
  online: boolean;
  supported: boolean;
  busy: boolean;
  result?: MemoryProviderResponse;
}) {
  const { t } = useTranslation();
  if (!online) return <span {...stylex.props(catalog.meta)}>{t('settings.memory.offline')}</span>;
  if (!supported)
    return <span {...stylex.props(catalog.meta)}>{t('settings.memory.unsupported')}</span>;
  if (busy) return <Spinner size="small" />;
  if (result?.status === 'ready') return null;
  return (
    <div {...stylex.props(styles.stack)}>
      <span {...stylex.props(catalog.meta)}>
        {t(`settings.memory.status.${result?.status ?? 'error'}`)}
      </span>
      {result?.status === 'not_installed' && provider.installUrl ? (
        <Button
          type="button"
          variant="ghost"
          size="small"
          onClick={() => void openExternalUrl(provider.installUrl!)}
        >
          {t('settings.memory.install')}
        </Button>
      ) : null}
    </div>
  );
}

export function MemoryEditor({
  machineId,
  provider,
  entry,
  entries,
  online,
  supported,
  state,
  onProvider,
  onClose,
  save,
}: {
  machineId: MachineId;
  provider: ProviderDefinition;
  entry?: MemoryAssociation;
  entries: MemoryAssociation[];
  online: boolean;
  supported: boolean;
  state: ReturnType<typeof useMemoryProvider>;
  onProvider: (id: string) => void;
  onClose: () => void;
  save: (entry: MemoryAssociation, edit: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState('create');
  const identity = entry
    ? state.result?.memories.find((memory) => memory.id === entry.memoryId)
    : undefined;
  const hydrated = useRef(false);
  const [values, setValues] = useState<Record<string, string>>({
    id: entry?.memoryId ?? '',
    role: identity?.role ?? '',
    name: identity?.name ?? entry?.name ?? '',
    description: identity?.description ?? entry?.description ?? '',
  });
  useEffect(() => {
    if (identity && !hydrated.current) {
      hydrated.current = true;
      setValues({
        id: identity.id,
        name: identity.name,
        description: identity.description ?? '',
        role: identity.role ?? '',
      });
    }
  }, [identity]);
  const [selected, setSelected] = useState<string>();
  const [idEdited, setIdEdited] = useState(false);
  const [created, setCreated] = useState<MemoryIdentity>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const busy = saving || state.busy;
  const available = online && supported && state.result?.status === 'ready';
  const candidates =
    state.result?.memories.filter(
      (memory) => !entries.some((saved) => saved.memoryId === memory.id)
    ) ?? [];
  const submit = async () => {
    if (busy) return;
    setError(false);
    setSaving(true);
    try {
      let savedIdentity: MemoryIdentity | undefined;
      if (entry) {
        const result = await state.update(
          MemoryCreateInputSchema.parse({ ...values, id: entry.memoryId })
        );
        savedIdentity =
          result?.status === 'ready'
            ? result.memories.find((memory) => memory.id === entry.memoryId)
            : undefined;
      } else if (tab === 'link') {
        savedIdentity = candidates.find((memory) => memory.id === selected);
      } else {
        savedIdentity = created;
        if (!savedIdentity) {
          const input = MemoryCreateInputSchema.parse(values);
          const result = await state.create(input);
          savedIdentity =
            result?.status === 'ready'
              ? result.memories.find((memory) => memory.id === input.id)
              : undefined;
          if (savedIdentity) setCreated(savedIdentity);
        }
      }
      if (!savedIdentity) throw new Error('Memory identity unavailable');
      await save(
        {
          machineId,
          providerId: provider.id,
          memoryId: savedIdentity.id,
          name: savedIdentity.name,
          description: savedIdentity.description,
        },
        !!entry
      );
      onClose();
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <Dialog.Content
        style={{
          width: 'min(900px, 96dvw)',
          maxWidth: 'none',
          height: 'min(600px, 92dvh)',
          padding: 0,
          gap: 0,
          overflow: 'hidden',
        }}
      >
        <div {...stylex.props(styles.layout)}>
          <aside {...stylex.props(styles.rail)} aria-label={t('settings.memory.providers')}>
            <span {...stylex.props(catalog.meta, styles.railTitle)}>
              {t('settings.memory.providers')}
            </span>
            <div role="listbox" aria-label={t('settings.memory.providers')}>
              {MEMORY_PROVIDERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={item.id === provider.id}
                  disabled={(!!entry || busy) && item.id !== provider.id}
                  onClick={() => onProvider(item.id)}
                  {...stylex.props(
                    surface.listRow,
                    item.id === provider.id && surface.listRowSelected,
                    styles.railItem
                  )}
                >
                  <span {...stylex.props(styles.railIcon)}>
                    <MemoryProviderLogo providerId={item.id} />
                  </span>
                  <span {...stylex.props(surface.listRowLabel)}>{item.name}</span>
                </button>
              ))}
            </div>
          </aside>
          <section {...stylex.props(styles.detail)}>
            <Dialog.Header>
              <Dialog.Title>
                {t(entry ? 'settings.memory.edit' : 'settings.memory.add')}
              </Dialog.Title>
              <Dialog.Description>
                {t(entry ? 'settings.memory.editHint' : 'settings.memory.editorHint')}
              </Dialog.Description>
            </Dialog.Header>
            {!entry ? (
              <Tabs.Root
                value={tab}
                onValueChange={(value) => {
                  setTab(String(value));
                  setError(false);
                }}
              >
                <Tabs.List>
                  <Tabs.Tab value="create" disabled={busy}>
                    {t('settings.memory.createTab')}
                  </Tabs.Tab>
                  <Tabs.Tab value="link" disabled={busy}>
                    {t('settings.memory.linkTab')}
                  </Tabs.Tab>
                </Tabs.List>
              </Tabs.Root>
            ) : null}
            <form
              {...stylex.props(styles.form)}
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <div {...stylex.props(styles.scroll)}>
                {!entry || !available ? (
                  <MemoryProviderStatus
                    provider={provider}
                    online={online}
                    supported={supported}
                    busy={state.busy}
                    result={state.result}
                  />
                ) : null}
                {entry || (available && tab === 'create') ? (
                  <div {...stylex.props(styles.fields)}>
                    {provider.createFields.map((key) => (
                      <div
                        key={key}
                        {...stylex.props(key !== 'name' && key !== 'id' && styles.fullField)}
                      >
                        <Field
                          label={t(
                            key === 'name'
                              ? 'settings.memory.name'
                              : `settings.memory.fields.${key}`
                          )}
                        >
                          {key === 'description' ? (
                            <Textarea
                              aria-label={t(`settings.memory.fields.${key}`)}
                              value={values[key] ?? ''}
                              disabled={saving || !!created || (!!entry && !identity)}
                              onChange={(event) =>
                                setValues({ ...values, [key]: event.target.value })
                              }
                            />
                          ) : (
                            <Input
                              aria-label={t(
                                key === 'name'
                                  ? 'settings.memory.name'
                                  : `settings.memory.fields.${key}`
                              )}
                              required={key === 'id' || key === 'name'}
                              readOnly={!!entry && key === 'id'}
                              value={values[key] ?? ''}
                              disabled={saving || !!created || (!!entry && !identity)}
                              onChange={(event) => {
                                const value = event.target.value;
                                if (key === 'id') setIdEdited(value !== '');
                                setValues((previous) => ({
                                  ...previous,
                                  [key]: value,
                                  ...(key === 'name' && !idEdited && !entry
                                    ? { id: value.toLowerCase() }
                                    : {}),
                                }));
                              }}
                            />
                          )}
                        </Field>
                      </div>
                    ))}
                  </div>
                ) : null}
                {!entry && available && tab === 'link' ? (
                  <MemoryIdentityList
                    memories={state.result?.memories ?? []}
                    linkedIds={entries.map((saved) => saved.memoryId)}
                    selected={selected}
                    onSelect={setSelected}
                  />
                ) : null}
                {error ? (
                  <FormMessage tone="error">
                    {t(created ? 'settings.memory.createdSaveError' : 'settings.memory.saveError')}
                  </FormMessage>
                ) : null}
              </div>
              <Dialog.Footer>
                <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>
                  {t('common.cancel')}
                </Button>
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    (!!entry && (!available || !identity)) ||
                    (!entry &&
                      (!available ||
                        (tab === 'link' && !candidates.some((memory) => memory.id === selected))))
                  }
                >
                  {saving ? <Spinner size="small" /> : null}
                  {t(
                    entry
                      ? 'common.save'
                      : tab === 'create' && !created
                        ? 'settings.memory.createAndLink'
                        : 'settings.memory.import'
                  )}
                </Button>
              </Dialog.Footer>
            </form>
          </section>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}

export function RoleMemoryPicker({
  machineId,
  value,
  onChange,
}: {
  machineId: MachineId;
  value?: MemoryBinding;
  onChange: (value?: MemoryBinding) => void;
}) {
  const { t } = useTranslation();
  const { entries } = useMemoryAssociations(machineId);
  const { machines } = useVisibleMachineMetas();
  const supported = machineSupportsMemoryProviders(machines.get(machineId));
  return (
    <div {...stylex.props(styles.stack)}>
      <span {...stylex.props(catalog.meta)}>{t('settings.memory.rolePromptHint')}</span>
      {value ? (
        <div {...stylex.props(styles.unlinkRow)}>
          <Button type="button" size="small" variant="ghost" onClick={() => onChange(undefined)}>
            {t('settings.memory.unlink')}
          </Button>
        </div>
      ) : null}
      {!entries.length ? (
        <p {...stylex.props(catalog.meta)}>{t('settings.memory.emptyRole')}</p>
      ) : (
        MEMORY_PROVIDERS.map((provider) => (
          <RoleProviderMemories
            key={provider.id}
            machineId={machineId}
            provider={provider}
            entries={entries.filter((entry) => entry.providerId === provider.id)}
            supported={supported}
            value={value}
            onChange={onChange}
          />
        ))
      )}
    </div>
  );
}
function RoleProviderMemories({
  machineId,
  provider,
  entries,
  supported,
  value,
  onChange,
}: {
  machineId: MachineId;
  provider: ProviderDefinition;
  entries: MemoryAssociation[];
  supported: boolean;
  value?: MemoryBinding;
  onChange: (value: MemoryBinding) => void;
}) {
  const online = useMachineOnlineStatus(machineId) === 'online';
  const state = useMemoryProvider(machineId, provider.id, online && supported);
  return (
    <>
      {!online || !supported || (state.result && state.result.status !== 'ready') ? (
        <MemoryProviderStatus
          provider={provider}
          online={online}
          supported={supported}
          busy={false}
          result={state.result}
        />
      ) : null}
      <MemoryAssociationList
        entries={entries}
        inventory={state.result}
        selected={value}
        onSelect={(entry) => onChange({ providerId: entry.providerId, memoryId: entry.memoryId })}
      />
    </>
  );
}
