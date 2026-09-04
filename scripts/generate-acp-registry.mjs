#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
const EXCLUDED_REMOTE_REGISTRY_AGENT_IDS = new Set([
  'claude-acp',
  'claude-p',
  'codex-acp',
  'factory-droid',
  'grok-build',
]);
const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org/';
const INTERACTIVE_CLAUDE_ACP_VERSION = '0.1.5';
const FACTORY_DROID_ACP_VERSION = '0.211.0';
const INTERACTIVE_CLAUDE_REGISTRY_AGENT = {
  id: 'claude-p',
  name: 'Interactive Claude',
  version: INTERACTIVE_CLAUDE_ACP_VERSION,
  description: 'Interactive Claude Code ACP runtime',
  distribution: {
    npx: {
      package: `acp-extension-claude-pty@${INTERACTIVE_CLAUDE_ACP_VERSION}`,
      registry: OFFICIAL_NPM_REGISTRY,
      platformPackages: {
        darwin: {
          arm64: `acp-extension-claude-pty-darwin-arm64@${INTERACTIVE_CLAUDE_ACP_VERSION}`,
          x64: `acp-extension-claude-pty-darwin-x64@${INTERACTIVE_CLAUDE_ACP_VERSION}`,
        },
        linux: {
          arm64: `acp-extension-claude-pty-linux-arm64@${INTERACTIVE_CLAUDE_ACP_VERSION}`,
          x64: `acp-extension-claude-pty-linux-x64@${INTERACTIVE_CLAUDE_ACP_VERSION}`,
        },
        win32: {
          arm64: `acp-extension-claude-pty-win32-arm64@${INTERACTIVE_CLAUDE_ACP_VERSION}`,
          x64: `acp-extension-claude-pty-win32-x64@${INTERACTIVE_CLAUDE_ACP_VERSION}`,
        },
      },
    },
  },
};
const FACTORY_DROID_REGISTRY_AGENT = {
  id: 'factory-droid',
  name: 'Factory Droid',
  version: FACTORY_DROID_ACP_VERSION,
  description: 'Factory Droid - AI coding agent powered by Factory AI',
  icon: 'https://cdn.agentclientprotocol.com/registry/v1/latest/factory-droid.svg',
  distribution: {
    npx: {
      package: `droid@${FACTORY_DROID_ACP_VERSION}`,
      args: ['exec', '--output-format', 'acp'],
      env: {
        DROID_DISABLE_AUTO_UPDATE: 'true',
        FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false',
      },
    },
  },
};
const LOCAL_REGISTRY_AGENTS = {
  'amp-acp': {
    command: 'npx',
    args: ['-y', 'amp-acp'],
    versionArgs: ['--version'],
  },
  cursor: {
    command: 'cursor-agent',
    args: ['acp'],
    versionArgs: ['--version'],
  },
  goose: {
    command: 'goose',
    args: ['--acp=true'],
    versionArgs: ['--version'],
  },
  junie: {
    command: 'junie',
    args: ['--acp=true'],
    versionArgs: ['--version'],
  },
  'minion-code': {
    command: 'minion-code',
    args: ['acp'],
    versionArgs: ['--version'],
  },
  'mistral-vibe': {
    command: 'vibe-acp',
    args: [],
    versionArgs: ['--version'],
  },
  stakpak: {
    command: 'stakpak',
    args: ['acp'],
    versionArgs: ['--version'],
  },
  kimi: {
    command: 'kimi',
    args: ['acp'],
    versionArgs: ['-V'],
  },
  'kimi-code': {
    command: 'kimi',
    args: ['acp'],
    versionArgs: ['-V'],
  },
  opencode: {
    command: 'opencode',
    args: ['acp'],
    versionArgs: ['-v'],
  },
  reasonix: {
    npx: {
      package: 'reasonix@1.7.0-rc.1',
      args: ['acp'],
    },
  },
};
const LOCAL_REGISTRY_AGENT_IDS = new Set(Object.keys(LOCAL_REGISTRY_AGENTS));
const LOCAL_REGISTRY_AGENT_FALLBACKS = {
  kimi: {
    name: 'Kimi CLI',
    description: "Moonshot AI's coding assistant",
    icon: 'https://cdn.agentclientprotocol.com/registry/v1/latest/kimi.svg',
  },
  'kimi-code': {
    name: 'Kimi Code CLI',
    description: "Moonshot AI's next-generation coding agent CLI",
    icon: 'https://cdn.agentclientprotocol.com/registry/v1/latest/kimi.svg',
  },
  opencode: {
    name: 'OpenCode',
  },
  reasonix: {
    name: 'DeepSeek Reasonix',
    version: '1.7.0-rc.1',
    description:
      'DeepSeek-native coding agent: cache-first loop, flash-first cost control, tool-call repair.',
  },
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const outputPath = path.join(repoRoot, 'packages/shared/src/acp/registry-generated.ts');

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toStringArray(value) {
  if (!Array.isArray(value)) return undefined;
  const result = value.filter((item) => typeof item === 'string').map((item) => item.trim());
  return result.length > 0 ? result : undefined;
}

function toStringRecord(value) {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(([, v]) => typeof v === 'string');
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.map(([k, v]) => [k, String(v)]));
}

function normalizeLauncher(value) {
  if (!isRecord(value)) return undefined;
  const pkg = typeof value.package === 'string' ? value.package.trim() : '';
  if (!pkg) return undefined;
  return {
    package: pkg,
    args: toStringArray(value.args),
    env: toStringRecord(value.env),
  };
}

function normalizeBinaryEntry(value) {
  if (!isRecord(value)) return undefined;
  const archive = typeof value.archive === 'string' ? value.archive.trim() : '';
  const cmd = typeof value.cmd === 'string' ? value.cmd.trim() : '';
  if (!archive || !cmd) return undefined;
  return {
    archive,
    cmd,
    args: toStringArray(value.args),
    env: toStringRecord(value.env),
  };
}

function normalizeBinaryDistribution(value) {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .map(([platform, entry]) => [platform.trim(), normalizeBinaryEntry(entry)])
    .filter(([platform, entry]) => !!platform && entry !== undefined);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

function normalizeDistribution(value) {
  if (!isRecord(value)) return null;

  const distribution = {
    npx: normalizeLauncher(value.npx),
    uvx: normalizeLauncher(value.uvx),
    binary: normalizeBinaryDistribution(value.binary),
  };

  return Object.values(distribution).some((launcher) => launcher !== undefined)
    ? distribution
    : null;
}

function normalizeRegistryAgent(agent) {
  if (!isRecord(agent)) return null;
  const id = typeof agent.id === 'string' ? agent.id.trim() : '';
  const name = typeof agent.name === 'string' ? agent.name.trim() : '';
  const version = typeof agent.version === 'string' ? agent.version.trim() : '';
  if (
    !id ||
    !name ||
    !version ||
    EXCLUDED_REMOTE_REGISTRY_AGENT_IDS.has(id) ||
    LOCAL_REGISTRY_AGENT_IDS.has(id)
  ) {
    return null;
  }

  const distribution = normalizeDistribution(agent.distribution);
  if (!distribution) {
    console.log(`Skipping agent '${id}' due to invalid or missing supported distribution`);
    return null;
  }

  return {
    id,
    name,
    version,
    description: typeof agent.description === 'string' ? agent.description : undefined,
    icon: typeof agent.icon === 'string' ? agent.icon : undefined,
    distribution,
  };
}

function normalizeLocalAgent(raw, id) {
  const launcher = LOCAL_REGISTRY_AGENTS[id];
  if (!launcher) return null;

  const rawRecord = isRecord(raw) ? raw : {};
  const rawName = typeof rawRecord.name === 'string' ? rawRecord.name.trim() : '';
  const rawVersion = typeof rawRecord.version === 'string' ? rawRecord.version.trim() : '';
  const fallback = LOCAL_REGISTRY_AGENT_FALLBACKS[id] ?? { name: id };

  const distribution = launcher.npx
    ? {
        npx: {
          package: launcher.npx.package,
          args: launcher.npx.args,
          env: launcher.npx.env,
        },
      }
    : {
        local: {
          command: launcher.command,
          args: launcher.args,
          versionArgs: launcher.versionArgs,
        },
      };

  return {
    id,
    name: rawName || fallback.name,
    version: rawVersion || fallback.version || 'local',
    description:
      typeof rawRecord.description === 'string' ? rawRecord.description : fallback.description,
    icon: typeof rawRecord.icon === 'string' ? rawRecord.icon : fallback.icon,
    distribution,
  };
}

function toTsObjectLiteral(value, indent = 0) {
  const space = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value
      .map((item) => `${'  '.repeat(indent + 1)}${toTsObjectLiteral(item, indent + 1)}`)
      .join(',\n')}\n${space}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '{}';
    return `{\n${entries
      .map(([k, v]) => {
        const key = /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : `'${k.replace(/'/g, "\\'")}'`;
        return `${'  '.repeat(indent + 1)}${key}: ${toTsObjectLiteral(v, indent + 1)}`;
      })
      .join(',\n')}\n${space}}`;
  }
  if (typeof value === 'string') {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }
  return String(value);
}

async function main() {
  const response = await fetch(REGISTRY_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch ACP registry: HTTP ${response.status}`);
  }

  const payload = await response.json();
  const agentsRaw = Array.isArray(payload?.agents) ? payload.agents : [];
  const agentsById = new Map(
    agentsRaw
      .filter((agent) => isRecord(agent))
      .map((agent) => [typeof agent.id === 'string' ? agent.id.trim() : '', agent])
      .filter(([id]) => !!id)
  );

  const normalizedRemote = agentsRaw
    .map((agent) => normalizeRegistryAgent(agent))
    .filter((agent) => agent !== null);

  const normalizedLocal = Array.from(LOCAL_REGISTRY_AGENT_IDS)
    .map((id) => normalizeLocalAgent(agentsById.get(id), id))
    .filter((agent) => agent !== null);

  const normalized = [...normalizedRemote, ...normalizedLocal].sort((a, b) =>
    a.id.localeCompare(b.id)
  );

  const generatedAt = new Date().toISOString();
  const fileContent = `/* eslint-disable */
// This file is auto-generated by scripts/generate-acp-registry.mjs
// Source: ${REGISTRY_URL}
// Generated at: ${generatedAt}

import type { RegistryAcpAgent } from '../ai';

export const ACP_REGISTRY_SOURCE_URL = '${REGISTRY_URL}';
export const ACP_REGISTRY_GENERATED_AT = '${generatedAt}';
export const EXCLUDED_REMOTE_REGISTRY_AGENT_IDS = ['claude-acp', 'claude-p', 'codex-acp', 'factory-droid', 'grok-build'] as const;

export const HARDCODED_REGISTRY_ACP_AGENTS: RegistryAcpAgent[] = ${toTsObjectLiteral([
    INTERACTIVE_CLAUDE_REGISTRY_AGENT,
    FACTORY_DROID_REGISTRY_AGENT,
  ])};

const REMOTE_REGISTRY_ACP_AGENTS: RegistryAcpAgent[] = ${toTsObjectLiteral(normalized)};

export const REGISTRY_ACP_AGENTS: RegistryAcpAgent[] = [
  ...HARDCODED_REGISTRY_ACP_AGENTS,
  ...REMOTE_REGISTRY_ACP_AGENTS
];
`;

  await writeFile(outputPath, fileContent, 'utf8');
  process.stdout.write(`Generated ${outputPath} with ${normalized.length} agents\\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\\n`);
  process.exitCode = 1;
});
