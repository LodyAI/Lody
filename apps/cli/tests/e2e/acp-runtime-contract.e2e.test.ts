/** Opt-in, authenticated live contract probe. No recorded user transcripts or model-name fixtures. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { SessionConfigOption, SetSessionConfigOptionRequest } from '@agentclientprotocol/sdk';
// The SDK does not export its validators through the package export map.
import * as schemas from '../../node_modules/@agentclientprotocol/sdk/dist/schema/zod.gen.js';
import {
  normalizeAcpSessionCapabilities,
  normalizeConfigOptions,
} from '../../src/agent/acp-capability-normalization';
import { parseLodyExtensionMessage } from '../../src/agent/lody-acp-extension';
import { resolveAcpModelControls } from '@lody/shared';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const envelopeSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
const enabled = process.env.LODY_LIVE_ACP === '1';
const values = (option: SessionConfigOption) =>
  option.type === 'select'
    ? option.options
        .flatMap((entry) => ('group' in entry ? entry.options : [entry]))
        .map((entry) => entry.value)
    : [];

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
  }
}

async function connect(agent: 'codex' | 'claude') {
  const executable =
    agent === 'codex' ? process.env.CODEX_PATH : process.env.CLAUDE_CODE_EXECUTABLE;
  if (!executable || !path.isAbsolute(executable))
    throw new Error(
      `Set an absolute ${agent === 'codex' ? 'CODEX_PATH' : 'CLAUDE_CODE_EXECUTABLE'} to pin the native runtime`
    );
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'lody-acp-contract-'));
  const child = spawn(
    process.execPath,
    [path.join(root, `packages/acp-extension-${agent}/dist/index.js`)],
    {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  // Do not print inherited configuration or authentication diagnostics.
  child.stderr.resume();
  const closed = once(child, 'close');
  let id = 0;
  let sessionId = '';
  let text = '';
  const errors: unknown[] = [];
  const updates: string[] = [];
  const extensions: string[] = [];
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >();
  const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      const message = envelopeSchema.parse(JSON.parse(line));
      if (message.method) {
        const params = message.params ?? {};
        if (message.method === 'session/update') {
          const parsed = schemas.zSessionNotification.parse(params);
          expect(parsed.sessionId).toBe(sessionId);
          const update = parsed.update;
          updates.push(update.sessionUpdate);
          if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text')
            text += update.content.text;
          if (update.sessionUpdate === 'config_option_update')
            expect(parsed.update).toEqual(params.update);
        } else if (message.method.startsWith('_lody/')) {
          const event = parseLodyExtensionMessage({
            method: message.method,
            params,
            sessionId,
            provider: agent,
          });
          expect(event, `Unmodeled extension ${message.method}`).not.toBeNull();
          extensions.push(event!.type);
        }
        if (message.id !== undefined) {
          errors.push(new Error(`Unexpected tool request: ${message.method}`));
          send({
            jsonrpc: '2.0',
            id: message.id,
            ...(message.method === 'session/request_permission'
              ? { result: { outcome: { outcome: 'cancelled' } } }
              : { error: { code: -32601, message: 'Tools disabled in contract probe' } }),
          });
        }
      } else if (typeof message.id === 'number') {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter?.reject(new RpcError(message.error.code, message.error.message));
        else waiter?.resolve(message.result);
      }
    } catch (error) {
      errors.push(error);
    }
  });
  child.on('error', (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  child.on('close', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('Adapter exited'));
    pending.clear();
  });
  async function request<T>(
    method: string,
    params: unknown,
    schema: { parse(value: unknown): T }
  ): Promise<T> {
    const result = await new Promise<unknown>((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Timeout: ${method}`));
      }, 120_000);
      pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      send({ jsonrpc: '2.0', id: requestId, method, params });
    });
    const parsed = schema.parse(result);
    // Catch SDK default-on-error coercion, especially lost options/boolean values.
    if (result && typeof result === 'object' && 'configOptions' in result) {
      expect((parsed as { configOptions?: unknown }).configOptions).toEqual(result.configOptions);
    }
    return parsed;
  }
  return {
    cwd,
    errors,
    updates,
    extensions,
    get text() {
      return text;
    },
    request,
    setSessionId(value: string) {
      sessionId = value;
    },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
        lines.close();
        await rm(cwd, { recursive: true, force: true });
      }
    },
  };
}

describe.skipIf(!enabled)('real native runtime → ACP → Lody contracts', () => {
  for (const agent of ['codex', 'claude'] as const) {
    it(`${agent}: model catalog, effort/fast transitions, invalid input and real output`, async () => {
      const rpc = await connect(agent);
      try {
        await rpc.request(
          'initialize',
          {
            protocolVersion: 1,
            clientCapabilities: {
              terminal: false,
              fs: { readTextFile: false, writeTextFile: false },
              session: { configOptions: { boolean: {} } },
            },
          },
          schemas.zInitializeResponse
        );
        const fresh = await rpc.request(
          'session/new',
          { cwd: rpc.cwd, mcpServers: [] },
          schemas.zNewSessionResponse
        );
        rpc.setSessionId(fresh.sessionId);
        const normalized = normalizeAcpSessionCapabilities(fresh);
        const declared = normalized.declaredModelCapabilities;
        expect(declared, 'Producer declaration must survive consumer parsing').toBeDefined();
        let options = fresh.configOptions ?? [];
        const set = async (configId: string, value: SetSessionConfigOptionRequest['value']) => {
          const params: SetSessionConfigOptionRequest =
            typeof value === 'boolean'
              ? { sessionId: fresh.sessionId, configId, type: 'boolean', value }
              : { sessionId: fresh.sessionId, configId, value };
          const response = await rpc
            .request('session/set_config_option', params, schemas.zSetSessionConfigOptionResponse)
            .catch((error) => {
              if (error instanceof Error) error.message += ` (${configId}=${String(value)})`;
              throw error;
            });
          options = response.configOptions;
          expect(options.find((option) => option.id === configId)?.currentValue).toBe(value);
        };
        const modelOption = options.find((option) => option.category === 'model');
        expect(modelOption).toBeDefined();
        const modelIds = values(modelOption!);
        expect(modelIds.length).toBeGreaterThan(1);
        // Test every advertised model without submitting a prompt on each one.
        for (const modelId of modelIds) {
          await set(modelOption!.id, modelId);
          const capability = {
            ...normalized,
            models: normalized.models.map((model) => ({
              ...model,
              name: model.name ?? model.modelId,
            })),
            agentType: agent,
            configOptions: normalizeConfigOptions(options),
            measuredForModelId: modelId,
          };
          const controls = resolveAcpModelControls(capability, modelId);
          const metadata = declared!.models[modelId];
          expect(metadata, `Missing declaration for ${modelId}`).toBeDefined();
          const effort = options.find((option) => option.category === 'thought_level');
          if (metadata?.effortValues !== undefined) {
            expect(effort ? values(effort).filter((value) => value !== 'default') : []).toEqual(
              metadata.effortValues
            );
            expect(controls.effort?.values).toEqual(metadata.effortValues);
          }
          if (effort) {
            const choices = values(effort);
            for (const value of choices) await set(effort.id, value);
            await set(effort.id, choices.includes('low') ? 'low' : choices[0]!);
            await expect(set(effort.id, '__invalid_effort__')).rejects.toBeInstanceOf(RpcError);
          }
          const fast = options.find(
            (option) => option.id === (agent === 'codex' ? 'fast-mode' : 'fast')
          );
          expect(Boolean(fast)).toBe(metadata?.fastMode);
          expect(controls.fast?.supported).toBe(metadata?.fastMode);
          if (fast) {
            expect(fast.type).toBe('boolean');
            await set(fast.id, true);
            await set(fast.id, false);
          }
        }
        // Use the initially selected model, with the least explicit effort, for one paid turn.
        await set(modelOption!.id, modelOption!.currentValue);
        const effort = options.find((option) => option.category === 'thought_level');
        if (effort)
          await set(effort.id, values(effort).includes('low') ? 'low' : values(effort)[0]!);
        const response = await rpc.request(
          'session/prompt',
          {
            sessionId: fresh.sessionId,
            prompt: [
              {
                type: 'text',
                text: 'Do not use tools, inspect files, or run commands. Reply with exactly ACP_PONG.',
              },
            ],
          },
          schemas.zPromptResponse
        );
        expect(response.stopReason).toBe('end_turn');
        expect(rpc.text.trim()).toBe('ACP_PONG');
        expect(rpc.updates).toContain('agent_message_chunk');
        expect(rpc.extensions).toContain('usage');
        expect(rpc.errors).toEqual([]);
      } finally {
        await rpc.close();
      }
    }, 300_000);
  }
});
