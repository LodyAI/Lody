import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import type { SessionUsageUpdate } from 'acp-extension-core';
import type { AgentConnection, PiStream } from '../agent-connection';
import { PiTransport } from './transport';
import { PI_RPC_VERSION } from './version';

const modelSchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  contextWindow: z.number().nonnegative(),
});
const stateSchema = z.object({
  sessionId: z.string(),
  sessionFile: z.string().optional(),
  model: modelSchema.nullish(),
  thinkingLevel: z.string(),
  isStreaming: z.boolean(),
  isCompacting: z.boolean(),
  pendingMessageCount: z.number(),
});
const contentSchema = z.array(
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }),
  ])
);
const usageSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  cost: z.object({ total: z.number().nonnegative() }),
});
const statsSchema = z.object({
  tokens: z.object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
  }),
  cost: z.number().nonnegative(),
  contextUsage: z
    .object({
      tokens: z.number().nonnegative().nullable(),
      contextWindow: z.number().nonnegative(),
    })
    .optional(),
});
const startupConfigSchema = z.object({
  lody: z.object({
    sessionConfig: z.object({
      configOptionValues: z.record(z.string(), z.union([z.string(), z.boolean()])),
    }),
  }),
});
const questionSchema = z.object({
  id: z.string(),
  method: z.string(),
  title: z.string().optional(),
  message: z.string().optional(),
  prefill: z.string().optional(),
  options: z.array(z.string()).optional(),
  timeout: z.number().nonnegative().optional(),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A process may exit while the caller is still awaiting the command acknowledgement.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
type Run = ReturnType<typeof deferred<acp.PromptResponse>> & {
  started: boolean;
  settled: boolean;
  cancelled: boolean;
  error?: string;
};
type Host = {
  update: (notification: acp.SessionNotification) => Promise<void>;
  usage: (usage: SessionUsageUpdate) => void;
  question: (request: acp.CreateElicitationRequest) => Promise<acp.CreateElicitationResponse>;
};

/** Direct Pi RPC transport behind the host's existing connection contract. No ACP server/process. */
export class PiRpcConnection implements AgentConnection {
  private readonly rpc: PiTransport;
  private sessionId = '';
  private cwd = '';
  private model?: z.infer<typeof modelSchema>;
  private active?: Run;

  constructor(
    stream: PiStream,
    private readonly host: Host
  ) {
    this.rpc = new PiTransport(
      stream,
      (event) => this.event(event),
      (error) => this.active?.reject(error)
    );
  }

  initialize: AgentConnection['initialize'] = async () => {
    await this.rpc.request('get_state');
    return {
      protocolVersion: 1,
      agentInfo: { name: 'pi-rpc', version: PI_RPC_VERSION },
      agentCapabilities: {
        promptCapabilities: { image: true, embeddedContext: true },
        sessionCapabilities: { resume: {} },
      },
      authMethods: [],
    };
  };

  newSession: AgentConnection['newSession'] = async (request) => {
    this.assertIdle();
    this.cwd = request.cwd;
    const result = z
      .object({ cancelled: z.boolean() })
      .parse(await this.rpc.request('new_session'));
    if (result.cancelled) throw new Error('Pi extension cancelled session creation');
    return this.prepare(request._meta);
  };

  resumeSession: AgentConnection['resumeSession'] = async (request) => {
    this.assertIdle();
    this.cwd = request.cwd;
    if (!path.isAbsolute(request.sessionId) || !request.sessionId.endsWith('.jsonl')) {
      throw new Error(
        'Pi resume requires its native session file; pi-acp ids cannot be migrated automatically'
      );
    }
    const result = z
      .object({ cancelled: z.boolean() })
      .parse(await this.rpc.request('switch_session', { sessionPath: request.sessionId }));
    if (result.cancelled) throw new Error('Pi extension cancelled session resume');
    const response = await this.prepare(request._meta);
    if (response.sessionId !== request.sessionId)
      throw new Error('Pi resumed a different session file');
    return response;
  };

  private async prepare(meta: unknown): Promise<acp.NewSessionResponse> {
    const config = startupConfigSchema.safeParse(meta);
    if (config.success) {
      const values = config.data.lody.sessionConfig.configOptionValues;
      // Model first: the supported thinking ladder belongs to the selected model.
      for (const id of ['model', 'thinking']) {
        const value = values[id];
        if (typeof value === 'string') await this.setOption(id, value);
      }
    }
    const configOptions = await this.configOptions();
    return { sessionId: this.sessionId, configOptions };
  }

  private async configOptions(): Promise<acp.SessionConfigOption[]> {
    const [rawState, rawModels, rawLevels] = await Promise.all([
      this.rpc.request('get_state'),
      this.rpc.request('get_available_models'),
      this.rpc.request('get_available_thinking_levels'),
    ]);
    const state = stateSchema.parse(rawState);
    if (!state.sessionFile) throw new Error('Pi did not provide a persistent session file');
    this.sessionId = state.sessionFile;
    this.model = state.model ?? undefined;
    const models = z.object({ models: z.array(modelSchema) }).parse(rawModels).models;
    const levels = z.object({ levels: z.array(z.string()) }).parse(rawLevels).levels;
    if (!state.model || models.length === 0)
      throw new Error(
        'Pi has no configured model. Run pi /login on this machine or add provider API keys to the agent environment.'
      );
    return [
      ...(state.model
        ? [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select' as const,
              currentValue: `${state.model.provider}/${state.model.id}`,
              options: models.map((model) => ({
                value: `${model.provider}/${model.id}`,
                name: `${model.name} (${model.provider})`,
              })),
            },
          ]
        : []),
      {
        id: 'thinking',
        name: 'Thinking',
        category: 'thought_level',
        type: 'select',
        currentValue: state.thinkingLevel,
        options: levels.map((value) => ({ value, name: value })),
      },
    ];
  }

  private async setOption(id: string, value: string): Promise<void> {
    if (id === 'model') {
      const models = z
        .object({ models: z.array(modelSchema) })
        .parse(await this.rpc.request('get_available_models')).models;
      const model = models.find((candidate) => `${candidate.provider}/${candidate.id}` === value);
      if (!model) throw new Error(`Pi model is unavailable: ${value}`);
      await this.rpc.request('set_model', { provider: model.provider, modelId: model.id });
    } else if (id === 'thinking') {
      const { levels } = z
        .object({ levels: z.array(z.string()) })
        .parse(await this.rpc.request('get_available_thinking_levels'));
      if (!levels.includes(value))
        throw new Error(`Pi thinking level is unavailable for this model: ${value}`);
      await this.rpc.request('set_thinking_level', { level: value });
    } else throw new Error(`Unsupported Pi configuration option: ${id}`);
  }

  setSessionConfigOption: AgentConnection['setSessionConfigOption'] = async (request) => {
    this.assertSession(request.sessionId);
    this.assertIdle();
    if (typeof request.value !== 'string')
      throw new Error('Pi configuration requires a select value');
    await this.setOption(request.configId, request.value);
    return { configOptions: await this.configOptions() };
  };

  prompt: AgentConnection['prompt'] = async (request) => {
    this.assertSession(request.sessionId);
    this.assertIdle();
    const { message, images } = this.promptContent(request.prompt);
    const run: Run = {
      ...deferred<acp.PromptResponse>(),
      started: false,
      settled: false,
      cancelled: false,
    };
    this.active = run;
    try {
      if (message.trim() === '/stats' && images.length === 0) {
        const stats = statsSchema.parse(await this.rpc.request('get_session_stats'));
        await this.update({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Pi session usage: ${stats.tokens.input} input, ${stats.tokens.output} output, ${stats.tokens.cacheRead} cache read, ${stats.tokens.cacheWrite} cache write tokens; $${stats.cost.toFixed(6)}.`,
          },
        });
        run.resolve({ stopReason: 'end_turn' });
      } else if (message.trim() === '/compact' && images.length === 0) {
        await this.rpc.request('compact');
        await this.update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Context compacted.' },
        });
        run.resolve({ stopReason: 'end_turn' });
      } else {
        await this.rpc.request('prompt', { message, ...(images.length ? { images } : {}) });
        // Pi input hooks / extension commands can handle input without starting an agent run.
        // Query only after acceptance, then drain earlier events. Never use an idle snapshot to
        // finish a run that started: retry and compaction gaps also look idle.
        const state = stateSchema.parse(await this.rpc.request('get_state'));
        await this.rpc.drain();
        if (
          !run.started &&
          !state.isStreaming &&
          !state.isCompacting &&
          state.pendingMessageCount === 0
        ) {
          if (run.error && !run.cancelled) run.reject(new Error(run.error));
          else run.resolve({ stopReason: run.cancelled ? 'cancelled' : 'end_turn' });
        }
      }
      return await run.promise;
    } finally {
      if (this.active === run) this.active = undefined;
    }
  };

  cancel: AgentConnection['cancel'] = async (request) => {
    this.assertSession(request.sessionId);
    if (this.active) this.active.cancelled = true;
    // abort alone lets already queued messages continue in Pi.
    await this.rpc.request('clear_queue');
    await this.rpc.request('abort');
  };

  private promptContent(blocks: acp.ContentBlock[]) {
    const text: string[] = [];
    const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          text.push(block.text);
          break;
        case 'image':
          images.push({ type: 'image', data: block.data, mimeType: block.mimeType });
          break;
        case 'resource_link':
          text.push(`${block.name}: ${block.uri}`);
          break;
        case 'resource':
          if ('text' in block.resource) text.push(`${block.resource.uri}\n${block.resource.text}`);
          else
            throw new Error(
              'Pi does not support embedded binary resources; attach an image or a file link'
            );
          break;
        default:
          throw new Error(`Pi does not support prompt content: ${block.type}`);
      }
    }
    return { message: text.join('\n\n'), images };
  }

  private update(update: acp.SessionNotification['update']): Promise<void> {
    return this.host.update({ sessionId: this.sessionId, update });
  }

  private async event(event: Record<string, unknown>): Promise<void> {
    if (event.type === 'extension_ui_request') {
      const request = questionSchema.parse(event);
      // Do not block the wire/notification queue on a human response.
      void this.question(request)
        .catch(() =>
          this.rpc.send({ type: 'extension_ui_response', id: request.id, cancelled: true })
        )
        .catch(() => undefined);
      return;
    }
    const run = this.active;
    if (!run || run.settled) return;
    switch (event.type) {
      case 'agent_start':
        run.started = true;
        // Cancellation may have arrived while Pi was still in asynchronous prompt preflight.
        if (run.cancelled)
          void this.cancel({ sessionId: this.sessionId }).catch((error: unknown) =>
            run.reject(error instanceof Error ? error : new Error('Pi cancellation failed'))
          );
        break;
      case 'agent_settled':
        if (!run.started) break;
        run.settled = true;
        await this.reportUsage();
        if (run.error && !run.cancelled) run.reject(new Error(run.error));
        else run.resolve({ stopReason: run.cancelled ? 'cancelled' : 'end_turn' });
        break;
      case 'message_start': {
        const message = z.object({ role: z.string() }).parse(event.message);
        if (message.role === 'assistant') run.error = undefined;
        break;
      }
      case 'message_update': {
        const delta = z
          .object({ type: z.string(), delta: z.string().optional() })
          .parse(event.assistantMessageEvent);
        if ((delta.type === 'text_delta' || delta.type === 'thinking_delta') && delta.delta) {
          await this.update({
            sessionUpdate:
              delta.type === 'text_delta' ? 'agent_message_chunk' : 'agent_thought_chunk',
            content: { type: 'text', text: delta.delta },
          });
        }
        const usage = usageSchema.safeParse(event.usage);
        if (usage.success) await this.contextUsage(usage.data.totalTokens);
        break;
      }
      case 'message_end': {
        const message = z
          .object({
            role: z.string(),
            stopReason: z.string().optional(),
            errorMessage: z.string().optional(),
            usage: z.unknown().optional(),
          })
          .parse(event.message);
        if (message.role !== 'assistant') break;
        const usage = usageSchema.safeParse(message.usage);
        if (usage.success) {
          const value = usage.data;
          await this.contextUsage(value.totalTokens);
        }
        if (message.stopReason === 'error')
          run.error = message.errorMessage ?? 'Pi model request failed';
        if (message.stopReason === 'aborted') run.cancelled = true;
        break;
      }
      case 'tool_execution_start':
      case 'tool_execution_update':
      case 'tool_execution_end':
        await this.tool(event);
        break;
      case 'extension_error':
        run.error = z.object({ error: z.string() }).parse(event).error;
        break;
    }
  }

  private async reportUsage(): Promise<void> {
    // Pi owns the cumulative session total, including compaction and native resume.
    // Never feed per-message snapshots into the host's session-snapshot channel.
    const parsed = statsSchema.safeParse(
      await this.rpc.request('get_session_stats').catch(() => undefined)
    );
    if (!parsed.success) return;
    const { tokens, cost, contextUsage } = parsed.data;
    this.host.usage({
      sessionId: this.sessionId,
      usage: {
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        cacheReadInputTokens: tokens.cacheRead,
        cacheCreationInputTokens: tokens.cacheWrite,
        costUSD: cost,
      },
    });
    if (contextUsage?.tokens != null)
      await this.update({
        sessionUpdate: 'usage_update',
        size: contextUsage.contextWindow,
        used: contextUsage.tokens,
      });
  }

  private async contextUsage(used: number): Promise<void> {
    if (this.model)
      await this.update({ sessionUpdate: 'usage_update', size: this.model.contextWindow, used });
  }

  private async tool(event: Record<string, unknown>): Promise<void> {
    const tool = z
      .object({
        type: z.string(),
        toolCallId: z.string(),
        toolName: z.string(),
        args: z.record(z.string(), z.unknown()).optional(),
        result: z.object({ content: contentSchema, details: z.unknown().optional() }).optional(),
        partialResult: z.object({ content: contentSchema }).optional(),
        isError: z.boolean().optional(),
      })
      .parse(event);
    const start = tool.type === 'tool_execution_start';
    const end = tool.type === 'tool_execution_end';
    const args = tool.args ?? {};
    const file = typeof args.path === 'string' ? path.resolve(this.cwd, args.path) : undefined;
    const kind: acp.ToolKind =
      tool.toolName === 'bash'
        ? 'execute'
        : tool.toolName === 'read'
          ? 'read'
          : ['edit', 'write'].includes(tool.toolName)
            ? 'edit'
            : ['grep', 'find', 'ls'].includes(tool.toolName)
              ? 'search'
              : 'other';
    const content = tool.result?.content ?? tool.partialResult?.content;
    const notification: acp.ToolCall = {
      toolCallId: tool.toolCallId,
      title: tool.toolName,
      kind,
      status: end ? (tool.isError ? 'failed' : 'completed') : 'in_progress',
      ...(tool.args
        ? {
            rawInput: {
              ...args,
              ...(file ? { file_path: file } : {}),
              ...(typeof args.oldText === 'string' ? { old_string: args.oldText } : {}),
              ...(typeof args.newText === 'string' ? { new_string: args.newText } : {}),
            },
          }
        : {}),
      ...(file ? { locations: [{ path: file }] } : {}),
      ...(tool.result ? { rawOutput: tool.result } : {}),
      ...(content
        ? { content: content.map((block) => ({ type: 'content' as const, content: block })) }
        : {}),
    };
    await this.update(
      start
        ? { ...notification, sessionUpdate: 'tool_call' }
        : { ...notification, sessionUpdate: 'tool_call_update' }
    );
  }

  private async question(request: z.infer<typeof questionSchema>): Promise<void> {
    if (!['select', 'confirm', 'input', 'editor'].includes(request.method)) return;
    const run = this.active;
    const cancel = () =>
      this.rpc.send({ type: 'extension_ui_response', id: request.id, cancelled: true });
    if (!run || run.settled || run.cancelled) return cancel();
    const options = request.method === 'confirm' ? ['Yes', 'No'] : request.options;
    const response = await this.host.question({
      mode: 'form',
      sessionId: this.sessionId,
      message: [
        request.title,
        request.message,
        request.prefill ? `Current text:\n${request.prefill}` : undefined,
      ]
        .filter(Boolean)
        .join('\n'),
      requestedSchema: {
        type: 'object',
        properties: {
          answer: {
            type: 'string',
            title: request.title ?? 'Pi',
            ...(options ? { oneOf: options.map((value) => ({ const: value, title: value })) } : {}),
          },
        },
        required: ['answer'],
      },
      _meta: {
        lody: {
          elicitation: {
            version: 1,
            autoResolveAfterSeconds: request.timeout === undefined ? null : request.timeout / 1000,
          },
        },
      },
    });
    if (this.active !== run || run.cancelled || run.settled || response.action !== 'accept')
      return cancel();
    const value = z.object({ answer: z.string() }).safeParse(response.content);
    const answer = value.success ? value.data.answer : undefined;
    if (typeof answer !== 'string' || (options && !options.includes(answer))) return cancel();
    await this.rpc.send({
      type: 'extension_ui_response',
      id: request.id,
      ...(request.method === 'confirm' ? { confirmed: answer === 'Yes' } : { value: answer }),
    });
  }

  private assertIdle(): void {
    if (this.active) throw new Error('Pi already has an active prompt');
  }
  private assertSession(id: string): void {
    if (id !== this.sessionId) throw new Error('Pi session does not match the active session');
  }

  // Kept off the capability advertisement. Host calls fail explicitly rather than fall back.
  loadSession: AgentConnection['loadSession'] = async () => {
    throw new Error('Pi history replay is unsupported; use resume');
  };
  unstable_forkSession: AgentConnection['unstable_forkSession'] = async () => {
    throw new Error('Pi fork is unsupported');
  };
  closeSession: AgentConnection['closeSession'] = async () => {
    throw new Error('Pi session close is unsupported');
  };
  setSessionMode: AgentConnection['setSessionMode'] = async () => {
    throw new Error('Pi has no permission modes');
  };
  request: AgentConnection['request'] = async () => {
    throw new Error('Pi does not implement this ACP extension');
  };
}
