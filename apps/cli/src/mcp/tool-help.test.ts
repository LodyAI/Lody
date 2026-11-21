import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createToolHelpServer } from './tool-help';
import { createSessionToolRegistrar, type SessionToolHandlers } from './session-tool-router';

describe('Lody command help over MCP', () => {
  it('loads full command documentation on demand without running the command or changing validation', async () => {
    const server = new McpServer({ name: 'lody-help-test', version: '1' });
    const tools = createToolHelpServer(server);
    const handlers: SessionToolHandlers = new Map();
    const register = createSessionToolRegistrar(
      tools,
      async (_name, _args, execute) => execute(),
      handlers
    );
    const workspaces: string[] = [];
    const description =
      'Create a Lody session. A local independent session uses the original project directory; a Tab shares the current worktree.';
    const summary = 'Delegate work to a new conversation with shared or isolated code.';
    register(
      'lody_session_create',
      {
        summary,
        title: 'Create a Lody session',
        description,
        inputSchema: z
          .object({
            projectId: z.string().trim().min(1).describe('Registered project id.'),
            workContext: z
              .object({
                kind: z.enum(['chat', 'local']).describe('Directory choice; rules in help.'),
                description: z.string().max(80).optional().describe('A field named description.'),
                at: z.string().datetime().optional(),
              })
              .strict()
              .optional()
              .describe('Independent directory.'),
          })
          .strict(),
      },
      async ({ projectId }) => {
        if (projectId === 'unavailable') {
          return {
            isError: true,
            structuredContent: { error: { code: 'PROJECT_NOT_FOUND', retryable: false } },
            content: [{ type: 'text', text: 'Project not found.' }],
          };
        }
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
      // The help-first rule is stated once in server instructions, not per tool.
      expect(create?.description).toBe(summary);
      expect(create?.description).not.toContain('original project directory');
      // Eager schema: structure, bounds and top-level phrases only; nested prose is help-only.
      expect(create?.inputSchema).toEqual({
        type: 'object',
        properties: {
          projectId: { description: 'Registered project id.', type: 'string', minLength: 1 },
          workContext: {
            description: 'Independent directory.',
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['chat', 'local'] },
              description: { type: 'string', maxLength: 80 },
              at: { type: 'string', format: 'date-time' },
            },
            required: ['kind'],
            additionalProperties: false,
          },
        },
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
        inputSchema: {
          properties: {
            workContext: {
              properties: {
                kind: { description: 'Directory choice; rules in help.' },
                description: { description: 'A field named description.' },
              },
            },
          },
        },
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

      const invalid = CallToolResultSchema.parse(
        await client.callTool({ name: 'lody_session_create', arguments: {} })
      );
      expect(invalid).toMatchObject({
        isError: true,
        content: expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: expect.stringContaining('projectId') }),
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('lody_help({command:"lody_session_create"})'),
          }),
        ]),
      });
      const daemonHandler = handlers.get('lody_session_create');
      if (!daemonHandler) throw new Error('Missing daemon command');
      await expect(daemonHandler({})).rejects.toMatchObject({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'invalid_type', path: ['projectId'] }),
          expect.objectContaining({
            code: 'custom',
            message: expect.stringContaining('lody_help({command:"lody_session_create"})'),
          }),
        ]),
      });
      expect(workspaces).toEqual([]);
      const rejected = CallToolResultSchema.parse(
        await client.callTool({
          name: 'lody_session_create',
          arguments: { projectId: 'unavailable' },
        })
      );
      expect(rejected).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'PROJECT_NOT_FOUND', retryable: false } },
        content: expect.arrayContaining([
          { type: 'text', text: 'Project not found.' },
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('lody_help({command:"lody_session_create"})'),
          }),
        ]),
      });
      expect(workspaces).toEqual([]);
      expect(
        await client.callTool({
          name: 'lody_session_create',
          arguments: { projectId: ' synthetic-project ' },
        })
      ).not.toMatchObject({ isError: true });
      expect(workspaces).toEqual(['synthetic-project']);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it('includes command help in modern HTTP validation errors without executing work', async () => {
    const workspaces: string[] = [];
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: 'lody-help-http', version: '1' });
      createToolHelpServer(server).registerTool(
        'lody_session_create',
        {
          summary: 'Delegate work to a new conversation.',
          inputSchema: z.object({ projectId: z.string().min(1) }).strict(),
        },
        async ({ projectId }) => {
          workspaces.push(projectId);
          return { content: [{ type: 'text', text: 'Created' }] };
        }
      );
      return server;
    });
    try {
      const response = await handler.fetch(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-method': 'tools/call',
            'mcp-name': 'lody_session_create',
            'mcp-protocol-version': '2026-07-28',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'lody_session_create',
              arguments: {},
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': { name: 'help-test', version: '1' },
                'io.modelcontextprotocol/clientCapabilities': {},
              },
            },
          }),
        })
      );
      const result: unknown = await response.json();
      expect(JSON.stringify(result)).toContain('projectId');
      expect(JSON.stringify(result)).toContain('lody_help');
      expect(workspaces).toEqual([]);
    } finally {
      await handler.close();
    }
  });
});
