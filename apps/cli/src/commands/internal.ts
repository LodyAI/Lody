import { Command } from 'commander';
import { buildLodyMcpServer } from '@/mcp/lody-mcp-server';
import { serveStdioMcp, stdioMcpConnectionLayer } from '@/mcp/stdio/lifecycle';
import { Effect, Exit } from 'effect';
import { runLodyMcpHttpHost } from '@/mcp/lody-mcp-http-host';

export const internalCommand = new Command('__internal')
  .description('(internal) Lody helper commands')
  .addCommand(
    new Command('lody-mcp-server')
      .description('(internal) stdio MCP server for Lody session tools')
      .action(async () => {
        const result = await Effect.runPromiseExit(
          serveStdioMcp.pipe(
            Effect.provide(
              stdioMcpConnectionLayer({
                createServer: buildLodyMcpServer,
                stdin: process.stdin,
                stdout: process.stdout,
                signals: process,
              })
            )
          )
        );
        if (Exit.isFailure(result)) {
          throw new AggregateError(
            result.cause.reasons.map((reason) =>
              reason._tag === 'Fail' ? reason.error : reason._tag === 'Die' ? reason.defect : reason
            ),
            'MCP stdio lifecycle failed'
          );
        }
      })
  )
  .addCommand(
    new Command('lody-mcp-http-host')
      .description('(internal) shared HTTP MCP host for Lody session tools')
      .action(async () => {
        await runLodyMcpHttpHost();
      })
  );
