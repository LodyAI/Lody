import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { quoteCommandArgument } from './command-line.js';

const SCRIPTED_ACP_ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'mcp-app-scripted-acp.mjs'
);

export const MCP_APP_PROMPT = '[LODY-MCPAPP-001] Open the synthetic release board.';

export type McpAppAcpEvent = {
  event: string;
  pid: number;
  sessionId?: string;
  toolCallId?: string;
  mode?: 'title' | 'mcp-app' | 'other';
  clientMcpApps?: unknown;
  uri?: string;
  name?: string;
  cards?: number;
};

export class McpAppFixture {
  readonly agentCommandLine: string;

  constructor(readonly eventLogPath: string) {
    writeFileSync(eventLogPath, '', 'utf8');
    this.agentCommandLine = [process.execPath, SCRIPTED_ACP_ENTRY, eventLogPath]
      .map(quoteCommandArgument)
      .join(' ');
  }

  readEvents(): McpAppAcpEvent[] {
    return readFileSync(this.eventLogPath, 'utf8')
      .split('\n')
      .filter((line) => line.endsWith('}'))
      .map((line) => JSON.parse(line) as McpAppAcpEvent);
  }

  async waitForEvent(predicate: (event: McpAppAcpEvent) => boolean): Promise<McpAppAcpEvent> {
    await expect.poll(() => this.readEvents().find(predicate), { timeout: 30_000 }).toBeDefined();
    return this.readEvents().find(predicate)!;
  }
}
