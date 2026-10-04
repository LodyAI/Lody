import { useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Check, Plus, RefreshCw } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Spinner } from '@lody/ui/spinner';
import { Dialog } from '@/ui/dialog';
import {
  CompactRow,
  CompactSection,
  SettingsEmptyList,
  settingsRecordsCard,
} from './compact-layout';
import {
  SETTINGS_EDITOR_DIALOG_LAYOUT,
  SETTINGS_EDITOR_DIALOG_WIDTH,
  settingsCatalog as catalog,
  settingsSurface as surface,
} from './surface';
import { space } from '@lody/ui/tokens/scales.stylex';
import {
  MEMORY_PROVIDERS,
  MemoryCreateInputSchema,
  machineSupportsMemoryProviders,
  type MachineId,
  type MemoryBinding,
  type MemoryCreateInput,
  type MemoryIdentity,
  type MemoryProviderResponse,
} from '@lody/shared';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useMachineOnlineStatus, useOnlineMachineIds } from '@/hooks/use-machine-online-status';
import { useDialogExitSnapshot } from '@/hooks/use-dialog-exit-snapshot';
import { useMemoryProvider } from '@/hooks/use-memory-provider';
import { useAppCapability } from '@/lib/app-platform';
import { withClassName } from '@/lib/stylex';
import { openExternalUrl } from '@/lib/native-browser';
import { MachinePills } from './machine-pills';
import { Field, FormMessage, Section } from './form-primitives';
import { SettingsPageLead, useInSettingsPane, useSettingsPane } from './settings-page-header';
import { SettingsLineTabs } from './settings-line-tabs';

const styles = stylex.create({
  page: { display: 'flex', flexDirection: 'column', gap: space[4], width: '100%', minWidth: 0 },
});

type Provider = (typeof MEMORY_PROVIDERS)[number];

export function MemoryIdentityList({
  memories,
  selected,
  onSelect,
}: {
  memories: MemoryIdentity[];
  selected?: string;
  onSelect?: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (memories.length === 0) {
    return <SettingsEmptyList>{t('settings.memory.empty')}</SettingsEmptyList>;
  }
  return (
    <div {...stylex.props(settingsRecordsCard)}>
      {memories.map((memory, index) => (
        <div key={memory.id} {...stylex.props(surface.line, index > 0 && surface.lineRuled)}>
          <MemoryIdentityRow memory={memory} selected={selected} onSelect={onSelect} />
        </div>
      ))}
    </div>
  );
}

function MemoryIdentityRow({
  memory,
  selected,
  onSelect,
}: {
  memory: MemoryIdentity;
  selected?: string;
  onSelect?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const linked = selected === memory.id;
  return (
    <div {...stylex.props(catalog.row)}>
      {onSelect ? (
        <button
          type="button"
          onClick={() => onSelect(memory.id)}
          aria-label={t('settings.memory.linkName', { name: memory.name })}
          aria-pressed={linked}
          {...stylex.props(catalog.rowMain, surface.pressableLine)}
        >
          <MemoryIdentityCopy memory={memory} />
        </button>
      ) : (
        <div {...stylex.props(catalog.rowMain)}>
          <MemoryIdentityCopy memory={memory} />
        </div>
      )}
      {onSelect ? (
        <div {...stylex.props(catalog.actions)}>
          {linked ? (
            <Button type="button" size="small" variant="secondary" aria-pressed="true">
              <Check {...stylex.props(catalog.icon)} />
              {t('settings.memory.linked')}
            </Button>
          ) : (
            <Button type="button" size="small" variant="ghost" onClick={() => onSelect(memory.id)}>
              {t('settings.memory.link')}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function MemoryIdentityCopy({ memory }: { memory: MemoryIdentity }) {
  return (
    <span {...stylex.props(catalog.body)}>
      <span {...stylex.props(catalog.titleLine)}>
        <span {...stylex.props(catalog.name)}>{memory.name}</span>
      </span>
      <span {...stylex.props(catalog.meta)}>
        <span {...stylex.props(catalog.truncate, catalog.mono)}>{memory.id}</span>
      </span>
      {memory.description != null && memory.description.length > 0 ? (
        <span {...stylex.props(catalog.meta, catalog.metaHint)}>
          <span {...stylex.props(catalog.truncate)}>{memory.description}</span>
        </span>
      ) : null}
    </span>
  );
}

export function MemorySetting() {
  const { t } = useTranslation();
  const { machines, accessByMachineId } = useVisibleMachineMetas();
  const localId = useAtomValue(localMachineIdAtom);
  const onlineMachineIds = useOnlineMachineIds();
  const remote = useAppCapability('remoteMachines');
  const inSettingsPane = useInSettingsPane();
  const [selected, setSelected] = useState<MachineId | null>(null);
  const machineId = remote
    ? selected && machines.has(selected)
      ? selected
      : localId && machines.has(localId)
        ? localId
        : (machines.keys().next().value ?? null)
    : localId;
  const pills = useMemo(
    () =>
      [...machines.values()]
        .map((machine) => ({
          id: machine.id,
          label: machine.name || machine.id,
          online: onlineMachineIds.has(machine.id),
          private: !(accessByMachineId.get(machine.id)?.sharedWithTeam ?? false),
        }))
        .sort((left, right) => {
          if (left.online !== right.online) return left.online ? -1 : 1;
          return left.label.localeCompare(right.label);
        }) satisfies { id: MachineId; label: string; online: boolean; private: boolean }[],
    [accessByMachineId, machines, onlineMachineIds]
  );

  return (
    <div {...stylex.props(surface.container, styles.page)}>
      <SettingsPageLead>{t('settings.memory.description')}</SettingsPageLead>
      {remote && !inSettingsPane ? (
        <MachinePills
          pills={pills}
          selectedId={machineId}
          onSelect={(id) => setSelected(id as MachineId)}
        />
      ) : null}
      {remote && inSettingsPane && pills.length > 1 && machineId ? (
        <SettingsLineTabs
          ruled
          label={t('settings.agent.machineTabs.machine', 'Machine')}
          current={machineId}
          onChange={setSelected}
          overflow={{
            label: (count) => t('settings.agent.machineTabs.more', '{{count}} more', { count }),
            searchPlaceholder: t('settings.agent.machineTabs.search', 'Search machines'),
          }}
          tabs={pills.map((pill) => ({
            id: pill.id,
            label: pill.label,
            leading: (
              <span
                aria-hidden="true"
                {...stylex.props(catalog.statusDot, pill.online && catalog.statusDotOnline)}
              />
            ),
          }))}
        />
      ) : null}
      {machineId ? (
        MEMORY_PROVIDERS.map((provider) => (
          <MemoryProviderSection
            key={`${machineId}:${provider.id}`}
            machineId={machineId}
            provider={provider}
            supported={machineSupportsMemoryProviders(machines.get(machineId))}
          />
        ))
      ) : (
        <SettingsEmptyList>{t('settings.memory.noMachine')}</SettingsEmptyList>
      )}
    </div>
  );
}

function MemoryProviderSection({
  machineId,
  provider,
  supported,
}: {
  machineId: MachineId;
  provider: Provider;
  supported: boolean;
}) {
  const { t } = useTranslation();
  const settingsPane = useSettingsPane();
  const online = useMachineOnlineStatus(machineId) === 'online';
  const { result, busy, refresh, create } = useMemoryProvider(
    machineId,
    provider.id,
    online && supported
  );
  const [open, setOpen] = useState(false);
  const { shown, onOpenChangeComplete } = useDialogExitSnapshot(open ? provider : null);
  const openCreate = async () => {
    if (result?.status === 'ready') {
      setOpen(true);
      return;
    }
    const response = await refresh();
    if (response?.status === 'ready') setOpen(true);
  };

  return (
    <>
      <MemoryProviderPanel
        provider={provider}
        online={online}
        supported={supported}
        busy={busy}
        result={result}
        onRefresh={() => void refresh()}
        onCreate={() => void openCreate()}
      />
      <Dialog.Root open={open} onOpenChange={setOpen} onOpenChangeComplete={onOpenChangeComplete}>
        <Dialog.Content
          width={SETTINGS_EDITOR_DIALOG_WIDTH}
          centerOn={settingsPane}
          className={SETTINGS_EDITOR_DIALOG_LAYOUT}
        >
          <Dialog.Header>
            <Dialog.Title>{t('settings.memory.create')}</Dialog.Title>
            <Dialog.Description>{provider.name}</Dialog.Description>
          </Dialog.Header>
          {shown ? (
            <MemoryCreateForm
              provider={shown}
              busy={busy}
              onCancel={() => setOpen(false)}
              onCreated={() => {
                setOpen(false);
              }}
              create={create}
            />
          ) : null}
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}

export function MemoryProviderPanel({
  provider,
  online,
  supported,
  busy,
  result,
  onRefresh,
  onCreate,
}: {
  provider: Provider;
  online: boolean;
  supported: boolean;
  busy: boolean;
  result?: MemoryProviderResponse;
  onRefresh: () => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation();
  return (
    <CompactSection
      title={provider.name}
      boxed
      actions={[
        <Button
          key="refresh"
          type="button"
          size="small"
          variant="ghost"
          icon
          disabled={busy || !online || !supported}
          aria-label={t('settings.memory.refresh')}
          onClick={onRefresh}
        >
          <RefreshCw {...stylex.props(catalog.icon)} />
        </Button>,
        <Button
          key="create"
          type="button"
          size="small"
          variant="ghost"
          icon
          disabled={
            busy || !online || !supported || (result !== undefined && result.status !== 'ready')
          }
          aria-label={t('settings.memory.create')}
          onClick={onCreate}
        >
          <Plus {...stylex.props(catalog.icon)} />
        </Button>,
      ]}
    >
      {memoryProviderState(t, {
        online,
        supported,
        busy,
        result,
        installUrl: provider.installUrl,
        onCreate,
      })}
    </CompactSection>
  );
}

function memoryProviderState(
  t: ReturnType<typeof useTranslation>['t'],
  {
    online,
    supported,
    busy,
    result,
    installUrl,
    onCreate,
    selected,
    onSelect,
    emptyRole,
  }: {
    online: boolean;
    supported: boolean;
    busy: boolean;
    result?: MemoryProviderResponse;
    installUrl: string;
    onCreate?: () => void;
    selected?: string;
    onSelect?: (id: string) => void;
    emptyRole?: boolean;
  }
): ReactNode {
  if (!online) {
    return <MemoryCatalogNote>{t('settings.memory.offline')}</MemoryCatalogNote>;
  }
  if (!supported) {
    return <MemoryCatalogNote>{t('settings.memory.unsupported')}</MemoryCatalogNote>;
  }
  if (busy && !result) {
    return (
      <MemoryCatalogNote>
        <Spinner size="small" />
      </MemoryCatalogNote>
    );
  }
  if (result?.status === 'ready') {
    if (result.memories.length) {
      return result.memories.map((memory) => (
        <MemoryIdentityRow
          key={memory.id}
          memory={memory}
          selected={selected}
          onSelect={onSelect}
        />
      ));
    }
    return (
      <MemoryCatalogNote
        action={
          onCreate ? (
            <Button type="button" size="small" variant="secondary" onClick={onCreate}>
              {t('settings.memory.create')}
            </Button>
          ) : undefined
        }
      >
        {t(emptyRole === true ? 'settings.memory.emptyRole' : 'settings.memory.empty')}
      </MemoryCatalogNote>
    );
  }
  return <MemoryStatus status={result?.status} installUrl={installUrl} />;
}

export function MemoryStatus({
  status,
  installUrl,
}: {
  status?: MemoryProviderResponse['status'];
  installUrl: string;
}) {
  const { t } = useTranslation();
  return (
    <MemoryCatalogNote
      action={
        status === 'not_installed' ? (
          <Button
            type="button"
            size="small"
            variant="secondary"
            onClick={() => void openExternalUrl(installUrl)}
          >
            {t('settings.memory.install')}
          </Button>
        ) : undefined
      }
    >
      {t(`settings.memory.status.${status ?? 'error'}`)}
    </MemoryCatalogNote>
  );
}

function MemoryCatalogNote({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return action != null ? (
    <div {...stylex.props(surface.cardNote, surface.cardNoteWithAction)}>
      <span>{children}</span>
      {action}
    </div>
  ) : (
    <p {...stylex.props(surface.cardNote)}>{children}</p>
  );
}

function MemoryCreateForm({
  provider,
  busy,
  create,
  onCreated,
  onCancel,
}: {
  provider: Provider;
  busy: boolean;
  create: (input: MemoryCreateInput) => Promise<MemoryProviderResponse | undefined>;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = MemoryCreateInputSchema.safeParse(
      Object.fromEntries(
        Object.entries(values)
          .map(([key, value]) => [key, value.trim()] as const)
          .filter(([key, value]) => key === 'id' || value.length > 0)
      )
    );
    if (!parsed.success) {
      setError(true);
      return;
    }
    const response = await create(parsed.data);
    if (response?.status === 'ready') {
      setError(false);
      onCreated();
      return;
    }
    setError(true);
  };
  return (
    <form {...stylex.props(catalog.editorForm)} onSubmit={(event) => void submit(event)}>
      <div {...withClassName(stylex.props(catalog.editorBody), 'scrollbar-pro')}>
        <Section title={provider.name}>
          {provider.createFields.map((key) => (
            <Field
              key={key}
              htmlFor={`${fieldId}-${key}`}
              label={t(`settings.memory.fields.${key}`)}
            >
              <Input
                id={`${fieldId}-${key}`}
                aria-label={t(`settings.memory.fields.${key}`)}
                required={key === 'id'}
                autoComplete="off"
                value={values[key] ?? ''}
                onChange={(event) => setValues({ ...values, [key]: event.target.value })}
              />
            </Field>
          ))}
        </Section>
        {error ? <FormMessage tone="error">{t('settings.memory.createError')}</FormMessage> : null}
      </div>
      <Dialog.Footer>
        <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? <Spinner size="small" aria-hidden="true" /> : null}
          {t('settings.memory.create')}
        </Button>
      </Dialog.Footer>
    </form>
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
  const { machines } = useVisibleMachineMetas();
  const online = useMachineOnlineStatus(machineId) === 'online';
  const supported = machineSupportsMemoryProviders(machines.get(machineId));
  return (
    <div {...stylex.props(catalog.stack)}>
      {value ? (
        <CompactRow label={`${value.providerId} / ${value.memoryId}`}>
          <Button type="button" size="small" variant="ghost" onClick={() => onChange(undefined)}>
            {t('settings.memory.unlink')}
          </Button>
        </CompactRow>
      ) : null}
      {!online ? (
        <SettingsEmptyList>{t('settings.memory.offline')}</SettingsEmptyList>
      ) : !supported ? (
        <SettingsEmptyList>{t('settings.memory.unsupported')}</SettingsEmptyList>
      ) : (
        MEMORY_PROVIDERS.map((provider) => (
          <RoleProviderMemories
            key={`${machineId}:${provider.id}`}
            machineId={machineId}
            provider={provider}
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
  value,
  onChange,
}: {
  machineId: MachineId;
  provider: Provider;
  value?: MemoryBinding;
  onChange: (value: MemoryBinding) => void;
}) {
  const { t } = useTranslation();
  const { result, busy, refresh } = useMemoryProvider(machineId, provider.id, true);
  return (
    <CompactSection
      title={provider.name}
      boxed
      actions={
        <Button
          type="button"
          size="small"
          variant="ghost"
          icon
          disabled={busy}
          aria-label={t('settings.memory.refresh')}
          onClick={() => void refresh()}
        >
          <RefreshCw {...stylex.props(catalog.icon)} />
        </Button>
      }
    >
      {memoryProviderState(t, {
        online: true,
        supported: true,
        busy,
        result,
        installUrl: provider.installUrl,
        emptyRole: true,
        selected: value?.providerId === provider.id ? value.memoryId : undefined,
        onSelect: (memoryId) => onChange({ providerId: provider.id, memoryId }),
      })}
    </CompactSection>
  );
}
