import type { z } from 'zod/v4';
import type { Flock } from '@loro-dev/flock-wasm/base64';
import type {
  AgentProvidersParams,
  AgentProvidersResult,
  ProviderItem,
  ProviderSetup,
} from '../contract/settings.ts';
import type { MachinePresence } from '../models/machines.ts';
import { encodeFrame } from '../frames';
import { openSettings, settingsRows } from './settings';
import { machineRpc } from './machine-rpc';
import { registryProviderCatalog } from '../protocol/provider-catalog';
import {
  applyProviderAdvanced,
  providerRevision,
  presetCatalog,
} from './provider-detail';

type Request = z.infer<typeof AgentProvidersParams>;
type Result = z.infer<typeof AgentProvidersResult>;
type Item = z.infer<typeof ProviderItem>;
type Setup = z.infer<typeof ProviderSetup>;
type Grant = () => Promise<{ token: string; gatewayBaseUrl: string }>;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
const managed = new Set(['kimi', 'devin', 'grok', 'claude', 'codex', 'pi']);
const builtinNames: Record<string, string> = {
  deepseek: 'DeepSeek Harness',
  sorbet: 'Lody Agent',
  claude: 'Claude Code',
  codex: 'Codex',
  kimi: 'Kimi Code',
  grok: 'Grok',
  devin: 'Devin',
  pi: 'Pi',
  bub: 'Bub',
  dimcode: 'Dimcode',
};
const catalog = [
  ...Object.entries(builtinNames).map(([agentType, name]) => ({
    id: agentType,
    name,
    cliType: 'builtin',
    agentType,
  })),
  ...registryProviderCatalog,
  ...presetCatalog().map((p) => ({
    id: p.id,
    name: p.name,
    cliType: p.cliType,
    agentType: p.agentType,
    presetId: p.id,
  })),
  {
    id: 'custom',
    name: 'Custom ACP Provider',
    cliType: 'custom',
    agentType: 'custom',
  },
];
const statuses = new Set([
  'queued',
  'preparing-runtime',
  'verifying',
  'awaiting-auth',
  'failed',
]);
const failures = new Set([
  'runtime-unavailable',
  'runtime-install-failed',
  'verification-failed',
]);
const editable = [
  'name',
  'prompt',
  'cliType',
  'agentType',
  'command',
  'args',
] as const;

export function providerRows(
  flock: Flock,
  machineId: string,
  readOnly: boolean,
): { providers: Item[]; setups: Setup[] } {
  const providers: Item[] = [],
    setups: Setup[] = [];
  for (const row of flock.scan()) {
    if (row.key.length !== 2) continue;
    const value = object(row.value),
      id = text(row.key[1]);
    if (!id || value.id !== id || value.machineId !== machineId) continue;
    if (row.key[0] === 'agentConfig') {
      const launch = object(value.customAcp);
      providers.push({
        id,
        machineId,
        name: text(value.name),
        prompt: text(value.prompt),
        cliType: text(value.cliType),
        agentType: text(value.agentType),
        command: text(launch.command),
        args: strings(launch.args),
        readOnly,
      });
    } else if (
      row.key[0] === 'providerSetup' &&
      value.v === 1 &&
      statuses.has(text(value.status)) &&
      Number.isInteger(value.attempt) &&
      Number(value.attempt) >= 1 &&
      !flock.get(['providerSetupCancellation', id])
    ) {
      const config = object(value.config);
      if (config.id !== id || config.machineId !== machineId) continue;
      setups.push({
        id,
        machineId,
        name: text(config.name),
        agentType: text(config.agentType),
        status: value.status as Setup['status'],
        attempt: Number(value.attempt),
        canRetry: !readOnly && value.status === 'failed',
        canDelete: !readOnly,
        ...(failures.has(text(value.failureCode))
          ? { failureCode: text(value.failureCode) }
          : {}),
      });
    }
  }
  providers.sort((a, b) => a.name.localeCompare(b.name));
  return { providers, setups };
}
function sameProvider(current: Item | undefined, base: Item) {
  if (
    !current ||
    current.id !== base.id ||
    current.machineId !== base.machineId ||
    editable.some(
      (key) => JSON.stringify(current[key]) !== JSON.stringify(base[key]),
    )
  )
    throw new Error('provider_conflict');
}
function removeProvider(
  flock: Flock,
  id: string,
  machineId: string,
  now: number,
) {
  const config = object(flock.get(['agentConfig', id]));
  if (
    config.id === id &&
    config.machineId === machineId &&
    config.cliType === 'builtin' &&
    managed.has(text(config.agentType))
  ) {
    const other = providerRows(flock, machineId, false).providers.some(
      (item) =>
        item.id !== id &&
        item.cliType === 'builtin' &&
        item.agentType === config.agentType,
    );
    const key = ['builtinAgentOptOut', text(config.agentType)];
    if (!other && !flock.get(key)) flock.set(key, { v: 1, removedAt: now });
  }
  flock.delete(['agentConfig', id]);
  // Provider-scoped quota must not survive removal; legacy quota is independent.
  for (const row of flock.scan())
    if (row.key[0] === 'rateLimit' && row.key.length === 4 && row.key[1] === id)
      flock.delete(row.key);
}

/** Apply only fresh, owner-authorized intent. Opaque environment/auth fields stay in Flock. */
export function changeProvider(
  flock: Flock,
  request: Exclude<Request, { action: 'list' | 'refresh' }>,
  supportsSetup: boolean,
  now: number,
  protocol: Record<string, unknown> = {},
) {
  const machineId =
    request.action === 'save'
      ? request.machineId
      : request.action === 'delete'
        ? request.base.machineId
        : request.setup.machineId;
  const rows = providerRows(flock, machineId, false);
  if (request.action === 'save') {
    const { fields, id, base } = request;
    if (
      Object.values(fields).some(
        (value) => typeof value === 'string' && value.includes('\0'),
      ) ||
      fields.args.some((value) => value.includes('\0')) ||
      !fields.name.trim()
    )
      throw new Error('invalid_provider');
    let config: Record<string, Exclude<Parameters<Flock['set']>[1], undefined>>;
    if (base) {
      if (base.machineId !== machineId || base.id !== id)
        throw new Error('provider_conflict');
      sameProvider(
        rows.providers.find((item) => item.id === id),
        base,
      );
      if (
        fields.cliType !== base.cliType ||
        fields.agentType !== base.agentType
      )
        throw new Error('provider_identity_immutable');
      config = { ...object(flock.get(['agentConfig', id])) } as typeof config;
    } else {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          id,
        )
      )
        throw new Error('invalid_provider');
      if (
        flock.get(['agentConfig', id]) ||
        flock.get(['providerSetup', id]) ||
        flock.get(['providerSetupCancellation', id])
      )
        throw new Error('provider_conflict');
      if (!['builtin', 'registry', 'custom'].includes(fields.cliType))
        throw new Error('provider_not_supported');
      if (
        fields.cliType === 'registry' &&
        !registryProviderCatalog.some(
          (item) => item.agentType === fields.agentType,
        )
      )
        throw new Error('provider_not_supported');
      if (
        fields.cliType === 'builtin' &&
        !Object.hasOwn(builtinNames, fields.agentType)
      )
        throw new Error('provider_setup_unsupported');
      config = {
        id,
        machineId,
        cliType: fields.cliType,
        agentType: fields.agentType,
        env: {},
      };
      if (fields.cliType === 'custom') config.agentType = `custom-${id}`;
    }
    if (
      fields.titleGeneration?.action === 'set' &&
      object(flock.get(['acpCapability', id])).sessionTitle === true &&
      !(config.cliType === 'builtin' && config.agentType === 'codex')
    )
      throw new Error('provider_title_managed');
    applyProviderAdvanced(
      config,
      fields,
      !!base,
      providerRevision(flock),
      protocol,
    );
    config.name = fields.name.trim();
    config.prompt = fields.prompt;
    if (fields.cliType === 'custom') {
      if (!fields.command.trim()) throw new Error('invalid_provider_command');
      config.customAcp = {
        ...object(config.customAcp),
        command: fields.command.trim(),
        args: fields.args,
      } as Exclude<Parameters<Flock['set']>[1], undefined>;
    } else if (fields.command || fields.args.length)
      throw new Error('invalid_provider_command');
    if (
      !base &&
      fields.cliType === 'builtin' &&
      supportsSetup &&
      fields.agentType !== 'deepseek' &&
      (!Object.values(object(config.runtimeOverrides)).some((v) =>
        Array.isArray(v) ? v.length : !!v,
      ) ||
        !!config.codexAuth)
    ) {
      flock.set(['providerSetup', id], {
        v: 1,
        id,
        machineId,
        config,
        status: 'queued',
        attempt: 1,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      flock.set(['agentConfig', id], config);
      if (config.cliType === 'builtin' && managed.has(text(config.agentType)))
        flock.delete(['builtinAgentOptOut', text(config.agentType)]);
    }
  } else if (request.action === 'delete') {
    sameProvider(
      rows.providers.find((item) => item.id === request.base.id),
      request.base,
    );
    removeProvider(flock, request.base.id, machineId, now);
  } else {
    if (!supportsSetup) throw new Error('provider_setup_unsupported');
    const { setup } = request;
    const current = rows.setups.find((item) => item.id === setup.id);
    if (request.action === 'retrySetup') {
      if (
        !current ||
        !current.canRetry ||
        current.attempt !== setup.attempt ||
        current.status !== setup.status
      )
        throw new Error('provider_conflict');
      const next = {
        ...object(flock.get(['providerSetup', setup.id])),
        status: 'queued',
        attempt: current.attempt + 1,
        updatedAt: now,
      };
      delete (next as Record<string, unknown>).failureCode;
      flock.set(['providerSetup', setup.id], next);
    } else {
      // The marker is appended separately before this cleanup, so a concurrent
      // publication is still removed by the daemon even if cleanup loses a race.
      if (!flock.get(['providerSetupCancellation', setup.id]))
        throw new Error('provider_cancellation_missing');
      flock.delete(['providerSetup', setup.id]);
      removeProvider(flock, setup.id, machineId, now);
    }
  }
  flock.commit();
}

export async function agentProviders(
  request: Request,
  grant: Grant,
  signal: AbortSignal,
  presence: MachinePresence,
  check: () => void,
  live?: { meta: Flock; machines: Map<string, Flock> },
): Promise<Result> {
  check();
  const listing = request.action === 'list' && !!live;
  const meta = listing
    ? { flock: live!.meta }
    : await openSettings(`${request.workspaceId}:meta`, grant, signal);
  check();
  const machines = settingsRows('machine', meta.flock).map((item) => {
    const room = `machine-${item.id}`,
      root = object(meta.flock.get(['m', room]));
    const field = (name: string) =>
      meta.flock.get(['m', room, name]) ?? root[name];
    return {
      id: item.id,
      name: item.name,
      os: text(field('os')),
      readOnly: !request.userId || field('ownerUserId') !== request.userId,
      online:
        presence.state === 'live' &&
        presence.onlineMachineIds.includes(item.id),
      supportsSetup:
        Number(object(field('protocolCapabilities')).providerSetup) >= 1,
      supportsCodexProfiles:
        Number(object(field('protocolCapabilities')).codexAuthProfiles) >= 1,
      supportsAuthentication:
        Number(
          object(field('protocolCapabilities')).acpProtocolAuthentication,
        ) >= 2,
      supportsPiExtensions:
        Number(object(field('protocolCapabilities')).piExtensions) >= 1,
    };
  });
  // Online computers lead, and among them the user's own.
  machines.sort(
    (a, b) =>
      Number(b.online) - Number(a.online) ||
      Number(a.readOnly) - Number(b.readOnly) ||
      a.name.localeCompare(b.name),
  );
  const result: Result = {
    machines,
    providers: [],
    setups: [],
    catalog,
    presets: presetCatalog(),
  };
  let selected: string | undefined;
  if (request.action === 'list' || request.action === 'save')
    selected = request.machineId;
  else if (request.action === 'delete' || request.action === 'refresh')
    selected = request.base.machineId;
  else selected = request.setup.machineId;
  if (selected && !machines.some((item) => item.id === selected))
    throw new Error('machine_unavailable');
  if (listing) {
    const pending: typeof machines = [];
    for (const machine of machines.filter(
      (item) => !selected || item.id === selected,
    )) {
      const flock = live!.machines.get(machine.id);
      if (flock) {
        const rows = providerRows(flock, machine.id, machine.readOnly);
        result.providers.push(...rows.providers);
        result.setups.push(...rows.setups);
      } else pending.push(machine);
    }
    // Computers whose replica is not synced yet are read in parallel.
    const fetched = await Promise.all(
      pending.map((machine) =>
        openSettings(`${request.workspaceId}:mf:${machine.id}`, grant, signal)
          .then(({ flock }) =>
            providerRows(flock, machine.id, machine.readOnly),
          )
          .catch((error) => {
            if (error instanceof Error && error.message === 'not_found')
              return { providers: [], setups: [] };
            throw error;
          }),
      ),
    );
    check();
    for (const rows of fetched) {
      result.providers.push(...rows.providers);
      result.setups.push(...rows.setups);
    }
    return result;
  }
  for (const machine of machines.filter(
    (item) => !selected || item.id === selected,
  )) {
    const target = request.action !== 'list' && machine.id === selected;
    if (target && machine.readOnly) throw new Error('setting_read_only');
    let replica;
    try {
      replica = await openSettings(
        `${request.workspaceId}:mf:${machine.id}`,
        grant,
        signal,
      );
    } catch (error) {
      if (!target && error instanceof Error && error.message === 'not_found')
        continue;
      throw error;
    }
    check();
    const { flock, client } = replica;
    const append = async (version: ReturnType<Flock['version']>) => {
      check();
      signal.throwIfAborted();
      const body = encodeFrame(
        new TextEncoder().encode(JSON.stringify(flock.exportJson(version))),
      );
      try {
        const reply = await client.append({
          part: { contentType: 'application/octet-stream', body },
        });
        if (!reply.ok)
          throw new Error(
            reply.result.code === 'forbidden'
              ? 'setting_read_only'
              : 'setting_write_unknown',
          );
      } catch (error) {
        if (error instanceof Error && error.message === 'setting_read_only')
          throw error;
        throw new Error('setting_write_unknown');
      }
      check();
    };
    if (target && request.action === 'refresh') {
      if (!machine.online) throw new Error('machine_unavailable');
      sameProvider(
        providerRows(flock, machine.id, false).providers.find(
          (item) => item.id === request.base.id,
        ),
        request.base,
      );
      let reply;
      try {
        reply = await machineRpc(
          request.workspaceId,
          machine.id,
          'machine/acp-capabilities-refresh',
          { configId: request.base.id, force: true },
          grant,
          signal,
          undefined,
          120000,
        );
      } catch {
        throw new Error('provider_refresh_unknown');
      }
      check();
      const value = object(reply.result);
      if (
        reply.error ||
        value.machineId !== machine.id ||
        value.configId !== request.base.id ||
        value.cliType !== request.base.cliType ||
        value.agentType !== request.base.agentType
      )
        throw new Error('provider_refresh_failed');
      result.authRequired = value.authRequired === true;
      if (value.success !== true && !result.authRequired)
        throw new Error('provider_refresh_failed');
    } else if (target && request.action !== 'refresh') {
      if (request.action === 'deleteSetup') {
        if (!machine.supportsSetup)
          throw new Error('provider_setup_unsupported');
        const setup = object(flock.get(['providerSetup', request.setup.id]));
        const published = object(flock.get(['agentConfig', request.setup.id]));
        if (
          setup.machineId !== machine.id &&
          published.machineId !== machine.id &&
          !flock.get(['providerSetupCancellation', request.setup.id])
        )
          throw new Error('provider_conflict');
        const version = flock.version();
        flock.set(['providerSetupCancellation', request.setup.id], {
          v: 1,
          id: request.setup.id,
          machineId: machine.id,
          cancelledAt: Date.now(),
        });
        flock.commit();
        await append(version);
      }
      const version = flock.version();
      changeProvider(
        flock,
        request,
        machine.supportsSetup,
        Date.now(),
        object(
          meta.flock.get([
            'm',
            `machine-${machine.id}`,
            'protocolCapabilities',
          ]) ??
            object(meta.flock.get(['m', `machine-${machine.id}`]))
              .protocolCapabilities,
        ),
      );
      await append(version);
    }
    const rows = providerRows(flock, machine.id, machine.readOnly);
    result.providers.push(...rows.providers);
    result.setups.push(...rows.setups);
  }
  check();
  return result;
}
