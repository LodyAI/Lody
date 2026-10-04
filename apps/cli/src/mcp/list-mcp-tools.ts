import {
  Client,
  StreamableHTTPClientTransport,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { version } from '@/pkg';
import {
  resolveSessionMcpServers,
  type ResolvedMcpServer,
  type WorkspaceMcpServerMeta,
  type McpToolListResult,
} from '@lody/shared';

export async function listMcpTools(
  server: WorkspaceMcpServerMeta,
  options: {
    env?: NodeJS.ProcessEnv;
    createTransport?: (server: ResolvedMcpServer) => Transport;
  } = {}
): Promise<McpToolListResult> {
  const env = options.env ?? process.env;
  const resolved = resolveSessionMcpServers({
    catalog: { [server.id]: server },
    selectedIds: [server.id],
    agentCapabilities: { http: true },
    env,
  });
  const target = resolved.servers[0];
  if (resolved.problems.length || !target)
    throw new Error('MCP connection configuration is incomplete.');
  let transport: Transport;
  if (options.createTransport) {
    transport = options.createTransport(target);
  } else if ('type' in target) {
    const url = URL.parse(target.url);
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('MCP HTTP URL must use HTTP(S) without embedded credentials.');
    transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        redirect: 'error',
        headers: Object.fromEntries(target.headers.map(({ name, value }) => [name, value])),
      },
    });
  } else {
    transport = new StdioClientTransport({
      command: target.command,
      args: target.args,
      stderr: 'ignore',
      env: Object.fromEntries(target.env.map(({ name, value }) => [name, value])),
    });
  }

  const client = new Client(
    { name: 'lody-settings', version },
    { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 5_000 } }, listMaxPages: 100 }
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    await client.connect(transport, { signal: controller.signal });
    const result = await client.listTools(undefined, { signal: controller.signal });
    if (result.tools.length > 2000) throw new Error('MCP tool discovery exceeded its bounds.');
    const tools = new Map(
      result.tools.map(({ name, description }) => [name, { name, description }])
    );
    return { type: 'mcp/tools', tools: [...tools.values()] };
  } catch {
    // MCP errors may include credential-bearing URLs or subprocess output.
    throw new Error('MCP tool discovery failed.');
  } finally {
    clearTimeout(timeout);
    await client.close().catch(() => {
      throw new Error('MCP connection cleanup failed.');
    });
  }
}
