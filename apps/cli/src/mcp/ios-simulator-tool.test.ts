import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { IosSimulatorCommand } from '@lody/shared';
import {
  registerIosSimulatorPreviewTool,
  IOS_SIMULATOR_PREVIEW_TOOL_NAME,
} from './ios-simulator-tool';

const udid = '5519CB11-71C9-46D9-AEFF-73C96F1104E0';
const base = { type: 'ios-simulator/control_response', sessionId: 's', success: true };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function fixture(request: (command: IosSimulatorCommand) => Promise<unknown>) {
  const server = new McpServer({ name: 'simulator-test', version: '1' });
  registerIosSimulatorPreviewTool(server, request);
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanup.push(async () => {
    await Promise.all([client.close(), server.close()]);
  });
  return {
    client,
    call: (args: Record<string, unknown>) =>
      client.callTool({ name: IOS_SIMULATOR_PREVIEW_TOOL_NAME, arguments: args }),
  };
}

describe('iOS Simulator MCP tool', () => {
  it('advertises a native preview tool and forwards the validated lifecycle commands', async () => {
    const commands: IosSimulatorCommand[] = [];
    const { client, call } = await fixture(async (command) => {
      commands.push(command);
      return base;
    });
    const tool = (await client.listTools()).tools[0];
    expect(tool).toMatchObject({
      name: IOS_SIMULATOR_PREVIEW_TOOL_NAME,
      title: 'iOS Simulator Preview',
    });
    expect(tool?.description).toContain('lody_report_preview_candidate');
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
      'action',
      'operationId',
      'udid',
    ]);
    const input = [
      { action: 'list' },
      { action: 'start', udid },
      { action: 'status' },
      { action: 'status', operationId: 'op' },
      { action: 'stop', operationId: 'op' },
    ];
    for (const command of input) expect((await call(command)).isError).not.toBe(true);
    expect(commands).toEqual(input);
  });

  it('rejects incomplete commands, extra action fields, and caller-selected identity before execution', async () => {
    const commands: IosSimulatorCommand[] = [];
    const { call } = await fixture(async (command) => {
      commands.push(command);
      return base;
    });
    for (const args of [
      { action: 'start' },
      { action: 'stop' },
      { action: 'list', udid },
      { action: 'start', udid: '../../bad' },
      { action: 'list', requestedByUserId: 'owner' },
      { action: 'list', sessionId: 'other' },
      { action: 'list', machineId: 'other' },
    ])
      expect((await call(args)).isError).toBe(true);
    expect(commands).toEqual([]);
  });

  it('returns inventory and operation handles without viewer capabilities or diagnostics', async () => {
    const devices = [
      {
        udid,
        name: 'Phone',
        runtime: 'iOS 26',
        deviceType: 'iPhone',
        state: 'Booted',
        available: true,
        occupancy: 'this-session',
      },
    ];
    const { call } = await fixture(async () => ({
      ...base,
      devices,
      message: 'secret top-level diagnostic',
      preview: {
        operationId: 'op',
        udid,
        phase: 'ready',
        transport: 'remote',
        viewerUrl: 'https://viewer.test/?token=secret',
        message: 'secret preview diagnostic',
      },
    }));
    const result = await call({ action: 'status' });
    expect(JSON.stringify(result)).not.toContain('secret');
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text)).toMatchObject({
      devices,
      preview: { operationId: 'op', udid, phase: 'ready' },
    });
    expect(JSON.stringify(result)).not.toContain('viewerUrl');
  });

  it('preserves domain error codes but hides transport exception details', async () => {
    const denied = await fixture(async () => ({
      ...base,
      success: false,
      error: 'denied',
      message: 'secret',
    }));
    const result = await denied.call({ action: 'list' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('denied');
    expect(JSON.stringify(result)).not.toContain('secret');
    const broken = await fixture(async () => {
      throw new Error('https://viewer.test/?token=secret');
    });
    const failed = await broken.call({ action: 'status' });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain('secret');
  });
});
