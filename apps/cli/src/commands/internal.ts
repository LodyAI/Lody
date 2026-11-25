import { Command } from 'commander';
import { buildLodyMcpServer } from '@/mcp/lody-mcp-server';
import { serveStdioMcp, stdioMcpConnectionLayer } from '@/mcp/stdio/lifecycle';
import { Effect, Exit } from 'effect';
import { runLodyMcpHttpHost } from '@/mcp/lody-mcp-http-host';
import {
  connectSorbetApiKey,
  connectSorbetCustomProvider,
  describeImportSource,
  disconnectSorbetProvider,
  probeSorbetArrival,
  readConnectionSources,
  runSorbetImportSource,
  runSorbetOAuthLogin,
} from '@/lib/sorbet-onboarding-control';
import {
  SorbetConnectApiKeyInputSchema,
  SorbetConnectCustomProviderInputSchema,
  SorbetImportRequestSchema,
  SorbetStartOAuthInputSchema,
  type ImportSourceId,
} from '@lody/shared/electron-ipc';

async function readStdinJson(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function writeJsonLine(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

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
  )
  .addCommand(
    new Command('sorbet-onboarding')
      .description('(internal) headless Sorbet control operations for onboarding and settings')
      .argument('<action>', 'operation name')
      .action(async (action: string) => {
        if (action === 'probe') {
          writeJsonLine(await probeSorbetArrival());
          return;
        }
        if (action === 'sources') {
          writeJsonLine(readConnectionSources());
          return;
        }
        if (action === 'oauth-login') {
          const payload = SorbetStartOAuthInputSchema.parse(await readStdinJson());
          const controller = new AbortController();
          const abort = () => controller.abort();
          process.once('SIGTERM', abort);
          process.once('SIGINT', abort);
          try {
            await runSorbetOAuthLogin(payload.providerId, (event) => writeJsonLine(event), {
              signal: controller.signal,
            });
          } catch (error) {
            if (!controller.signal.aborted) {
              writeJsonLine({
                event: 'error',
                error: error instanceof Error ? error.message : String(error),
              });
              process.exitCode = 1;
            }
          } finally {
            process.removeListener('SIGTERM', abort);
            process.removeListener('SIGINT', abort);
          }
          return;
        }

        const input = await readStdinJson();
        if (action === 'describe-import') {
          const source = input.source as ImportSourceId;
          writeJsonLine(describeImportSource(source));
          return;
        }
        if (action === 'import') {
          const request = SorbetImportRequestSchema.parse(input);
          writeJsonLine(await runSorbetImportSource(request));
          return;
        }
        if (action === 'connect-api-key') {
          const parsed = SorbetConnectApiKeyInputSchema.parse(input);
          writeJsonLine(await connectSorbetApiKey(parsed));
          return;
        }
        if (action === 'connect-custom-provider') {
          const parsed = SorbetConnectCustomProviderInputSchema.parse(input);
          writeJsonLine(await connectSorbetCustomProvider(parsed));
          return;
        }
        if (action === 'disconnect') {
          const providerId = typeof input.providerId === 'string' ? input.providerId.trim() : '';
          if (!providerId) throw new Error('providerId is required');
          await disconnectSorbetProvider(providerId);
          writeJsonLine({ ok: true });
          return;
        }

        throw new Error(`Unknown sorbet-onboarding action: ${action}`);
      })
  );
