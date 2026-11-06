import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createToolHelpServer } from './tool-help';

describe('Lody command help over MCP', () => {
  it('loads full command documentation on demand without running the command or changing validation', async () => {
    const server = new McpServer({ name: 'lody-help-test', version: '1' });
    const tools = createToolHelpServer(server);
    const workspaces: string[] = [];
    const description =
      'Create a Lody session. A local independent session uses the original project directory; a Tab shares the current worktree.';
    const summary = 'Delegate work to a new conversation with shared or isolated code.';
    tools.registerTool(
      'lody_session_create',
      {
        summary,
        title: 'Create a Lody session',
        description,
        inputSchema: z.object({ projectId: z.string().min(1) }).strict(),
      },
      async ({ projectId }) => {
        workspaces.push(projectId);
        return { content: [{ type: 'text', text: JSON.stringify({ projectId }) }] };
      }
    );
    const client = new Client({ name: 'help-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools: catalog } = await client.listTools();
      const create = catalog.find(({ name }) => name === 'lody_session_create');
      expect(create?.description).toBe(
        `${summary} Before execution, read lody_help({command:"lody_session_create"}); reuse only if full help remains in context.`
      );
      expect(create?.description).toContain('lody_help');
      expect(create?.description).not.toContain('original project directory');
      expect(create?.inputSchema).toMatchObject({
        required: ['projectId'],
        additionalProperties: false,
      });
      const help = CallToolResultSchema.parse(
        await client.callTool({
          name: 'lody_help',
          arguments: { command: 'lody_session_create' },
        })
      );
      const text = help.content.find((block) => block.type === 'text');
      if (!text || text.type !== 'text') throw new Error('Missing command help');
      expect(JSON.parse(text.text)).toMatchObject({
        command: 'lody_session_create',
        description,
        inputSchema: create?.inputSchema,
      });
      const index = CallToolResultSchema.parse(
        await client.callTool({ name: 'lody_help', arguments: {} })
      );
      const indexText = index.content.find((block) => block.type === 'text');
      if (!indexText || indexText.type !== 'text') throw new Error('Missing help index');
      expect(JSON.parse(indexText.text)).toEqual({
        commands: [{ name: 'lody_session_create', summary }],
      });
      expect(
        await client.callTool({ name: 'lody_help', arguments: { command: '../private-file' } })
      ).toMatchObject({ isError: true });
      expect(workspaces).toEqual([]);

      expect(await client.callTool({ name: 'lody_session_create', arguments: {} })).toMatchObject({
        isError: true,
      });
      expect(workspaces).toEqual([]);
      expect(
        await client.callTool({
          name: 'lody_session_create',
          arguments: { projectId: 'synthetic-project' },
        })
      ).not.toMatchObject({ isError: true });
      expect(workspaces).toEqual(['synthetic-project']);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
