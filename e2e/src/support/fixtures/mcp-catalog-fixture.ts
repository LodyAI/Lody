import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const SCRIPTED_ACP_ENTRY = resolve(fixtureDirectory, 'mcp-scripted-acp.mjs');
const SYNTHETIC_MCP_ENTRY = resolve(fixtureDirectory, 'synthetic-stdio-mcp.mjs');

export type AcpMcpServer = {
  type?: string;
  name?: string;
  command?: string;
  args?: string[];
  env?: Array<{ name?: string; value?: string }>;
  url?: string;
  headers?: Array<{ name?: string; value?: string }>;
};

export type McpCatalogAcpEvent = {
  at: string;
  pid: number;
  event: string;
  sessionId?: string;
  mode?: string;
  stopReason?: string;
  mcpServers?: AcpMcpServer[];
};

type McpProcessEvent = {
  at: string;
  pid: number;
  event: string;
};

function quoteCommandArgument(value: string): string {
  if (/^[A-Za-z0-9_./:\\-]+$/u.test(value)) return value;
  return `"${value.replace(/["\\$`]/gu, '\\$&')}"`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ESRCH'
    );
  }
}

export class McpCatalogFixture {
  readonly serverName = 'Synthetic workspace MCP';
  readonly serverDescription = 'Deterministic stdio MCP for the Lody desktop journey';
  readonly scriptedAgentCommandLine: string;
  readonly mcpCommand = process.execPath;
  readonly mcpArgs: string[];

  constructor(
    readonly acpEventLogPath: string,
    readonly mcpEventLogPath: string
  ) {
    this.scriptedAgentCommandLine = [process.execPath, SCRIPTED_ACP_ENTRY, acpEventLogPath]
      .map(quoteCommandArgument)
      .join(' ');
    this.mcpArgs = [SYNTHETIC_MCP_ENTRY, mcpEventLogPath];
  }

  readAcpEvents(): McpCatalogAcpEvent[] {
    try {
      return readFileSync(this.acpEventLogPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as McpCatalogAcpEvent];
          } catch {
            return [];
          }
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async waitForEvent(event: string, minimumCount = 1): Promise<McpCatalogAcpEvent[]> {
    await expect
      .poll(() => this.readAcpEvents().filter((entry) => entry.event === event).length, {
        timeout: 30_000,
        intervals: [50, 100, 250, 500],
      })
      .toBeGreaterThanOrEqual(minimumCount);
    return this.readAcpEvents().filter((entry) => entry.event === event);
  }

  readMcpEvents(): McpProcessEvent[] {
    try {
      return readFileSync(this.mcpEventLogPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as McpProcessEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async waitForMcpEvent(event: string): Promise<McpProcessEvent> {
    await expect
      .poll(() => this.readMcpEvents().find((entry) => entry.event === event), {
        timeout: 30_000,
        intervals: [50, 100, 250, 500],
      })
      .toBeDefined();
    return this.readMcpEvents().find((entry) => entry.event === event)!;
  }

  async expectAgentExited(pid: number): Promise<void> {
    await expect.poll(() => isProcessAlive(pid), { timeout: 30_000 }).toBe(false);
  }

  async expectMcpExited(pid: number): Promise<void> {
    await expect.poll(() => isProcessAlive(pid), { timeout: 30_000 }).toBe(false);
  }
}
