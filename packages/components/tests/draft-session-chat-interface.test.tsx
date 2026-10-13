// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta, WorkspaceMcpServerMeta } from '@lody/shared';
import type { SessionChatInputAreaProps } from '../src/components/sessions/session-chat-input-area';
import { createDraftSessionTab } from '../src/lib/session-draft-tabs';
import { DraftSessionChatInterface } from '../src/components/sessions/draft-session-chat-interface';
import type { DraftSessionSendPayload } from '../src/components/sessions/draft-session-chat-interface';

const catalog = vi.hoisted(() => ({ servers: [] as WorkspaceMcpServerMeta[], synced: true }));
vi.mock('../src/hooks/use-workspace-mcp-catalog', () => ({
  useWorkspaceMcpCatalog: () => catalog,
}));
vi.mock('../src/theme-provider', () => ({ useResolvedTheme: () => 'light' }));
vi.mock('../src/hooks/use-workspace-agent-roles', () => ({
  useWorkspaceAgentRoles: () => ({ roles: [] }),
  useAgentRoleAvailability: () => ({ resolve: () => ({ kind: 'available' }) }),
}));
vi.mock('../src/hooks/use-session-doc', () => ({
  useSessionDoc: () => ({ doc: { mq: [] }, history: null, ready: false }),
}));
vi.mock('../src/hooks/use-conversation-view', () => ({
  useConversationTail: () => ({ from: 0 }),
  useConversationVersion: () => 0,
}));
vi.mock('../src/hooks/use-session-acp-selector-context', () => ({
  useSessionAcpSelectorContext: () => ({
    availableCommands: [],
    configOptionSelectors: [],
    machineFlockRows: [],
    modeOptions: [],
    modelOptions: [],
    selectorOptions: {},
    sessionMachine: undefined,
  }),
}));
vi.mock('../src/hooks/use-acp-session-config-selection', () => ({
  useAcpSessionConfigSelectionState: () => ({
    selection: {},
    candidates: {},
    selectMode: () => {},
    selectModel: () => {},
    selectConfigOption: () => {},
  }),
  useResolvedAcpSessionConfigSelection: () => ({
    selectedModeId: null,
    selectedModelId: null,
    configOptionValues: {},
    configOptionSelectors: [],
  }),
}));
vi.mock('../src/hooks/use-composer-cycle-commands', () => ({ useComposerCycleCommands: () => {} }));
vi.mock('../src/components/mentions/issue-pr-hash-mention', () => ({
  useKnownIssuePrItems: () => ({ knownItems: [] }),
  extractIssuePRMentionsFromText: () => [],
}));
vi.mock('../src/components/sessions/child-tab-empty-state', () => ({
  ChildTabEmptyState: () => null,
}));

// Keep the draft owner, selection hook and first-turn builder real. Substitute
// only the large input surface with controls that consume its public contract.
vi.mock('../src/components/sessions/session-chat-input-area', () => ({
  SessionChatInputArea: ({ mcp, onSendMessage }: SessionChatInputAreaProps) => (
    <>
      {mcp?.servers.map((server) => (
        <label key={server.id}>
          {server.name}
          <input
            type="checkbox"
            aria-label={server.name}
            checked={mcp.selectedIds.includes(server.id)}
            onChange={(event) =>
              mcp.onSelectedIdsChange(
                event.target.checked
                  ? [...mcp.selectedIds, server.id]
                  : mcp.selectedIds.filter((id) => id !== server.id)
              )
            }
          />
        </label>
      ))}
      <button onClick={() => onSendMessage([{ type: 'text', text: 'Synthetic task' }], null)}>
        Send
      </button>
    </>
  ),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('draft session MCP selection', () => {
  let root: Root;
  let container: HTMLDivElement;
  let accepted: DraftSessionSendPayload[];

  beforeEach(async () => {
    catalog.servers = [
      {
        id: 'synthetic-mcp' as WorkspaceMcpServerMeta['id'],
        name: 'Synthetic MCP',
        transport: 'stdio',
        connection: { transport: 'stdio', command: 'synthetic' },
        enabledByDefault: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    accepted = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function renderDraft() {
    const draft = createDraftSessionTab({
      cliType: 'builtin',
      agentType: 'codex',
      modeId: null,
      modelId: null,
    });
    await act(async () =>
      root.render(
        <DraftSessionChatInterface
          draft={draft}
          parentSession={{ id: 'synthetic-parent', machineId: 'synthetic-machine' } as SessionMeta}
          onDraftChange={() => {}}
          onSendDraft={async (payload) => {
            accepted.push(payload);
            return true;
          }}
        />
      )
    );
  }

  it('offers MCP before the first message and includes the edited selection in the first turn', async () => {
    await renderDraft();
    const checkbox = container.querySelector<HTMLInputElement>('input[aria-label="Synthetic MCP"]');
    expect(checkbox).not.toBeNull();
    expect(checkbox!.checked).toBe(false);
    await act(async () => checkbox!.click());
    expect(checkbox!.checked).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(accepted[0]?.inputConfig.mcpServerIds).toEqual(['synthetic-mcp']);
    await act(async () => checkbox!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(accepted[1]?.inputConfig.mcpServerIds).toEqual([]);
  });

  it('hides the picker for an empty catalog and still sends an explicit empty selection', async () => {
    catalog.servers = [];
    await renderDraft();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(accepted[0]?.inputConfig.mcpServerIds).toEqual([]);
  });
});
