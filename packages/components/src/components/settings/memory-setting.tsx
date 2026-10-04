import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Check, Plus, RefreshCw } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Dialog } from '@lody/ui/dialog';
import { Input } from '@lody/ui/input';
import { Spinner } from '@lody/ui/spinner';
import { CompactRow, settingsRecordsCard } from './compact-layout';
import { settingsSurface as surface } from './surface';
import { space } from '@lody/ui/tokens/scales.stylex';
import {
  MEMORY_PROVIDERS,
  MemoryCreateInputSchema,
  machineSupportsMemoryProviders,
  type MachineId,
  type MemoryBinding,
  type MemoryIdentity,
  type MemoryProviderResponse,
} from '@lody/shared';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useMachineOnlineStatus } from '@/hooks/use-machine-online-status';
import { useMemoryProvider } from '@/hooks/use-memory-provider';
import { useAppCapability } from '@/lib/app-platform';
import { openExternalUrl } from '@/lib/native-browser';
import { MachinePills } from './machine-pills';
import { CollapsibleSection, Field, FormMessage } from './form-primitives';
import { SettingsPageLead } from './settings-page-header';

const styles = stylex.create({
  stack: { display: 'flex', flexDirection: 'column', gap: space[3] },
  row: { display: 'flex', alignItems: 'center', gap: space[2] },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space[3],
    padding: space[4],
  },
  identity: { display: 'flex', flexDirection: 'column', gap: space[1], overflowWrap: 'anywhere' },
});

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
  return (
    <div {...stylex.props(settingsRecordsCard)}>
      {memories.map((memory, index) => (
        <div key={memory.id} {...stylex.props(surface.line, index > 0 && surface.lineRuled)}>
          <CompactRow
            label={memory.name}
            helper={
              <span {...stylex.props(styles.identity)}>
                <span>{memory.id}</span>
                {memory.description ? <span>{memory.description}</span> : null}
              </span>
            }
          >
            {onSelect ? (
              <Button
                type="button"
                size="small"
                variant={selected === memory.id ? 'secondary' : 'ghost'}
                aria-label={t('settings.memory.linkName', { name: memory.name })}
                aria-pressed={selected === memory.id}
                onClick={() => onSelect(memory.id)}
              >
                {selected === memory.id ? <Check size={14} /> : null}
                {t(selected === memory.id ? 'settings.memory.linked' : 'settings.memory.link')}
              </Button>
            ) : null}
          </CompactRow>
        </div>
      ))}
    </div>
  );
}

export function MemorySetting() {
  const { t } = useTranslation();
  const { machines } = useVisibleMachineMetas();
  const localId = useAtomValue(localMachineIdAtom);
  const remote = useAppCapability('remoteMachines');
  const [selected, setSelected] = useState<MachineId | null>(null);
  const machineId = remote
    ? selected && machines.has(selected)
      ? selected
      : localId && machines.has(localId)
        ? localId
        : (machines.keys().next().value ?? null)
    : localId;
  return (
    <div {...stylex.props(styles.stack)}>
      <SettingsPageLead>{t('settings.memory.description')}</SettingsPageLead>
      {remote ? (
        <MachinePills
          pills={Array.from(machines, ([id, machine]) => ({ id, label: machine.name }))}
          selectedId={machineId}
          onSelect={(id) => setSelected(id as MachineId)}
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
        <p>{t('settings.memory.noMachine')}</p>
      )}
    </div>
  );
}

type Provider = (typeof MEMORY_PROVIDERS)[number];
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
  const online = useMachineOnlineStatus(machineId) === 'online';
  const { result, busy, refresh, create } = useMemoryProvider(
    machineId,
    provider.id,
    online && supported
  );
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<MemoryProviderResponse['status']>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState(false);
  useEffect(() => {
    if (result?.status === 'not_installed' || result?.status === 'not_running')
      setNotice(result.status);
  }, [result]);
  const createMemory = async () => {
    const parsed = MemoryCreateInputSchema.safeParse(values);
    if (!parsed.success) {
      setError(true);
      return;
    }
    const response = await create(parsed.data);
    if (response?.status === 'ready') {
      setOpen(false);
      setValues({});
      setError(false);
    } else setError(true);
  };
  const check = async (creating: boolean) => {
    const response = await refresh();
    if (response?.status === 'ready') {
      if (creating) setOpen(true);
    } else if (response) setNotice(response.status);
  };
  return (
    <>
      <MemoryProviderPanel
        provider={provider}
        online={online}
        supported={supported}
        busy={busy}
        result={result}
        onRefresh={() => void check(false)}
        onCreate={() => void check(true)}
      />
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>{t('settings.memory.create')}</Dialog.Title>
            <Dialog.Description>{provider.name}</Dialog.Description>
          </Dialog.Header>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void createMemory();
            }}
            {...stylex.props(styles.stack)}
          >
            {provider.createFields.map((key) => (
              <Field key={key} label={t(`settings.memory.fields.${key}`)}>
                <Input
                  aria-label={t(`settings.memory.fields.${key}`)}
                  required={key === 'id'}
                  value={values[key] ?? ''}
                  onChange={(event) => setValues({ ...values, [key]: event.target.value })}
                />
              </Field>
            ))}
            {error ? (
              <FormMessage tone="error">{t('settings.memory.createError')}</FormMessage>
            ) : null}
            <Button type="submit" disabled={busy}>
              {t('settings.memory.create')}
            </Button>
          </form>
        </Dialog.Content>
      </Dialog.Root>
      <Dialog.Root
        open={notice !== undefined}
        onOpenChange={(value) => {
          if (!value) setNotice(undefined);
        }}
      >
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>{provider.name}</Dialog.Title>
          </Dialog.Header>
          <MemoryStatus status={notice} installUrl={provider.installUrl} />
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
    <CollapsibleSection
      title={provider.name}
      defaultOpen
      action={
        <div {...stylex.props(styles.row)}>
          <Button
            type="button"
            size="small"
            variant="ghost"
            icon
            disabled={busy || !online || !supported}
            aria-label={t('settings.memory.refresh')}
            onClick={onRefresh}
          >
            <RefreshCw size={14} />
          </Button>
          <Button
            type="button"
            size="small"
            variant="ghost"
            icon
            disabled={busy || !online || !supported}
            aria-label={t('settings.memory.create')}
            onClick={onCreate}
          >
            <Plus size={14} />
          </Button>
        </div>
      }
    >
      {!online ? (
        <p>{t('settings.memory.offline')}</p>
      ) : !supported ? (
        <p>{t('settings.memory.unsupported')}</p>
      ) : busy ? (
        <Spinner />
      ) : result?.status === 'ready' ? (
        result.memories.length ? (
          <MemoryIdentityList memories={result.memories} />
        ) : (
          <div {...stylex.props(styles.empty)}>
            <p>{t('settings.memory.empty')}</p>
            <Button type="button" onClick={onCreate}>
              {t('settings.memory.create')}
            </Button>
          </div>
        )
      ) : (
        <MemoryStatus status={result?.status} installUrl={provider.installUrl} />
      )}
    </CollapsibleSection>
  );
}

function MemoryStatus({
  status,
  installUrl,
}: {
  status?: MemoryProviderResponse['status'];
  installUrl: string;
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.stack)}>
      <p>{t(`settings.memory.status.${status ?? 'error'}`)}</p>
      {status === 'not_installed' ? (
        <Button type="button" onClick={() => void openExternalUrl(installUrl)}>
          {t('settings.memory.install')}
        </Button>
      ) : null}
    </div>
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
    <div {...stylex.props(styles.stack)}>
      {value ? (
        <>
          <span>
            {value.providerId} / {value.memoryId}
          </span>
          <Button type="button" onClick={() => onChange(undefined)}>
            {t('settings.memory.unlink')}
          </Button>
        </>
      ) : null}
      {!online ? (
        <p>{t('settings.memory.offline')}</p>
      ) : !supported ? (
        <p>{t('settings.memory.unsupported')}</p>
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
    <div {...stylex.props(styles.stack)}>
      <div {...stylex.props(styles.row)}>
        <span>{provider.name}</span>
        <Button type="button" disabled={busy} onClick={() => void refresh()}>
          {t('settings.memory.refresh')}
        </Button>
      </div>
      {busy ? (
        <Spinner />
      ) : result?.status === 'ready' ? (
        <>
          <MemoryIdentityList
            memories={result.memories}
            selected={value?.providerId === provider.id ? value.memoryId : undefined}
            onSelect={(memoryId) => onChange({ providerId: provider.id, memoryId })}
          />
          {!result.memories.length ? <p>{t('settings.memory.emptyRole')}</p> : null}
        </>
      ) : (
        <MemoryStatus status={result?.status} installUrl={provider.installUrl} />
      )}
    </div>
  );
}
