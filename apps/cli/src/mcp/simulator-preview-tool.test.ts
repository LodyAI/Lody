import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { AndroidEmulatorCommand, IosSimulatorCommand } from '@lody/shared';
import { createToolHelpServer } from './tool-help';
import {
  registerSimulatorPreviewTool,
  simulatorPreviewPlatforms,
  SIMULATOR_PREVIEW_TOOL_NAME,
  type SimulatorPreviewPlatform,
} from './simulator-preview-tool';

const udid = '5519CB11-71C9-46D9-AEFF-73C96F1104E0';
const base = { type: 'ios-simulator/control_response', sessionId: 's', success: true };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function fixture(
  ios: (command: IosSimulatorCommand) => Promise<unknown>,
  android: (command: AndroidEmulatorCommand) => Promise<unknown> = async () => {
    throw new Error('unexpected android call');
  },
  platforms: [SimulatorPreviewPlatform, ...SimulatorPreviewPlatform[]] = ['ios', 'android']
) {
  const server = new McpServer({ name: 'simulator-test', version: '1' });
  registerSimulatorPreviewTool(createToolHelpServer(server), { ios, android }, platforms);
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanup.push(async () => {
    await Promise.all([client.close(), server.close()]);
  });
  return {
    client,
    call: (args: Record<string, unknown>, platform: SimulatorPreviewPlatform = 'ios') =>
      client.callTool({
        name: SIMULATOR_PREVIEW_TOOL_NAME,
        arguments: { platform, ...args },
      }),
  };
}

describe('iOS Simulator MCP tool', () => {
  it('advertises a native preview tool and forwards the validated lifecycle commands', async () => {
    const commands: IosSimulatorCommand[] = [];
    const { client, call } = await fixture(async (command) => {
      commands.push(command);
      return base;
    });
    const tool = (await client.listTools()).tools.find(
      ({ name }) => name === SIMULATOR_PREVIEW_TOOL_NAME
    );
    expect(tool).toMatchObject({ title: 'Simulator Preview' });
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
      'action',
      'id',
      'operationId',
      'platform',
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
      // Each platform keeps its own device field.
      { action: 'start', id: 'Pixel_A' },
      { action: 'start', udid, id: 'Pixel_A' },
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

it('keeps Android AVD identity and strips viewer capabilities at the MCP boundary', async () => {
  const { call } = await fixture(
    async () => {
      throw new Error('unexpected ios call');
    },
    async (command) => ({
      type: 'android-emulator/control_response',
      sessionId: 's',
      success: true,
      preview: {
        operationId: 'op',
        id: command.action === 'start' ? command.id : 'Pixel_A',
        phase: 'ready',
        transport: 'local',
        viewerUrl: 'http://127.0.0.1:1234/?token=synthetic-secret',
      },
    })
  );
  const result = await call({ action: 'start', id: 'Pixel_A' }, 'android');
  expect(result.isError).not.toBe(true);
  const encoded = JSON.stringify(result);
  expect(encoded).toContain('Pixel_A');
  expect(encoded).toContain('Android Emulator panel');
  expect(encoded).not.toContain('synthetic-secret');
  expect(encoded).not.toContain('viewerUrl');
  expect((await call({ action: 'start', id: '../../escape' }, 'android')).isError).toBe(true);
  expect((await call({ action: 'start', udid }, 'android')).isError).toBe(true);
});

it('offers iOS Simulators only on a macOS host, fixed when the server is built', async () => {
  expect(simulatorPreviewPlatforms('darwin')).toEqual(['ios', 'android']);
  expect(simulatorPreviewPlatforms('linux')).toEqual(['android']);
  expect(simulatorPreviewPlatforms('win32')).toEqual(['android']);
  const iosCalls: IosSimulatorCommand[] = [];
  const { client, call } = await fixture(
    async (command) => {
      iosCalls.push(command);
      return base;
    },
    async () => ({ type: 'android-emulator/control_response', sessionId: 's', success: true }),
    ['android']
  );
  const tool = (await client.listTools()).tools.find(
    ({ name }) => name === SIMULATOR_PREVIEW_TOOL_NAME
  );
  expect(tool?.inputSchema.properties?.platform).toEqual({ type: 'string', enum: ['android'] });
  expect(tool?.description).toContain('Android Emulator');
  expect(tool?.description).not.toContain('iOS');
  expect((await call({ action: 'list' }, 'ios')).isError).toBe(true);
  expect(iosCalls).toEqual([]);
  expect((await call({ action: 'list' }, 'android')).isError).not.toBe(true);
});
