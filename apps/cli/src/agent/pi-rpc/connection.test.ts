import { describe, expect, it } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';
import { PiRpcConnection } from './connection';
import { createAgentStream, type PiStream } from '../agent-connection';
import { AgentClient } from '../agent-client';
import type { Logger } from '@/utils/logger';
import type { SessionId } from '@lody/shared';
import { parseSessionNotification } from '@lody/shared';
import type { SessionUsageUpdate } from 'acp-extension-core';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
const model = { provider: 'fixture', id: 'one', name: 'Fixture', contextWindow: 4096 };
const usage = {
  input: 10,
  output: 5,
  cacheRead: 2,
  cacheWrite: 1,
  totalTokens: 18,
  cost: { total: 0.01 },
};

/** Synthetic wire peer. Writes never await a running prompt or a question. */
function peer() {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start: (controller) => {
      output = controller;
    },
  });
  const commands: Record<string, unknown>[] = [];
  const replies: Record<string, unknown>[] = [];
  const promptReceived = deferred();
  const questionAnswered = deferred<Record<string, unknown>>();
  const state = {
    sessionId: 'native-id',
    sessionFile: '/work/pi-session.jsonl',
    model,
    thinkingLevel: 'off',
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0,
  };
  const emit = (value: unknown) =>
    output.enqueue(new TextEncoder().encode(JSON.stringify(value) + '\n'));
  let onPrompt = (request: Record<string, unknown>) => {
    emit({ type: 'agent_start' });
    reply(request);
  };
  let onAbort = (request: Record<string, unknown>) => {
    emit({ type: 'agent_settled' });
    reply(request);
  };
  function reply(request: Record<string, unknown>, data?: unknown, error?: string) {
    emit({ type: 'response', id: request.id, command: request.type, success: !error, data, error });
  }
  const writable = new WritableStream<Uint8Array>({
    write(bytes) {
      const request: Record<string, unknown> = JSON.parse(new TextDecoder().decode(bytes));
      commands.push(request);
      switch (request.type) {
        case 'new_session':
        case 'switch_session':
          reply(request, { cancelled: false });
          break;
        case 'get_state':
          reply(request, state);
          break;
        case 'get_session_stats':
          reply(request, {
            tokens: { input: 20, output: 10, cacheRead: 4, cacheWrite: 2 },
            cost: 0.02,
          });
          break;
        case 'get_available_models':
          reply(request, { models: [model, { ...model, id: 'two' }] });
          break;
        case 'get_available_thinking_levels':
          reply(request, { levels: state.model.id === 'one' ? ['off', 'high'] : ['off'] });
          break;
        case 'set_model':
          state.model = { ...model, id: String(request.modelId) };
          state.thinkingLevel = 'off';
          reply(request, state.model);
          break;
        case 'set_thinking_level':
          state.thinkingLevel = String(request.level);
          reply(request);
          break;
        case 'prompt':
          onPrompt(request);
          promptReceived.resolve();
          break;
        case 'abort':
          onAbort(request);
          break;
        case 'clear_queue':
        case 'compact':
          reply(request, {});
          break;
        case 'extension_ui_response':
          replies.push(request);
          questionAnswered.resolve(request);
          break;
        default:
          throw new Error(`Unexpected Pi wire method: ${String(request.type)}`);
      }
    },
  });
  const stream: PiStream = { protocol: 'pi', readable, writable };
  const updates: acp.SessionNotification[] = [];
  const usages: SessionUsageUpdate[] = [];
  let client: PiRpcConnection | undefined;
  const host = {
    update: async (notification: acp.SessionNotification) => {
      updates.push(notification);
    },
    usage: (value: SessionUsageUpdate) => usages.push(value),
    question: async (): Promise<acp.CreateElicitationResponse> => ({
      action: 'accept',
      content: { answer: 'chosen' },
    }),
  };
  return {
    get client() {
      return (client ??= new PiRpcConnection(stream, host));
    },
    stream,
    readable,
    writable,
    updates,
    usages,
    emit,
    commands,
    state,
    replies,
    questionAnswered,
    reply,
    promptReceived,
    setAbort: (handler: typeof onAbort) => {
      onAbort = handler;
    },
    setPrompt: (handler: typeof onPrompt) => {
      onPrompt = handler;
    },
    close: () => output.close(),
  };
}
async function start(p: ReturnType<typeof peer>) {
  await p.client.initialize({ protocolVersion: 1 });
  return p.client.newSession({ cwd: '/work', mcpServers: [] });
}
const prompt = {
  sessionId: '/work/pi-session.jsonl',
  prompt: [{ type: 'text' as const, text: 'hello' }],
};
const text = (value: string) => ({
  type: 'message_update',
  assistantMessageEvent: { type: 'text_delta', delta: value },
});

describe('native Pi connection', () => {
  it('keeps tool generation distinct from execution, reads cumulative session usage, and waits through retry to settled', async () => {
    const p = peer();
    await start(p);
    const done = p.client.prompt(prompt);
    await p.promptReceived.promise;
    p.emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end' } });
    p.emit({
      type: 'tool_execution_start',
      toolCallId: 'edit-1',
      toolName: 'edit',
      args: { path: 'a.ts', oldText: 'old', newText: 'new' },
    });
    p.emit({
      type: 'tool_execution_end',
      toolCallId: 'edit-1',
      toolName: 'edit',
      isError: false,
      result: { content: [{ type: 'text', text: 'edited' }] },
    });
    p.emit({ ...text('first'), usage });
    p.emit({ ...text(' attempt'), usage });
    p.emit({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: 'retryable', usage },
    });
    p.emit({ type: 'agent_end', willRetry: true });
    p.emit({ type: 'message_start', message: { role: 'assistant' } });
    p.emit(text('recovered'));
    p.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage } });
    p.emit({ type: 'agent_settled' });
    await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
    const history = p.updates
      .filter((n) => n.update.sessionUpdate !== 'usage_update')
      .map(parseSessionNotification);
    expect(history.map((n) => n.update.sessionUpdate)).toEqual([
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
      'agent_message_chunk',
      'agent_message_chunk',
    ]);
    expect(history[0]?.update).toMatchObject({
      kind: 'edit',
      rawInput: { file_path: '/work/a.ts', old_string: 'old', new_string: 'new' },
      locations: [{ path: '/work/a.ts' }],
    });
    expect(history[1]?.update).toMatchObject({
      status: 'completed',
      rawOutput: { content: [{ type: 'text', text: 'edited' }] },
    });
    expect(p.usages.map((value) => value.usage)).toEqual([
      {
        inputTokens: 20,
        outputTokens: 10,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 2,
        costUSD: 0.02,
      },
    ]);
    p.close();
  });

  it('handles accepted input without an agent run, and rejects prompt preflight errors', async () => {
    const p = peer();
    await start(p);
    p.setPrompt((request) => p.reply(request));
    await expect(p.client.prompt(prompt)).resolves.toEqual({ stopReason: 'end_turn' });
    p.setPrompt((request) => p.reply(request, undefined, 'No API key found'));
    await expect(p.client.prompt(prompt)).rejects.toThrow('No API key found');
    p.close();
  });

  it('fails a settled model error even after partial text, but allows a later prompt', async () => {
    const p = peer();
    await start(p);
    p.setPrompt((request) => {
      p.emit({ type: 'agent_start' });
      p.reply(request);
      p.emit(text('partial'));
      p.emit({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'error', errorMessage: 'Model unavailable' },
      });
      p.emit({ type: 'agent_settled' });
    });
    await expect(p.client.prompt(prompt)).rejects.toThrow('Model unavailable');
    p.setPrompt((request) => p.reply(request));
    await expect(p.client.prompt(prompt)).resolves.toEqual({ stopReason: 'end_turn' });
    p.close();
  });

  it('clears queues before abort and rejects concurrent prompts', async () => {
    const p = peer();
    await start(p);
    const done = p.client.prompt(prompt);
    await p.promptReceived.promise;
    await expect(p.client.prompt(prompt)).rejects.toThrow('active prompt');
    await p.client.cancel({ sessionId: prompt.sessionId });
    await expect(done).resolves.toEqual({ stopReason: 'cancelled' });
    expect(
      p.commands.filter((c) => c.type === 'clear_queue' || c.type === 'abort').map((c) => c.type)
    ).toEqual(['clear_queue', 'abort']);
    p.close();
  });

  it('cancels a run that starts only after the initial abort acknowledged idle preflight', async () => {
    const p = peer();
    await start(p);
    const accepted = deferred<Record<string, unknown>>();
    p.setPrompt((request) => accepted.resolve(request));
    p.setAbort((request) => p.reply(request));
    const done = p.client.prompt(prompt);
    const request = await accepted.promise;
    await p.client.cancel({ sessionId: prompt.sessionId });
    p.setAbort((abort) => {
      p.emit({ type: 'agent_settled' });
      p.reply(abort);
    });
    p.emit({ type: 'agent_start' });
    p.reply(request);
    await expect(done).resolves.toEqual({ stopReason: 'cancelled' });
    p.close();
  });

  it('rejects an in-flight run on EOF rather than treating the acknowledgement as completion', async () => {
    const p = peer();
    await start(p);
    const done = p.client.prompt(prompt);
    await p.promptReceived.promise;
    p.close();
    await expect(done).rejects.toThrow('closed');
  });

  it('resumes exactly the native file and refreshes the thinking ladder after switching models', async () => {
    const p = peer();
    await start(p);
    await p.client.resumeSession({ sessionId: prompt.sessionId, cwd: '/work', mcpServers: [] });
    expect(p.commands.find((c) => c.type === 'switch_session')).toMatchObject({
      sessionPath: prompt.sessionId,
    });
    const response = await p.client.setSessionConfigOption({
      sessionId: prompt.sessionId,
      configId: 'model',
      value: 'fixture/two',
    });
    expect(response.configOptions.find((option) => option.id === 'thinking')).toMatchObject({
      currentValue: 'off',
      options: [{ name: 'off', value: 'off' }],
    });
    await expect(
      p.client.setSessionConfigOption({
        sessionId: prompt.sessionId,
        configId: 'thinking',
        value: 'high',
      })
    ).rejects.toThrow('unavailable');
    await expect(
      p.client.resumeSession({ sessionId: 'legacy-pi-acp', cwd: '/work', mcpServers: [] })
    ).rejects.toThrow('native session file');
    p.close();
  });

  it('answers extension dialogs without blocking the wire, and rejects startup questions', async () => {
    const p = peer();
    await start(p);
    p.emit({
      type: 'extension_ui_request',
      id: 'startup',
      method: 'input',
      title: 'Before prompt',
    });
    await expect(p.questionAnswered.promise).resolves.toMatchObject({
      id: 'startup',
      cancelled: true,
    });
    p.close();
    const active = peer();
    await start(active);
    const done = active.client.prompt(prompt);
    await active.promptReceived.promise;
    active.emit({
      type: 'extension_ui_request',
      id: 'in-turn',
      method: 'select',
      title: 'Choose',
      options: ['chosen', 'other'],
    });
    await expect(active.questionAnswered.promise).resolves.toMatchObject({
      id: 'in-turn',
      value: 'chosen',
    });
    active.emit(text('working'));
    active.emit({ type: 'agent_settled' });
    await done;
    expect(active.updates.some((n) => n.update.sessionUpdate === 'agent_message_chunk')).toBe(true);
    active.close();
  });
});

describe('AgentClient direct Pi seam', () => {
  it('uses native JSONL for startup, model config, history, and a complete turn', async () => {
    // This peer is wired to AgentClient, not its helper PiRpcConnection.
    const p = peer();
    const log = () => undefined;
    const logger: Logger = {
      debug: log,
      info: log,
      warn: log,
      error: log,
      success: log,
      setLevel: log,
      setDebug: log,
      child: () => logger,
      close: async () => undefined,
    };
    const history: string[] = [];
    const client = new AgentClient({
      logger,
      sessionId: 'lody-fixture' as SessionId,
      terminalManager: {} as never,
      agentConfig: { cliType: 'builtin', agentType: 'pi' },
      configOptionValues: { model: 'fixture/two', thinking: 'off' },
      onUpdateMessage: (n) => history.push(n.update.sessionUpdate),
      onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    });
    p.setPrompt((request) => {
      p.emit({ type: 'agent_start' });
      p.reply(request);
      p.emit(text('native response'));
      p.emit({ type: 'agent_settled' });
    });
    const result = await client.startSession(
      createAgentStream(p.writable, p.readable, { cliType: 'builtin', agentType: 'pi' }),
      '/work'
    );
    expect(result.sessionId).toBe(prompt.sessionId);
    expect(client.currentModel?.modelId).toBe('fixture/two');
    await client.setSessionConfigOption(result.sessionId as never, 'model', 'fixture/one');
    expect(client.currentModel?.modelId).toBe('fixture/one');
    await expect(client.prompt(result.sessionId as never, prompt.prompt)).resolves.toEqual({
      stopReason: 'end_turn',
    });
    expect(history).toEqual(['agent_message_chunk']);
    expect(client.supportsAcknowledgedSteer()).toBe(false);
    p.close();
  });
});
