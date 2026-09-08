// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerId } from '@lody/shared';
import {
  useSessionMcpSelection,
  type SessionMcpSelection,
} from '../src/hooks/use-session-mcp-selection';

vi.mock('../src/hooks/use-workspace-mcp-catalog', () => ({
  useWorkspaceMcpCatalog: () => ({ servers: [], synced: true }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('useSessionMcpSelection', () => {
  let root: Root;
  let container: HTMLDivElement;
  let selection: SessionMcpSelection | undefined;
  const missingId = 'missing' as McpServerId;

  function Probe({ mcpSupported }: { mcpSupported?: boolean }) {
    selection = useSessionMcpSelection([missingId], { mcpSupported });
    return null;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('preserves unsupported selections for cleanup even when their catalog rows are absent', async () => {
    await act(async () => root.render(<Probe mcpSupported={false} />));

    expect(selection?.selectedIds).toEqual([missingId]);
    expect(selection?.menu).toBeDefined();

    await act(async () => selection?.menu?.onSelectedIdsChange([]));
    expect(selection?.selectedIds).toEqual([]);

    await act(async () => root.render(<Probe />));
    expect(selection?.menu).toBeUndefined();
  });
});
