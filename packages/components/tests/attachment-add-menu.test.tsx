// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerId, WorkspaceMcpServerMeta } from '@lody/shared';
import { AttachmentAddMenu } from '../src/components/chat/attachment-add-menu';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class TestPointerEvent extends MouseEvent {
  readonly pointerType: string;

  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? '';
  }
}

describe('AttachmentAddMenu', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await initI18n('en');
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('offers one attachment action for the unified picker', async () => {
    const onAddAttachment = vi.fn();
    await act(async () => {
      root.render(<AttachmentAddMenu isMobile={false} onAddAttachment={onAddAttachment} />);
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Add attachment"]'
    );
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger!.dispatchEvent(
        new TestPointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          pointerType: 'mouse',
        })
      );
    });

    const items = document.body.querySelectorAll<HTMLElement>('[role="menuitem"]');
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain('Add attachment');
    expect(document.body.textContent).not.toContain('Upload image');
    expect(document.body.textContent).not.toContain('Upload file');

    await act(async () => items[0]!.click());
    expect(onAddAttachment).toHaveBeenCalledOnce();
  });

  it('keeps unsupported MCP visible so existing selections can be removed but not added', async () => {
    const selectedServerId = 'selected' as McpServerId;
    const unavailableServerId = 'unavailable' as McpServerId;
    const missingServerId = 'missing' as McpServerId;
    const servers = [
      {
        id: selectedServerId,
        name: 'Selected server',
        transport: 'stdio',
        connection: { transport: 'stdio', command: 'selected' },
      },
      {
        id: unavailableServerId,
        name: 'Unavailable server',
        transport: 'stdio',
        connection: { transport: 'stdio', command: 'unavailable' },
      },
    ] as WorkspaceMcpServerMeta[];

    function UnsupportedMcpMenu() {
      const [selectedIds, setSelectedIds] = useState<McpServerId[]>([
        selectedServerId,
        missingServerId,
      ]);
      return (
        <AttachmentAddMenu
          isMobile
          mcp={{
            servers,
            selectedIds,
            onSelectedIdsChange: setSelectedIds,
            mcpSupported: false,
          }}
        />
      );
    }

    await act(async () => root.render(<UnsupportedMcpMenu />));
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Add attachment"]'
    );
    await act(async () => {
      trigger!.dispatchEvent(
        new TestPointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          pointerType: 'mouse',
        })
      );
    });

    const unsupportedEntry = [
      ...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((item) => item.textContent?.includes('MCP unavailable'));
    expect(unsupportedEntry).toBeDefined();
    await act(async () => unsupportedEntry!.click());

    expect(document.body.textContent).toContain(
      "This agent doesn't support MCP. Workspace MCP servers and Lody's built-in tools are unavailable."
    );
    const checkboxes = [
      ...document.body.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'),
    ];
    const selectedRow = checkboxes.find((item) => item.textContent?.includes('Selected server'));
    const unavailableRow = checkboxes.find((item) =>
      item.textContent?.includes('Unavailable server')
    );
    expect(selectedRow?.hasAttribute('data-disabled')).toBe(false);
    expect(unavailableRow?.hasAttribute('data-disabled')).toBe(true);

    await act(async () => selectedRow!.click());
    expect(selectedRow?.getAttribute('data-state')).toBe('unchecked');

    const clear = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === 'Clear MCP selection'
    );
    expect(clear).toBeDefined();
    await act(async () => clear!.click());
    expect(document.body.textContent).not.toContain('Clear MCP selection');
  });
});
