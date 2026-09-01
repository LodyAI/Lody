import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import {
  ACP_CAPABILITY_CACHE_VERSION,
  getAcpCapabilityCacheKey,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
  type MachineViewMeta,
} from '@lody/shared';
import {
  AgentConfigDialog,
  type AgentConfigDialogProps,
  DEEPSEEK_CLAUDE_PRESET_ID,
  GLM_CLAUDE_PRESET_ID,
  GLM_ZAI_CREDENTIAL_MODE_ID,
  MIMO_CLAUDE_PRESET_ID,
  MIMO_TOKEN_PLAN_CREDENTIAL_MODE_ID,
  MINIMAX_CLAUDE_PRESET_ID,
} from '@/components/settings/agent-config-dialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/ui/dialog';

const machineId = 'machine-story' as MachineId;
const existingConfigId = 'cfg-claude' as AgentConfigId;

const makeMachineWithClaudeCaps = (): MachineViewMeta => ({
  id: machineId,
  name: 'Workstation',
  cliVersion: '0.44.0',
  os: 'macOS',
  sessions: [],
  raceLimits: {},
  acpCapabilities: {
    [getAcpCapabilityCacheKey(existingConfigId)]: {
      cliType: 'builtin',
      agentType: 'claude',
      cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
      sourceVersion: 'claude-code@1.0.0',
      modes: [],
      models: [],
      configOptions: [],
      availableCommands: [],
      fetchedAt: Date.now(),
    },
  },
});

/** Plain built-in Claude Code: signs in through Claude, so the detail offers it. */
const existingConfig: AgentConfigMeta = {
  id: existingConfigId,
  machineId,
  name: 'Claude Code',
  description: undefined,
  cliType: 'builtin',
  agentType: 'claude',
  env: {},
};

/** DeepSeek preset: runs as built-in Claude Code but authenticates through env
 *  vars, so the detail must not offer a provider sign-in. */
const envCredentialConfig: AgentConfigMeta = {
  id: existingConfigId,
  machineId,
  name: 'DeepSeek over Claude Code',
  description: undefined,
  cliType: 'builtin',
  agentType: 'claude',
  brandId: 'deepseek',
  env: {
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'sk-storybook-demo-token',
  },
};

const refreshCapabilities: AgentConfigDialogProps['onRefreshCapabilities'] = async (args) => ({
  type: 'machine/acp-capabilities-refresh_response',
  machineId: args.machineId,
  configId: args.configId,
  cliType: 'builtin',
  agentType: 'claude',
  success: true,
  modes: [],
  models: [],
});

function CreateWrapper() {
  const [open, setOpen] = useState(true);
  return (
    <AgentConfigDialog
      open={open}
      onOpenChange={setOpen}
      mode={{ kind: 'create' }}
      machine={makeMachineWithClaudeCaps()}
      onSubmit={async () => {}}
      onRefreshCapabilities={refreshCapabilities}
    />
  );
}

function NestedCreateWrapper() {
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [providerOpen, setProviderOpen] = useState(true);

  return (
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent
        noAnimation
        className="h-[min(90vh,950px)] w-[84vw] max-w-[1100px] overflow-hidden p-0 sm:p-0"
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">Nested provider dialog preview</DialogDescription>
        <div className="flex h-full">
          <aside className="w-56 border-r border-border bg-background p-4">
            <div className="rounded-lg bg-secondary px-3 py-2 text-sm font-medium">Agents</div>
          </aside>
          <main className="flex-1 bg-background p-8">
            <h2 className="text-xl font-semibold">Agent Provider</h2>
            <div className="mt-4 h-24 rounded-lg border border-border bg-card" />
          </main>
        </div>
        <AgentConfigDialog
          open={providerOpen}
          onOpenChange={setProviderOpen}
          nestedInDialog
          mode={{ kind: 'create' }}
          machine={makeMachineWithClaudeCaps()}
          onSubmit={async () => {}}
          onRefreshCapabilities={refreshCapabilities}
        />
      </DialogContent>
    </Dialog>
  );
}

function EditWrapper({ config = existingConfig }: { config?: AgentConfigMeta }) {
  const [open, setOpen] = useState(true);
  return (
    <AgentConfigDialog
      open={open}
      onOpenChange={setOpen}
      mode={{ kind: 'edit', config }}
      machine={makeMachineWithClaudeCaps()}
      onSubmit={async () => {}}
      onRefreshCapabilities={refreshCapabilities}
    />
  );
}

function DeepSeekPresetWrapper() {
  const [open, setOpen] = useState(true);
  return (
    <AgentConfigDialog
      open={open}
      onOpenChange={setOpen}
      mode={{
        kind: 'create',
        initialForm: {
          name: 'DeepSeek over Claude Code',
          presetId: DEEPSEEK_CLAUDE_PRESET_ID,
          presetToken: 'sk-storybook-demo-token',
        },
      }}
      machine={makeMachineWithClaudeCaps()}
      onSubmit={async () => {}}
      onRefreshCapabilities={refreshCapabilities}
    />
  );
}

function DeepSeekHarnessWrapper() {
  const [open, setOpen] = useState(true);
  return (
    <AgentConfigDialog
      open={open}
      onOpenChange={setOpen}
      mode={{
        kind: 'create',
        initialForm: {
          name: 'DeepSeek Harness',
          cliType: 'builtin',
          agentType: 'deepseek',
          env: {
            DEEPSEEK_API_KEY: 'sk-storybook-demo-token',
          },
        },
      }}
      machine={makeMachineWithClaudeCaps()}
      onSubmit={async () => {}}
      onRefreshCapabilities={refreshCapabilities}
    />
  );
}

function MiMoPresetWrapper() {
  const [open, setOpen] = useState(true);
  return (
    <AgentConfigDialog
      open={open}
      onOpenChange={setOpen}
      mode={{
        kind: 'create',
        initialForm: {
          name: 'MiMo over Claude Code',
          presetId: MIMO_CLAUDE_PRESET_ID,
          presetToken: 'sk-storybook-demo-token',
        },
      }}
      machine={makeMachineWithClaudeCaps()}
      onSubmit={async () => {}}
      onRefreshCapabilities={refreshCapabilities}
    />
  );
}

function MiMoTokenPlanPresetWrapper() {
  const [open, setOpen] = useState(true);
  return (
    <AgentConfigDialog
      open={open}
      onOpenChange={setOpen}
      mode={{
        kind: 'create',
        initialForm: {
          name: 'MiMo over Claude Code',
          presetId: MIMO_CLAUDE_PRESET_ID,
          presetCredentialModeId: MIMO_TOKEN_PLAN_CREDENTIAL_MODE_ID,
          presetBaseUrlOptionId: 'sgp',
          presetToken: 'tp-storybook-demo-token',
        },
      }}
      machine={makeMachineWithClaudeCaps()}
      onSubmit={async () => {}}
      onRefreshCapabilities={refreshCapabilities}
    />
  );
}

function MiniMaxPresetWrapper() {
  const [open, setOpen] = useState(true);
  return (
    <AgentConfigDialog
      open={open}
      onOpenChange={setOpen}
      mode={{
        kind: 'create',
        initialForm: {
          name: 'MiniMax over Claude Code',
          presetId: MINIMAX_CLAUDE_PRESET_ID,
          presetToken: 'minimax-storybook-demo-token',
        },
      }}
      machine={makeMachineWithClaudeCaps()}
      onSubmit={async () => {}}
      onRefreshCapabilities={refreshCapabilities}
    />
  );
}

function GlmPresetWrapper({ credentialModeId }: { credentialModeId?: string } = {}) {
  const [open, setOpen] = useState(true);
  return (
    <AgentConfigDialog
      open={open}
      onOpenChange={setOpen}
      mode={{
        kind: 'create',
        initialForm: {
          name: 'GLM over Claude Code',
          presetId: GLM_CLAUDE_PRESET_ID,
          ...(credentialModeId ? { presetCredentialModeId: credentialModeId } : {}),
          presetToken: 'glm-storybook-demo-token',
        },
      }}
      machine={makeMachineWithClaudeCaps()}
      onSubmit={async () => {}}
      onRefreshCapabilities={refreshCapabilities}
    />
  );
}

const meta = {
  title: 'Settings/AgentConfigDialog',
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Create: Story = {
  render: () => <CreateWrapper />,
};

export const NestedInSettings: Story = {
  render: () => <NestedCreateWrapper />,
};

export const Edit: Story = {
  render: () => <EditWrapper />,
};

/** Signing in again lives here, not on the provider list row. */
export const EditEnvCredentialProvider: Story = {
  render: () => <EditWrapper config={envCredentialConfig} />,
};

export const DeepSeekPreset: Story = {
  render: () => <DeepSeekPresetWrapper />,
};

export const DeepSeekHarness: Story = {
  render: () => <DeepSeekHarnessWrapper />,
};

export const MiMoPreset: Story = {
  render: () => <MiMoPresetWrapper />,
};

export const MiMoTokenPlanPreset: Story = {
  render: () => <MiMoTokenPlanPresetWrapper />,
};

export const MiniMaxPreset: Story = {
  render: () => <MiniMaxPresetWrapper />,
};

export const GlmPreset: Story = {
  render: () => <GlmPresetWrapper />,
};

export const GlmZaiPreset: Story = {
  render: () => <GlmPresetWrapper credentialModeId={GLM_ZAI_CREDENTIAL_MODE_ID} />,
};

/**
 * Mobile / narrow viewport: dialog fills the screen and runs a 2-step flow —
 * first picker, then form (with a back button). Toggle the Storybook viewport
 * to "mobile1" to see it, or just resize the window below 768px.
 */
export const Mobile: Story = {
  render: () => <CreateWrapper />,
  parameters: {
    viewport: { defaultViewport: 'mobile1' },
  },
};

export const MobileEdit: Story = {
  render: () => <EditWrapper />,
  parameters: {
    viewport: { defaultViewport: 'mobile1' },
  },
};

export const MobileEditEnvCredentialProvider: Story = {
  render: () => <EditWrapper config={envCredentialConfig} />,
  parameters: {
    viewport: { defaultViewport: 'mobile1' },
  },
};

export const MobileDeepSeekPreset: Story = {
  render: () => <DeepSeekPresetWrapper />,
  parameters: {
    viewport: { defaultViewport: 'mobile1' },
  },
};

export const MobileMiMoPreset: Story = {
  render: () => <MiMoPresetWrapper />,
  parameters: {
    viewport: { defaultViewport: 'mobile1' },
  },
};

export const MobileMiniMaxPreset: Story = {
  render: () => <MiniMaxPresetWrapper />,
  parameters: {
    viewport: { defaultViewport: 'mobile1' },
  },
};

export const MobileGlmPreset: Story = {
  render: () => <GlmPresetWrapper />,
  parameters: {
    viewport: { defaultViewport: 'mobile1' },
  },
};
