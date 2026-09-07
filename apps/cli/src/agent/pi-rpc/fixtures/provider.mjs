import { Type } from '@sinclair/typebox';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
export default function (pi) {
  let release;
  pi.registerTool({
    name: 'fixture_gate',
    label: 'Fixture gate',
    description: 'Wait for an explicit smoke signal',
    parameters: Type.Object({}),
    async execute(_id, _args, signal) {
      await new Promise((resolve) => {
        release = resolve;
        if (signal?.aborted) resolve();
        else signal?.addEventListener('abort', resolve, { once: true });
      });
      return { content: [{ type: 'text', text: 'gate released' }] };
    },
  });
  pi.registerCommand('release-fixture', {
    description: 'Release smoke gate',
    handler: async () => {
      release?.();
    },
  });

  pi.registerProvider('lody-fixture', {
    api: 'lody-fixture-api',
    baseUrl: 'http://fixture.invalid',
    apiKey: 'fixture-only',
    models: [
      {
        id: 'fixture',
        name: 'Offline fixture',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 4096,
      },
    ],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const message = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        content: [],
        stopReason: 'stop',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: message });
        if (
          last?.role === 'user' &&
          (JSON.stringify(last.content).includes('write fixture') ||
            JSON.stringify(last.content).includes('gate fixture'))
        ) {
          const tool = {
            type: 'toolCall',
            id: 'write-fixture',
            name: JSON.stringify(last.content).includes('gate fixture') ? 'fixture_gate' : 'write',
            arguments: JSON.stringify(last.content).includes('gate fixture')
              ? {}
              : { path: 'fixture.txt', content: 'native pi wrote this\n' },
          };
          message.content = [tool];
          message.stopReason = 'toolUse';
          stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
          stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: tool, partial: message });
        } else {
          const text = JSON.stringify(context.messages).includes('steered fixture')
            ? 'Pi steer applied'
            : 'Pi native smoke passed';
          message.content = [{ type: 'text', text }];
          stream.push({ type: 'text_start', contentIndex: 0, partial: message });
          stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message });
          stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: message });
        }
        stream.push({ type: 'done', reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
  pi.on('input', (event) => (event.text === 'handled fixture' ? { action: 'handled' } : undefined));
  pi.registerCommand('ask-fixture', {
    description: 'Synthetic question',
    handler: async (_args, ctx) => {
      await ctx.ui.input('Fixture question');
    },
  });
}
