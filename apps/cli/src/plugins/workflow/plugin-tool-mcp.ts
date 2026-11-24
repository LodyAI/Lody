import {
  persistPluginToolResult,
  readPluginToolResult,
  type PluginResultCustody,
} from '../tool-result-history';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { NodeStreamableHTTPServerTransport, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { Effect } from 'effect';
import type { PluginRuntime } from '../plugin-runtime';
import { Registry } from './plugin-registry';
import type { PluginToolTurn } from './plugin-registry';

export async function bindPluginToolMcp(
  runtime: PluginRuntime,
  turn: PluginToolTurn,
  custody: (toolCallId: string, signal: AbortSignal) => Promise<PluginResultCustody>
) {
  const authorization = `Bearer ${randomBytes(32).toString('hex')}`;
  const lifetime = new AbortController();
  const artifacts = new Map<string, PluginResultCustody>();
  let closed = false;
  const current = () => !closed && turn.isCurrent();
  const server = createServer((req, res) => {
    void (async () => {
      if (
        req.method !== 'POST' ||
        req.url !== '/mcp' ||
        req.headers.authorization !== authorization ||
        !current()
      ) {
        res.writeHead(403).end();
        return;
      }
      const catalog = await runtime.runPromise(Effect.map(Registry, (r) => r.sessionTools()));
      if (!current()) {
        res.writeHead(403).end();
        return;
      }
      const build = () => {
        const mcp = new McpServer({ name: 'lody-plugin-tools', version: '1' });
        for (const tool of catalog) {
          if (tool.inputSchema.type !== 'object') continue;
          mcp.registerTool(
            tool.name,
            {
              description: tool.description,
              inputSchema: z.fromJSONSchema(tool.inputSchema) as z.ZodObject,
            },
            async (args) => {
              let dispatchedId: string | undefined;
              const result = await runtime.runPromise(
                Effect.flatMap(Registry, (r) =>
                  r.invokeSessionTool(tool.name, z.json().parse(args), {
                    ...turn,
                    isCurrent: current,
                    onDispatch: (id) => {
                      dispatchedId = id;
                    },
                  })
                )
              );
              if (!dispatchedId || !current()) throw Error('Plugin turn ended');
              const owner = await custody(dispatchedId, lifetime.signal);
              if (!current()) throw Error('Plugin turn ended');
              const text = await persistPluginToolResult(owner, result);
              const ref: unknown = JSON.parse(text);
              if (
                ref &&
                typeof ref === 'object' &&
                'type' in ref &&
                ref.type === 'plugin-tool-artifact' &&
                'toolCallId' in ref &&
                ref.toolCallId === owner.toolCallId
              )
                artifacts.set(owner.toolCallId, owner);
              return { content: [{ type: 'text', text }] };
            }
          );
        }
        mcp.registerTool(
          'read_plugin_tool_result',
          {
            description: 'Read a page of a plugin tool result from this turn.',
            inputSchema: z.object({
              toolCallId: z.string(),
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
              offset: z.number().int().nonnegative().default(0),
            }),
          },
          async ({ toolCallId, sha256, offset }) => {
            const owner = artifacts.get(toolCallId);
            if (!owner || !current()) throw Error('Plugin result unavailable');
            const body = await readPluginToolResult(owner, sha256);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    text: body.slice(offset, offset + 2048),
                    nextOffset: offset + 2048 < body.length ? offset + 2048 : null,
                  }),
                },
              ],
            };
          }
        );
        return mcp;
      };
      if (req.headers['mcp-protocol-version'] === '2026-07-28') {
        const handler = createMcpHandler(build);
        res.once('close', () => void handler.close());
        await toNodeHandler(handler)(req, res);
      } else {
        const mcp = build();
        const transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.once('close', () => void mcp.close());
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
      }
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  const ready = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await ready;
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw Error('Missing plugin endpoint');
  }
  return {
    entry: {
      type: 'http' as const,
      name: 'lody-plugin-tools',
      url: `http://127.0.0.1:${address.port}/mcp`,
      headers: [{ name: 'Authorization', value: authorization }],
    },
    release: async () => {
      closed = true;
      lifetime.abort();
      artifacts.clear();
      server.closeAllConnections();
      server.close();
    },
  };
}
