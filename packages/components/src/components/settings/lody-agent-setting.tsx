import { useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { v4 as uuidv4 } from 'uuid';
import {
  machineSupportsProtocolCapability,
  machineSupportsProviderSetupProtocol,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
  type MachineViewMeta,
  type ProviderSetupTask,
} from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Select } from '@lody/ui/select';
import { space } from '@lody/ui/tokens/scales.stylex';
import {
  cmdCreateProviderSetupAtom,
  cmdRetryProviderSetupAtom,
  deleteProviderSetupAtom,
  getAgentConfigsByMachineAtomFamily,
  getProviderSetupsByMachineAtomFamily,
} from '@/atoms/agents';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { lodyAgentFeatureEnabledAtom } from '@/atoms/settings';
import { useMachineFlockAgentConfigsForMachineIds } from '@/hooks/use-machine-flock-agent-configs';
import { useRefreshMachineAcpCapabilities } from '@/hooks/use-refresh-machine-acp-capabilities';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { toast } from '@/lib/toast';
import { AcpAuthenticationPanel } from './acp-authentication-panel';
import { CompactSection, SettingsEmptyList } from './compact-layout';
import { LodyAgentConnectionsController } from './lody-agent-connections-controller';
import { ProviderSetupRow } from './provider-setup-row';
import { SettingsPageActions } from './settings-page-header';
import { settingsSurface as surface } from './surface';

export type LodyAgentState =
  | { kind: 'unsupported' }
  | { kind: 'absent' }
  | { kind: 'setup'; setup: ProviderSetupTask }
  | { kind: 'ready'; config: AgentConfigMeta };

const isLodyAgent = (config: Pick<AgentConfigMeta, 'cliType' | 'agentType'>) =>
  config.cliType === 'builtin' && config.agentType === 'sorbet';

/**
 * What the page shows for one machine. A published config wins over its setup row,
 * which can outlive publication until the daemon clears it; with several configs the
 * lowest id is used so every window settles on the same one.
 */
export function resolveLodyAgentState({
  machine,
  configs,
  setups,
}: {
  machine: MachineViewMeta;
  configs: readonly AgentConfigMeta[];
  setups: readonly ProviderSetupTask[];
}): LodyAgentState {
  const config = configs
    .filter((item) => item.machineId === machine.id && isLodyAgent(item))
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  if (config) return { kind: 'ready', config };
  const setup = setups.find((item) => item.machineId === machine.id && isLodyAgent(item.config));
  if (setup) return { kind: 'setup', setup };
  return machineSupportsProviderSetupProtocol(machine)
    ? { kind: 'absent' }
    : { kind: 'unsupported' };
}

const styles = stylex.create({
  page: { display: 'flex', flexDirection: 'column', gap: space[6] },
});

/** Settings > Lody Agent: where Lody's own agent gets its models, per machine. */
export function LodyAgentSetting() {
  const { t } = useTranslation();
  const enabled = useAtomValue(lodyAgentFeatureEnabledAtom);
  const { machines, isLoading } = useVisibleMachineMetas();
  const localMachineId = useAtomValue(localMachineIdAtom);
  const machineIds = useMemo(() => [...machines.keys()], [machines]);
  useMachineFlockAgentConfigsForMachineIds(machineIds);
  const [chosen, setChosen] = useState<MachineId | null>(null);
  const machineId =
    chosen && machines.has(chosen)
      ? chosen
      : localMachineId && machines.has(localMachineId)
        ? localMachineId
        : (machineIds[0] ?? null);
  const machine = machineId ? machines.get(machineId) : undefined;

  if (!enabled) {
    return (
      <div {...stylex.props(surface.container)}>
        <SettingsEmptyList>{t('lodyAgentSetting.disabled')}</SettingsEmptyList>
      </div>
    );
  }
  if (!machine) {
    return (
      <div {...stylex.props(surface.container)}>
        <SettingsEmptyList>
          {isLoading ? null : t('workspace.machines.empty', 'No machines connected')}
        </SettingsEmptyList>
      </div>
    );
  }
  return (
    <div {...stylex.props(surface.container, styles.page)}>
      {machines.size > 1 ? (
        <SettingsPageActions>
          <Select.Root
            items={machineIds.map((id) => ({ value: id, label: machines.get(id)?.name ?? id }))}
            value={machine.id}
            onValueChange={(next) => {
              if (next) setChosen(next as MachineId);
            }}
          >
            <Select.Trigger size="small" aria-label={t('lodyAgentSetting.machine')}>
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {machineIds.map((id) => (
                <Select.Item key={id} value={id}>
                  {machines.get(id)?.name ?? id}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </SettingsPageActions>
      ) : null}
      <LodyAgentMachine key={machine.id} machine={machine} />
    </div>
  );
}

function LodyAgentMachine({ machine }: { machine: MachineViewMeta }) {
  const { t } = useTranslation();
  const configs = useAtomValue(getAgentConfigsByMachineAtomFamily(machine.id));
  const setups = useAtomValue(getProviderSetupsByMachineAtomFamily(machine.id));
  const createSetup = useSetAtom(cmdCreateProviderSetupAtom);
  const retrySetup = useSetAtom(cmdRetryProviderSetupAtom);
  const deleteSetup = useSetAtom(deleteProviderSetupAtom);
  const refreshCapabilities = useRefreshMachineAcpCapabilities();
  const [starting, setStarting] = useState(false);
  const [connectionsVersion, setConnectionsVersion] = useState(0);
  const state = resolveLodyAgentState({ machine, configs, setups });

  if (state.kind === 'unsupported') {
    return (
      <SettingsEmptyList>
        {t('lodyAgentSetting.unsupported', { machine: machine.name })}
      </SettingsEmptyList>
    );
  }
  if (state.kind === 'absent') {
    return (
      <SettingsEmptyList
        action={
          <Button
            size="small"
            disabled={starting}
            onClick={async () => {
              setStarting(true);
              try {
                await createSetup({
                  id: uuidv4() as AgentConfigId,
                  machineId: machine.id,
                  name: 'Lody Agent',
                  description: undefined,
                  cliType: 'builtin',
                  agentType: 'sorbet',
                  env: {},
                });
              } catch {
                toast.error(t('lodyAgentSetting.setUpFailed'));
              } finally {
                setStarting(false);
              }
            }}
          >
            {t('lodyAgentSetting.setUp')}
          </Button>
        }
      >
        {t('lodyAgentSetting.setUpOn', { machine: machine.name })}
      </SettingsEmptyList>
    );
  }
  if (state.kind === 'setup') {
    return (
      <CompactSection boxed>
        <ProviderSetupRow
          setup={state.setup}
          machine={machine}
          onRetry={async (setup) => {
            await retrySetup(setup.id);
          }}
          onDelete={async (setup) => {
            await deleteSetup(setup.id);
          }}
        />
      </CompactSection>
    );
  }
  const { config } = state;
  return (
    <>
      <LodyAgentConnectionsController
        key={config.id}
        machineId={machine.id}
        configId={config.id}
        supported={
          machineSupportsProtocolCapability(machine, 'sorbetCredentials', 1) ||
          machineSupportsProtocolCapability(machine, 'sorbetCredentialsRemote', 1)
        }
        refreshVersion={connectionsVersion}
        signIn={(providerIds) => (
          <AcpAuthenticationPanel
            machineId={machine.id}
            configId={config.id}
            cliType={config.cliType}
            agentType={config.agentType}
            providerName={config.name}
            runtimeOverrides={config.runtimeOverrides}
            env={config.env}
            compact
            layout="rows"
            excludedMethodIds={providerIds.map((id) => `sorbet:${id}:api_key`)}
            onAuthenticated={() => setConnectionsVersion((version) => version + 1)}
          />
        )}
        endpointSignIn={(providerId) => (
          <AcpAuthenticationPanel
            machineId={machine.id}
            configId={config.id}
            cliType={config.cliType}
            agentType={config.agentType}
            providerName={config.name}
            compact
            layout="action"
            onlyMethodId={`sorbet:${providerId}:api_key`}
            onAuthenticated={() => setConnectionsVersion((version) => version + 1)}
          />
        )}
        onProvidersChanged={async () => {
          const response = await refreshCapabilities({
            machineId: machine.id,
            configId: config.id,
          });
          // A Provider without credentials makes the agent require sign-in. That is the
          // expected next step, not a failure; anything else must be visible.
          if (!response.success && !response.authRequired)
            throw new Error(response.error ?? 'ACP credential discovery failed');
          setConnectionsVersion((version) => version + 1);
        }}
      />
    </>
  );
}
