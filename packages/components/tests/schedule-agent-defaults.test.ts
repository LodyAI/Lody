// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACP_CAPABILITY_CACHE_VERSION,
  getAcpCapabilityCacheKey,
  getServerNow,
  hasExplicitSchedulePermission,
  type AgentConfigMeta,
  type MachineViewMeta,
} from '@lody/shared';
import { agentDefaultsCache } from '../src/lib/local-storage-cache';
import { writeChatLandingDefaults } from '../src/lib/chat-landing-defaults';
import {
  pickScheduleAgent,
  seedScheduleAgentRunRef,
} from '../src/components/schedules/schedule-agent-defaults';

const agent = (id: string, machineId: string) =>
  ({ id, machineId, name: id, cliType: 'custom', agentType: 'acp' }) as unknown as AgentConfigMeta;

const machine = (id: string, capabilities: Record<string, unknown> = {}) =>
  ({
    id,
    name: id,
    ownerUserId: 'owner',
    acpCapabilities: capabilities,
  }) as unknown as MachineViewMeta;

afterEach(() => localStorage.clear());

describe('a new schedule starts from the chat landing’s choices', () => {
  it('reuses the landing’s remembered Agent when it runs on one of the person’s machines', () => {
    writeChatLandingDefaults('ws', { agentId: 'writer', machineId: 'studio' });
    const machines = new Map([
      ['macbook', machine('macbook')],
      ['studio', machine('studio')],
    ]);
    const agents = [agent('reviewer', 'macbook'), agent('writer', 'studio')];
    expect(
      pickScheduleAgent({
        landing: { agentId: 'writer', machineId: 'studio' },
        agents,
        machines,
      })?.id
    ).toBe('writer');
    // A remembered Agent on someone else's machine is not offered.
    expect(
      pickScheduleAgent({
        landing: { agentId: 'writer', machineId: 'studio' },
        agents,
        machines: new Map([['macbook', machines.get('macbook')!]]),
      })?.id
    ).toBe('reviewer');
  });

  it('fills the remembered model and permission, and drops credentials', () => {
    const config = agent('reviewer', 'macbook');
    const host = machine('macbook', {
      [getAcpCapabilityCacheKey('reviewer')]: {
        modes: [
          { id: 'ask', name: 'Ask' },
          { id: 'auto', name: 'Auto' },
        ],
        models: [],
        configOptions: [],
        cliType: 'custom',
        agentType: 'acp',
        cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
        provenance: 'runtime',
        updatedAt: getServerNow(),
      },
    });
    // A probed custom agent publishes its permission as the `mode` option.
    agentDefaultsCache.set('reviewer', {
      modeId: null,
      modelId: 'sonnet',
      configOptionValues: { mode: 'auto', verbose: true, api_key: 'secret' },
    });
    expect(seedScheduleAgentRunRef(config, host)).toEqual({
      agentConfigId: 'reviewer',
      modelId: 'sonnet',
      configOptionValues: { mode: 'auto', verbose: 'true' },
    });
  });

  it('shows the Agent’s default permission when nothing was remembered', () => {
    const config = agent('reviewer', 'macbook');
    const host = machine('macbook', {
      [getAcpCapabilityCacheKey('reviewer')]: {
        modes: [],
        models: [],
        // Probed agents advertise their permission as a `mode` config option.
        configOptions: [
          {
            id: 'mode',
            name: 'Mode',
            category: 'mode',
            type: 'select',
            currentValue: 'ask',
            options: [
              { value: 'ask', name: 'Ask' },
              { value: 'auto', name: 'Auto' },
            ],
          },
        ],
        cliType: 'custom',
        agentType: 'acp',
        cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
        provenance: 'runtime',
        updatedAt: getServerNow(),
      },
    });
    const seeded = seedScheduleAgentRunRef(config, host);
    expect(seeded.configOptionValues).toEqual({ mode: 'ask' });
    // …which is exactly what the save rule accepts as a chosen permission.
    expect(
      hasExplicitSchedulePermission(
        seeded,
        host.acpCapabilities![getAcpCapabilityCacheKey('reviewer')]
      )
    ).toBe(true);
  });
});
