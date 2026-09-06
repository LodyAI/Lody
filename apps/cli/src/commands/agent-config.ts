import { Command } from 'commander';
import { promises as fs } from 'node:fs';
import { v4 as uuidV4 } from 'uuid';
import { z } from 'zod';
import {
  MachineAcpCapabilitiesRefreshResponseSchema,
  isMachineDocRoomId,
  type AgentConfigCliType,
  type AgentConfigId,
  type AgentConfigMeta,
  type TitleGenerationConfig,
  type LocalSessionControlResponse,
  type MachineId,
  type MachineMeta,
  type WorkspaceId,
} from '@lody/shared';
import {
  dispatchLocalControl,
  ensureWorkspaceMetaSynced,
  getAuthContextOrThrow,
  listAliveDocMetas,
  normalizeCliValue,
  printJson,
  resolveStructuredOutputMode,
  resolveWorkspaceOrThrow,
  runOneShotCommand,
  withWorkspaceManager,
  type CommonCommandOptions,
} from '@/lib/command-runtime';
import { renderTerminalTable } from '@/lib/terminal-table';
import { formatErrorMessage } from '@/utils/format-error';
import {
  deleteMachineAgentConfig,
  listMergedAgentConfigs,
  upsertMachineAgentConfig,
} from '@/lib/agent-config-machine-flock';

type AgentConfigCommandOptions = CommonCommandOptions;

type AgentConfigListOptions = AgentConfigCommandOptions & {
  machine?: string;
};

type AgentConfigCreateOptions = AgentConfigCommandOptions & {
  name?: string;
  description?: string;
  agentType: string;
  machine?: string;
  env?: string[];
  envFile?: string;
  prompt?: string;
  promptFile?: string;
  titleConfigOption?: string[];
};

type AgentConfigUpdateOptions = AgentConfigCommandOptions & {
  name?: string;
  description?: string;
  env?: string[];
  envFile?: string;
  unsetEnv?: string[];
  prompt?: string;
  promptFile?: string;
  titleConfigOption?: string[];
  clearTitleGeneration?: boolean;
};

type AgentConfigRefreshOptions = CommonCommandOptions & {
  machine?: string;
};

export function sortAgentConfigs(configs: AgentConfigMeta[]): AgentConfigMeta[] {
  return [...configs].sort((left, right) => {
    const nameCompare = left.name.localeCompare(right.name);
    if (nameCompare !== 0) {
      return nameCompare;
    }
    return left.id.localeCompare(right.id);
  });
}

function formatAgentConfigCandidates(configs: AgentConfigMeta[]): string {
  return sortAgentConfigs(configs)
    .map((config) => `${config.name} (${config.id})`)
    .join(', ');
}

function selectUniqueByIdOrName<T extends { id: string; name: string }>(
  entries: T[],
  selector: string,
  options: {
    label: string;
    candidates: string;
  }
): T {
  const normalizedSelector = normalizeCliValue(selector);
  if (!normalizedSelector) {
    throw new Error(`Missing ${options.label} selector.`);
  }

  const idMatch = entries.find((entry) => entry.id === normalizedSelector);
  if (idMatch) {
    return idMatch;
  }

  const nameMatches = entries.filter(
    (entry) => normalizeCliValue(entry.name) === normalizedSelector
  );
  if (nameMatches.length === 1) {
    return nameMatches[0]!;
  }
  if (nameMatches.length > 1) {
    throw new Error(
      `${options.label} selector is ambiguous: ${normalizedSelector}. Use an id instead. Candidates: ${options.candidates}`
    );
  }

  throw new Error(
    `${options.label} not found: ${normalizedSelector}. Candidates: ${options.candidates}`
  );
}

export function resolveAgentConfigSelector(
  configs: AgentConfigMeta[],
  options: {
    selector?: string;
    envSelector?: string;
  } = {}
): AgentConfigMeta {
  const selector = normalizeCliValue(options.selector) ?? normalizeCliValue(options.envSelector);
  if (selector) {
    return selectUniqueByIdOrName(configs, selector, {
      label: 'Agent config',
      candidates: formatAgentConfigCandidates(configs),
    });
  }

  if (configs.length === 1) {
    return configs[0]!;
  }
  if (configs.length === 0) {
    throw new Error('No agent configs found in the target workspace.');
  }

  throw new Error(
    `Multiple agent configs are available; pass an id or name. Candidates: ${formatAgentConfigCandidates(configs)}`
  );
}

// CLI inference predates explicit cliType. Keep the historical Claude/Codex
// aliases and the unambiguous built-in Grok alias here; `kimi` continues to
// mean the registry agent for backward compatibility.
const LEGACY_BUILTIN_AGENT_TYPES = new Set(['claude', 'codex', 'grok']);

export function inferAgentConfigCliType(agentType: string): AgentConfigCliType {
  const normalized = normalizeCliValue(agentType)?.toLowerCase();
  return normalized && LEGACY_BUILTIN_AGENT_TYPES.has(normalized) ? 'builtin' : 'registry';
}

export function parseEnvAssignments(entries: string[] | undefined): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const entry of entries ?? []) {
    const normalizedEntry = normalizeCliValue(entry);
    if (!normalizedEntry) {
      continue;
    }
    const separatorIndex = normalizedEntry.indexOf('=');
    if (separatorIndex <= 0) {
      throw new Error(`Invalid --env entry: ${entry}. Expected KEY=VALUE.`);
    }
    const key = normalizedEntry.slice(0, separatorIndex).trim();
    if (!key) {
      throw new Error(`Invalid --env entry: ${entry}. Expected KEY=VALUE.`);
    }
    parsed[key] = normalizedEntry.slice(separatorIndex + 1);
  }
  return parsed;
}

export function parseEnvFileText(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      throw new Error(`Invalid env file entry: ${rawLine}. Expected KEY=VALUE.`);
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key) {
      throw new Error(`Invalid env file entry: ${rawLine}. Expected KEY=VALUE.`);
    }

    parsed[key] = line.slice(separatorIndex + 1);
  }
  return parsed;
}

export function applyEnvUpdates(
  baseEnv: Record<string, string>,
  fileEnv: Record<string, string>,
  inlineEnv: Record<string, string>,
  unsetEnv: string[] = []
): Record<string, string> {
  const nextEnv = {
    ...baseEnv,
    ...fileEnv,
    ...inlineEnv,
  };

  for (const key of unsetEnv) {
    const normalizedKey = normalizeCliValue(key);
    if (!normalizedKey) {
      continue;
    }
    delete nextEnv[normalizedKey];
  }

  return nextEnv;
}

function parseUnsetEnvKeys(entries: string[] | undefined): string[] {
  const keys: string[] = [];
  for (const entry of entries ?? []) {
    const normalized = normalizeCliValue(entry);
    if (!normalized) {
      throw new Error('Invalid --unset-env entry: expected a non-empty key.');
    }
    keys.push(normalized);
  }
  return keys;
}

async function readOptionalTextInput(options: {
  text?: string;
  filePath?: string;
}): Promise<string | undefined> {
  if (options.text !== undefined) {
    return normalizeCliValue(options.text);
  }

  const filePath = options.filePath;
  if (filePath === undefined) {
    return undefined;
  }

  const rawText =
    filePath === '-'
      ? await readStdinText()
      : await fs.readFile(filePath, 'utf8').catch((error: unknown) => {
          const message = formatErrorMessage(error);
          throw new Error(`Failed to read file ${filePath}: ${message}`);
        });
  return normalizeCliValue(rawText);
}

async function readStdinText(): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    return undefined;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return normalizeCliValue(raw);
}

type AgentConfigOutput = Omit<AgentConfigMeta, 'cliType'>;

function toAgentConfigOutput(config: AgentConfigMeta): AgentConfigOutput {
  const { cliType: _cliType, ...rest } = config;
  return rest;
}

type RefreshCapabilitiesOutput = Omit<
  z.infer<typeof MachineAcpCapabilitiesRefreshResponseSchema>,
  'cliType'
>;

function toRefreshCapabilitiesOutput(
  response: z.infer<typeof MachineAcpCapabilitiesRefreshResponseSchema>
): RefreshCapabilitiesOutput {
  const { cliType: _cliType, ...rest } = response;
  return rest;
}

function printHumanAgentConfig(config: AgentConfigMeta): void {
  console.log(`id: ${config.id}`);
  console.log(`name: ${config.name}`);
  console.log(`agentType: ${config.agentType}`);
  console.log(`description: ${normalizeCliValue(config.description) ?? '-'}`);
  console.log(`prompt: ${normalizeCliValue(config.prompt) ?? '-'}`);
  const envEntries = Object.entries(config.env).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  if (envEntries.length === 0) {
    console.log('env: -');
  } else {
    console.log('env:');
    for (const [key, value] of envEntries) {
      console.log(`  ${key}=${value}`);
    }
  }

  const tc = config.titleGeneration;
  if (!tc) {
    console.log('titleGeneration: -');
  } else {
    console.log('titleGeneration:');
    if (tc.configOptionValues) {
      console.log('  configOptions:');
      for (const [key, value] of Object.entries(tc.configOptionValues)) {
        console.log(`    ${key}=${value}`);
      }
    }
  }
}

function printHumanRefreshSummary(input: {
  config: AgentConfigMeta;
  machine: MachineMeta;
  response: z.infer<typeof MachineAcpCapabilitiesRefreshResponseSchema>;
}): void {
  console.log(`agentConfig: ${input.config.name} (${input.config.id})`);
  console.log(`agent: ${input.config.agentType}`);
  console.log(`machine: ${input.machine.name} (${input.machine.id})`);
  console.log(`modes: ${input.response.modes?.length ?? 0}`);
  console.log(`models: ${input.response.models?.length ?? 0}`);
  console.log(`configOptions: ${input.response.configOptions?.length ?? 0}`);

  if (input.response.modes?.length) {
    console.log('');
    console.log(
      renderTerminalTable(
        [{ header: 'Mode ID' }, { header: 'Name' }, { header: 'Description' }],
        input.response.modes.map((mode) => [mode.id, mode.name, mode.description])
      )
    );
  }

  if (input.response.models?.length) {
    console.log('');
    console.log(
      renderTerminalTable(
        [{ header: 'Model ID' }, { header: 'Name' }, { header: 'Description' }],
        input.response.models.map((model) => [model.modelId, model.name, model.description])
      )
    );
  }

  if (input.response.configOptions?.length) {
    console.log('');
    console.log(
      renderTerminalTable(
        [{ header: 'Option ID' }, { header: 'Name' }, { header: 'Category' }, { header: 'Values' }],
        input.response.configOptions.map((option) => [
          option.id,
          option.name,
          option.category,
          String(option.optionCount),
        ])
      )
    );
  }
}

async function listAgentConfigsForWorkspace(
  manager: import('@/lib/loro/doc').LoroDocumentManager,
  workspaceId: WorkspaceId
): Promise<AgentConfigMeta[]> {
  const machines = await listMachineMetasForWorkspace(manager);
  const configs = await listMergedAgentConfigs(
    manager.repo,
    workspaceId,
    machines.map((machine) => machine.id)
  );
  return sortAgentConfigs(configs);
}

async function listMachineMetasForWorkspace(
  manager: import('@/lib/loro/doc').LoroDocumentManager
): Promise<MachineMeta[]> {
  return (await listAliveDocMetas<MachineMeta>(manager, isMachineDocRoomId)).map(
    (entry) => entry.meta
  );
}

function formatMachineCandidates(machines: MachineMeta[]): string {
  return machines
    .map((machine) => `${machine.name} (${machine.id})`)
    .sort((left, right) => left.localeCompare(right))
    .join(', ');
}

export function resolveMachineOrThrow(
  machines: MachineMeta[],
  options: {
    selector?: string;
    envSelector?: string;
    authMachineId: MachineId;
  }
): MachineMeta {
  const selector =
    normalizeCliValue(options.selector) ??
    normalizeCliValue(options.envSelector) ??
    options.authMachineId;
  return selectUniqueByIdOrName(machines, selector, {
    label: 'Machine',
    candidates: formatMachineCandidates(machines),
  });
}

function extractRefreshResponse(
  responses: LocalSessionControlResponse[]
): z.infer<typeof MachineAcpCapabilitiesRefreshResponseSchema> {
  const target = responses.find(
    (response) => response.type === 'machine/acp-capabilities-refresh_response'
  );
  if (!target) {
    throw new Error('Missing machine/acp-capabilities-refresh_response from local CLI daemon.');
  }
  return MachineAcpCapabilitiesRefreshResponseSchema.parse(target);
}

function collectListOption(value: string, previous: string[] = []): string[] {
  previous.push(value);
  return previous;
}

function buildTitleGenerationConfig(options: {
  titleConfigOption?: string[];
}): TitleGenerationConfig | undefined {
  const configOptionValues = parseEnvAssignments(options.titleConfigOption);
  if (Object.keys(configOptionValues).length === 0) {
    return undefined;
  }
  return { configOptionValues };
}

const agentConfigListCommand = new Command('list')
  .description('List agent configs in a workspace')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--machine <idOrName>', 'Only include configs for one machine')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .action(async (options: AgentConfigListOptions) => {
    await runOneShotCommand('agent-config', options, async () => {
      const auth = getAuthContextOrThrow('agent-config');
      const workspace = await resolveWorkspaceOrThrow(auth, options.workspace);

      await withWorkspaceManager(auth, workspace, 'agent-config', async (manager) => {
        const machineSelector = normalizeCliValue(options.machine);
        let machineId: MachineId | undefined;
        if (machineSelector) {
          const machine = resolveMachineOrThrow(await listMachineMetasForWorkspace(manager), {
            selector: machineSelector,
            authMachineId: auth.machineId,
          });
          machineId = machine.id;
        }
        const configs = (
          await listAgentConfigsForWorkspace(manager, workspace.id as WorkspaceId)
        ).filter((config) => machineId === undefined || config.machineId === machineId);

        if (options.json) {
          printJson({
            ok: true,
            workspaceId: workspace.id,
            ...(machineId ? { machineId } : {}),
            agentConfigs: configs.map(toAgentConfigOutput),
          });
          return;
        }

        if (configs.length === 0) {
          console.log('No agent configs found.');
          return;
        }

        console.log(
          renderTerminalTable(
            [
              { header: 'ID' },
              { header: 'Name' },
              { header: 'Agent Type' },
              { header: 'Description' },
            ],
            configs.map((config) => [config.id, config.name, config.agentType, config.description])
          )
        );
      });
    });
  });

const agentConfigShowCommand = new Command('show')
  .description('Show an agent config')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .argument('[idOrName]', 'Agent config id or name; falls back to LODY_AGENT_CONFIG_ID')
  .action(async (selector: string | undefined, options: AgentConfigCommandOptions) => {
    await runOneShotCommand('agent-config', options, async () => {
      const auth = getAuthContextOrThrow('agent-config');
      const workspace = await resolveWorkspaceOrThrow(auth, options.workspace);

      await withWorkspaceManager(auth, workspace, 'agent-config', async (manager) => {
        const config = resolveAgentConfigSelector(
          await listAgentConfigsForWorkspace(manager, workspace.id as WorkspaceId),
          {
            selector,
            envSelector: process.env.LODY_AGENT_CONFIG_ID,
          }
        );

        if (options.json) {
          printJson({
            ok: true,
            workspaceId: workspace.id,
            agentConfig: toAgentConfigOutput(config),
          });
          return;
        }

        printHumanAgentConfig(config);
      });
    });
  });

const agentConfigRefreshCapabilitiesCommand = new Command('refresh-capabilities')
  .description('Refresh ACP capabilities for an agent config on the current machine')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--machine <idOrName>', 'Machine id or name; defaults to the current machine')
  .option('--json', 'Print JSON output')
  .option('--jsonl', 'Print JSON Lines output')
  .option('--debug', 'Enable debug output')
  .argument('[idOrName]', 'Agent config id or name; falls back to LODY_AGENT_CONFIG_ID')
  .action(async (selector: string | undefined, options: AgentConfigRefreshOptions) => {
    await runOneShotCommand('agent-config', options, async () => {
      const outputMode = resolveStructuredOutputMode(options);
      const auth = getAuthContextOrThrow('agent-config');
      const workspace = await resolveWorkspaceOrThrow(auth, options.workspace);

      await withWorkspaceManager(auth, workspace, 'agent-config', async (manager) => {
        const config = resolveAgentConfigSelector(
          await listAgentConfigsForWorkspace(manager, workspace.id as WorkspaceId),
          {
            selector,
            envSelector: process.env.LODY_AGENT_CONFIG_ID,
          }
        );
        const machines = await listMachineMetasForWorkspace(manager);
        const machine = resolveMachineOrThrow(machines, {
          selector: options.machine,
          envSelector: process.env.LODY_MACHINE_ID,
          authMachineId: auth.machineId,
        });

        if (machine.id !== auth.machineId) {
          throw new Error(
            `Remote machine capability refresh is not implemented in CLI yet. Current machine: ${auth.machineId}`
          );
        }
        // Presence-based liveness; a null snapshot (presence room unavailable)
        // falls through to the local dispatch, which fails with its own error
        // if the daemon is actually down.
        const onlineMachineIds = await manager.getOnlineMachineIds();
        if (onlineMachineIds && !onlineMachineIds.has(machine.id)) {
          throw new Error(`Machine ${machine.id} appears offline. Run \`lody start\` first.`);
        }

        const response = extractRefreshResponse(
          await dispatchLocalControl({
            type: 'machine/acp-capabilities-refresh',
            machineId: machine.id,
            workspaceId: workspace.id as WorkspaceId,
            configId: config.id,
          })
        );

        if (!response.success) {
          throw new Error(
            response.error ??
              `Failed to refresh capabilities for ${config.name} on machine ${machine.id}.`
          );
        }

        if (outputMode === 'json') {
          printJson({
            ok: true,
            workspaceId: workspace.id,
            machineId: machine.id,
            agentConfigId: config.id,
            response: toRefreshCapabilitiesOutput(response),
          });
          return;
        }

        if (outputMode === 'jsonl') {
          printJson({
            event: 'response',
            workspaceId: workspace.id,
            agentConfigId: config.id,
            ...toRefreshCapabilitiesOutput(response),
          });
          return;
        }

        printHumanRefreshSummary({ config, machine, response });
      });
    });
  });

const agentConfigCreateCommand = new Command('create')
  .description('Create a new agent config')
  .requiredOption('--agent-type <type>', 'Agent type identifier')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--machine <idOrName>', 'Machine id or name; defaults to the current machine')
  .option('--name <name>', 'Agent config name')
  .option('--description <text>', 'Agent config description')
  .option(
    '--env <keyValue>',
    'Environment variable in KEY=VALUE form; repeatable',
    collectListOption,
    []
  )
  .option('--env-file <path>', 'Read environment variables from a file')
  .option('--prompt <text>', 'Default prompt prefix')
  .option('--prompt-file <path|->', 'Read default prompt prefix from file or stdin')
  .option(
    '--title-config-option <keyValue>',
    'Title generation config option in KEY=VALUE form; repeatable',
    collectListOption,
    []
  )
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .action(async (options: AgentConfigCreateOptions) => {
    await runOneShotCommand('agent-config', options, async () => {
      const auth = getAuthContextOrThrow('agent-config');
      const workspace = await resolveWorkspaceOrThrow(auth, options.workspace);

      const agentType = normalizeCliValue(options.agentType);
      if (!agentType) {
        throw new Error('Missing --agent-type.');
      }
      const cliType = inferAgentConfigCliType(agentType);

      const fileEnv = options.envFile
        ? parseEnvFileText(await fs.readFile(options.envFile, 'utf8'))
        : {};
      const inlineEnv = parseEnvAssignments(options.env);
      const prompt = await readOptionalTextInput({
        text: options.prompt,
        filePath: options.promptFile,
      });
      const titleGeneration = buildTitleGenerationConfig(options);

      await withWorkspaceManager(auth, workspace, 'agent-config', async (manager) => {
        const machines = await listMachineMetasForWorkspace(manager);
        const machine = resolveMachineOrThrow(machines, {
          selector: options.machine,
          envSelector: process.env.LODY_MACHINE_ID,
          authMachineId: auth.machineId,
        });

        const configId = uuidV4() as AgentConfigId;
        const config: AgentConfigMeta = {
          id: configId,
          machineId: machine.id,
          name: normalizeCliValue(options.name) ?? agentType,
          description: normalizeCliValue(options.description),
          cliType,
          agentType,
          env: applyEnvUpdates({}, fileEnv, inlineEnv),
          ...(prompt ? { prompt } : {}),
          ...(titleGeneration ? { titleGeneration } : {}),
        };

        await upsertMachineAgentConfig(manager.repo, workspace.id as WorkspaceId, config);
        await ensureWorkspaceMetaSynced(manager, `agent-config.create:${config.id}`);

        if (options.json) {
          printJson({
            ok: true,
            workspaceId: workspace.id,
            agentConfig: toAgentConfigOutput(config),
          });
          return;
        }

        console.log(configId);
      });
    });
  });

const agentConfigUpdateCommand = new Command('update')
  .description('Update an existing agent config')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--name <name>', 'Updated agent config name')
  .option('--description <text>', 'Updated agent config description; pass empty to clear')
  .option(
    '--env <keyValue>',
    'Environment variable in KEY=VALUE form; repeatable',
    collectListOption,
    []
  )
  .option('--env-file <path>', 'Read environment variables from a file')
  .option('--unset-env <key>', 'Remove an environment variable; repeatable', collectListOption, [])
  .option('--prompt <text>', 'Updated default prompt prefix; pass empty to clear')
  .option('--prompt-file <path|->', 'Read default prompt prefix from file or stdin')
  .option(
    '--title-config-option <keyValue>',
    'Title generation config option in KEY=VALUE form; repeatable',
    collectListOption,
    []
  )
  .option('--clear-title-generation', 'Remove title generation settings')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .argument('[idOrName]', 'Agent config id or name; falls back to LODY_AGENT_CONFIG_ID')
  .action(async (selector: string | undefined, options: AgentConfigUpdateOptions) => {
    await runOneShotCommand('agent-config', options, async () => {
      const auth = getAuthContextOrThrow('agent-config');
      const workspace = await resolveWorkspaceOrThrow(auth, options.workspace);

      const requestedEnvUpdate =
        !!options.envFile || (options.env?.length ?? 0) > 0 || (options.unsetEnv?.length ?? 0) > 0;
      const requestedPromptUpdate =
        options.prompt !== undefined || options.promptFile !== undefined;
      const requestedNameUpdate = options.name !== undefined;
      const requestedDescriptionUpdate = options.description !== undefined;
      const requestedTitleUpdate =
        (options.titleConfigOption?.length ?? 0) > 0 || !!options.clearTitleGeneration;

      if (
        !requestedEnvUpdate &&
        !requestedPromptUpdate &&
        !requestedNameUpdate &&
        !requestedDescriptionUpdate &&
        !requestedTitleUpdate
      ) {
        throw new Error('No updates specified.');
      }

      const fileEnv = options.envFile
        ? parseEnvFileText(await fs.readFile(options.envFile, 'utf8'))
        : {};
      const inlineEnv = parseEnvAssignments(options.env);
      const unsetEnv = parseUnsetEnvKeys(options.unsetEnv);
      const prompt = requestedPromptUpdate
        ? await readOptionalTextInput({
            text: options.prompt,
            filePath: options.promptFile,
          })
        : undefined;

      let titleGeneration: TitleGenerationConfig | undefined;
      if (requestedTitleUpdate) {
        titleGeneration = options.clearTitleGeneration
          ? undefined
          : buildTitleGenerationConfig(options);
      }

      await withWorkspaceManager(auth, workspace, 'agent-config', async (manager) => {
        const current = resolveAgentConfigSelector(
          await listAgentConfigsForWorkspace(manager, workspace.id as WorkspaceId),
          {
            selector,
            envSelector: process.env.LODY_AGENT_CONFIG_ID,
          }
        );

        const nextName = requestedNameUpdate ? normalizeCliValue(options.name) : current.name;
        if (!nextName) {
          throw new Error('Updated name must be non-empty.');
        }

        const nextConfig: AgentConfigMeta = {
          ...current,
          name: nextName,
          description: requestedDescriptionUpdate
            ? normalizeCliValue(options.description)
            : current.description,
          env: requestedEnvUpdate
            ? applyEnvUpdates(current.env, fileEnv, inlineEnv, unsetEnv)
            : current.env,
          prompt: requestedPromptUpdate ? prompt : current.prompt,
          titleGeneration: requestedTitleUpdate ? titleGeneration : current.titleGeneration,
        };

        await upsertMachineAgentConfig(manager.repo, workspace.id as WorkspaceId, nextConfig);
        await ensureWorkspaceMetaSynced(manager, `agent-config.update:${current.id}`);

        if (options.json) {
          printJson({
            ok: true,
            workspaceId: workspace.id,
            agentConfig: toAgentConfigOutput(nextConfig),
          });
          return;
        }

        console.log(`Updated ${current.id}`);
      });
    });
  });

const agentConfigDeleteCommand = new Command('delete')
  .description('Delete an agent config')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .argument('[idOrName]', 'Agent config id or name; falls back to LODY_AGENT_CONFIG_ID')
  .action(async (selector: string | undefined, options: AgentConfigCommandOptions) => {
    await runOneShotCommand('agent-config', options, async () => {
      const auth = getAuthContextOrThrow('agent-config');
      const workspace = await resolveWorkspaceOrThrow(auth, options.workspace);

      await withWorkspaceManager(auth, workspace, 'agent-config', async (manager) => {
        const config = resolveAgentConfigSelector(
          await listAgentConfigsForWorkspace(manager, workspace.id as WorkspaceId),
          {
            selector,
            envSelector: process.env.LODY_AGENT_CONFIG_ID,
          }
        );

        await deleteMachineAgentConfig(manager.repo, workspace.id as WorkspaceId, config);
        await ensureWorkspaceMetaSynced(manager, `agent-config.delete:${config.id}`);

        if (options.json) {
          printJson({
            ok: true,
            workspaceId: workspace.id,
            agentConfigId: config.id,
          });
          return;
        }

        console.log(`Deleted ${config.id}`);
      });
    });
  });

export const agentConfigCommand = new Command('agent-config')
  .description('Manage agent configs')
  .addCommand(agentConfigListCommand)
  .addCommand(agentConfigShowCommand)
  .addCommand(agentConfigRefreshCapabilitiesCommand)
  .addCommand(agentConfigCreateCommand)
  .addCommand(agentConfigUpdateCommand)
  .addCommand(agentConfigDeleteCommand);
