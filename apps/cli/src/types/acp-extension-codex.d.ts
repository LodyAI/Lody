declare module 'acp-extension-codex';
declare module 'acp-extension-codex/dist/lody.js';

declare module 'acp-extension-codex/baseline-config' {
  import type { SessionConfigOption } from '@agentclientprotocol/sdk';

  type BaselineAcpCapabilities = {
    modes: Array<{ id: string; name: string; description?: string }>;
    models: Array<{ modelId: string; name?: string; description?: string }>;
    configOptions: SessionConfigOption[];
  };

  export function getCodexBaselineConfig(): BaselineAcpCapabilities;
}

declare module 'acp-extension-claude/baseline-config' {
  import type { SessionConfigOption } from '@agentclientprotocol/sdk';

  type BaselineAcpCapabilities = {
    modes: Array<{ id: string; name: string; description?: string }>;
    models: Array<{ modelId: string; name?: string; description?: string }>;
    configOptions: SessionConfigOption[];
  };

  export function getClaudeBaselineConfig(): BaselineAcpCapabilities;
}
