// @vitest-environment jsdom

// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentConfigId, AgentConfigMeta, MachineId, MachineViewMeta } from '@lody/shared';
import type { AgentSelection } from '../src/components/shared';
import type { AcpSelectorOptions } from '../src/components/shared/acp-selector-options';
import {
  useAcpSessionConfigSelectionState,
  useResolvedAcpSessionConfigSelection,
} from '../src/hooks/use-acp-session-config-selection';
import { useChatLandingDefaults } from '../src/hooks/use-chat-landing-defaults';
import {
  readChatLandingDefaults,
  recordChatLandingProjectUse,
  writeChatLandingDefaults,
} from '../src/lib/chat-landing-defaults';
import { agentDefaultsCache, persistAgentSessionDefaults } from '../src/lib/local-storage-cache';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const machineId = 'machine-1' as MachineId;
const agentId = 'agent-a' as AgentConfigId;

const selectorOptions = (
  authority: AcpSelectorOptions['capabilityAuthority'],
  models: string[],
  defaultModelId: string | null
): AcpSelectorOptions => ({
  capabilityAuthority: authority,
  modeOptions: [],
  modelOptions: models.map((value) => ({ value, label: value })),
  defaultModeId: null,
  defaultModelId,
  configOptionSelectors: [],
});

function DefaultsProbe({ options }: { options: AcpSelectorOptions }) {
  const controller = useAcpSessionConfigSelectionState({
    targetKey: `${machineId}:${agentId}`,
    preferenceRevision: agentId,
    preferences: agentDefaultsCache.get(agentId) ?? {},
  });
  const resolved = useResolvedAcpSessionConfigSelection(controller.selection, options);

  return (
    <>
      <output data-model={resolved.selectedModelId ?? ''} />
      <button type="button" onClick={() => controller.selectModel('gpt-5.5')}>
        Select 5.5
      </button>
    </>
  );
}

describe('chat landing agent session defaults', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('does not let provisional static options invalidate a saved model', () => {
    persistAgentSessionDefaults(agentId, { modelId: 'gpt-5.6-sol' });

    act(() => {
      root.render(
        <DefaultsProbe options={selectorOptions('provisional', ['gpt-5.5'], 'gpt-5.5')} />
      );
    });
    expect(container.querySelector('output')?.dataset.model).toBe('gpt-5.6-sol');

    act(() => {
      root.render(
        <DefaultsProbe
          options={selectorOptions('authoritative', ['gpt-5.6-sol', 'gpt-5.5'], 'gpt-5.6-sol')}
        />
      );
    });
    expect(container.querySelector('output')?.dataset.model).toBe('gpt-5.6-sol');
  });

  it('preserves a user selection made before runtime capabilities arrive', () => {
    persistAgentSessionDefaults(agentId, { modelId: 'gpt-5.6-sol' });
    act(() => {
      root.render(
        <DefaultsProbe options={selectorOptions('provisional', ['gpt-5.5'], 'gpt-5.5')} />
      );
    });
    act(() => {
      container.querySelector('button')?.click();
    });

    act(() => {
      root.render(
        <DefaultsProbe
          options={selectorOptions('authoritative', ['gpt-5.6-sol', 'gpt-5.5'], 'gpt-5.6-sol')}
        />
      );
    });
    expect(container.querySelector('output')?.dataset.model).toBe('gpt-5.5');
  });
});

describe('accepted project survives browsing/default persistence', () => {
  it('does not overwrite the last sent target when the mounted landing changes context', () => {
    localStorage.clear();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const noop = () => {};
    function Probe({ context }: { context: 'chat' | 'github' }) {
      useChatLandingDefaults({
        workspaceId: 'last-target-test',
        shouldRestoreContextType: false,
        contextType: context,
        setContextType: noop,
        executorConfigs: [],
        machines: new Map(),
        selectableMachines: new Map(),
        presenceSynced: false,
        visibleMachinesLoading: false,
        docMetaCacheReady: true,
        repositories: [],
        selectedAgent: null,
        setSelectedAgent: noop,
        selectedMachineId: null,
        selectedRepo: undefined,
        setSelectedRepo: noop,
        selectedBranch: null,
        setSelectedBranch: noop,
        selectedLocalProject: null,
        setSelectedLocalProject: noop,
        selectedLocalBranch: null,
        setSelectedLocalBranch: noop,
      });
      return null;
    }
    const local = { kind: 'local', machineId: 'machine-a', localProjectId: 'project-a' } as const;
    recordChatLandingProjectUse('last-target-test', local);
    try {
      act(() => root.render(<Probe context="chat" />));
      expect(readChatLandingDefaults('last-target-test')).toMatchObject({
        contextType: 'chat',
        lastUsedProject: local,
      });
      act(() => root.render(<Probe context="github" />));
      expect(readChatLandingDefaults('last-target-test')).toMatchObject({
        contextType: 'github',
        lastUsedProject: local,
      });
    } finally {
      act(() => root.unmount());
      container.remove();
      localStorage.clear();
    }
  });
});

describe('selected machine survives presence changes', () => {
  const workspaceId = 'selection-liveness-test';
  const local = 'machine-local' as MachineId;
  const remote = 'machine-remote' as MachineId;
  const other = 'machine-other' as MachineId;
  const localSelection = { agentId: 'config-local', machineId: local } as AgentSelection;
  const remoteSelection = { agentId: 'config-remote', machineId: remote } as AgentSelection;
  const otherSelection = { agentId: 'config-other', machineId: other } as AgentSelection;
  const allMachineIds = [local, remote, other];
  const noop = () => {};

  const configsFor = (machineIds: MachineId[]) =>
    machineIds.map((id) => ({
      id: id.replace('machine-', 'config-'),
      machineId: id,
      agentType: 'codex',
    })) as unknown as AgentConfigMeta[];
  const machinesFor = (machineIds: MachineId[]) =>
    new Map(machineIds.map((id) => [id, { id } as MachineViewMeta]));

  type ProbeProps = {
    online: MachineId[];
    presenceSynced: boolean;
    machineIds?: MachineId[];
  };
  let selected: AgentSelection | null = null;
  let select: (selection: AgentSelection) => void = noop;

  function Probe({ online, presenceSynced, machineIds = allMachineIds }: ProbeProps) {
    const [selectedAgent, setSelectedAgent] = useState<AgentSelection | null>(null);
    selected = selectedAgent;
    select = setSelectedAgent;
    useChatLandingDefaults({
      workspaceId,
      shouldRestoreContextType: false,
      contextType: 'chat',
      setContextType: noop,
      executorConfigs: configsFor(machineIds),
      machines: machinesFor(machineIds),
      selectableMachines: machinesFor(
        machineIds.filter((id) => id === local || online.includes(id))
      ),
      presenceSynced,
      visibleMachinesLoading: false,
      docMetaCacheReady: true,
      repositories: [],
      selectedAgent,
      setSelectedAgent,
      selectedMachineId: selectedAgent?.machineId ?? null,
      selectedRepo: undefined,
      setSelectedRepo: noop,
      selectedBranch: null,
      setSelectedBranch: noop,
      selectedLocalProject: null,
      setSelectedLocalProject: noop,
      selectedLocalBranch: null,
      setSelectedLocalBranch: noop,
    });
    return null;
  }

  let container: HTMLDivElement;
  let root: Root;
  const render = (props: ProbeProps) => act(() => root.render(<Probe {...props} />));
  const storedTarget = () => {
    const stored = readChatLandingDefaults(workspaceId);
    return { agentId: stored?.agentId, machineId: stored?.machineId };
  };

  beforeEach(() => {
    localStorage.clear();
    writeChatLandingDefaults(workspaceId, { ...remoteSelection });
    selected = null;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
  });

  it('keeps a confirmed remote selection when the machine leaves the online set', () => {
    render({ online: [remote], presenceSynced: true });
    expect(selected).toEqual(remoteSelection);

    render({ online: [], presenceSynced: true });
    expect(selected).toEqual(remoteSelection);
    expect(storedTarget()).toEqual(remoteSelection);

    render({ online: [], presenceSynced: false });
    expect(selected).toEqual(remoteSelection);
    expect(storedTarget()).toEqual(remoteSelection);
  });

  it('keeps a stored remote selection while presence cannot answer yet', () => {
    render({ online: [], presenceSynced: false });

    expect(selected).toEqual(remoteSelection);
    expect(storedTarget()).toEqual(remoteSelection);
  });

  it('falls back from a stored machine that is offline at startup and returns to it', () => {
    render({ online: [], presenceSynced: false });
    render({ online: [], presenceSynced: true });
    expect(selected).toEqual(localSelection);
    expect(storedTarget()).toEqual(remoteSelection);

    render({ online: [remote], presenceSynced: true });
    expect(selected).toEqual(remoteSelection);
    expect(storedTarget()).toEqual(remoteSelection);
  });

  it('gives up the remembered machine once the user chooses during a fallback', () => {
    render({ online: [other], presenceSynced: true });
    expect(selected).toEqual(localSelection);

    act(() => select(otherSelection));
    expect(storedTarget()).toEqual(otherSelection);

    render({ online: [other, remote], presenceSynced: true });
    expect(selected).toEqual(otherSelection);
    expect(storedTarget()).toEqual(otherSelection);
  });

  it('still replaces a selection whose machine no longer exists', () => {
    render({ online: [remote], presenceSynced: true });
    expect(selected).toEqual(remoteSelection);

    render({ online: [], presenceSynced: true, machineIds: [local] });
    expect(selected).toEqual(localSelection);
  });
});
