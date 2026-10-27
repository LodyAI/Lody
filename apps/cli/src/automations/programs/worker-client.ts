import { Cause, Effect, Queue, Semaphore } from 'effect';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  automationReadRequestSchema,
  automationResultSchema,
  type AutomationProgramContext,
  type AutomationReadRequest,
  type AutomationReadResponse,
  type AutomationResult,
} from '@lody/shared/automations';

const filename = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'automation-program-worker.js'
);
const messageSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('read'),
      id: z.number().int().positive(),
      input: automationReadRequestSchema,
    })
    .strict(),
  z.object({ kind: z.literal('result'), result: automationResultSchema }).strict(),
  z.object({ kind: z.literal('failure'), error: z.string() }).strict(),
]);
type Message = z.infer<typeof messageSchema> | { kind: 'exit'; code: number };

/** Own both the interpreter and its tool calls; cancellation joins their scopes before returning. */
export const runAutomationProgramWorker = Effect.fn('Automations.evaluate')(function* (
  program: string,
  context: AutomationProgramContext,
  read: (input: AutomationReadRequest) => Effect.Effect<AutomationReadResponse, unknown>,
  validateOnly = false
): Effect.fn.Return<AutomationResult, unknown> {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const messages = yield* Queue.unbounded<Message>();
      const worker = yield* Effect.acquireRelease(
        Effect.try(() => {
          const child = new Worker(filename, {
            workerData: { program, context, validateOnly },
            resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 },
          });
          child.on('message', (value: unknown) => {
            const parsed = messageSchema.safeParse(value);
            Queue.offerUnsafe(
              messages,
              parsed.success
                ? parsed.data
                : { kind: 'failure', error: 'AUTOMATION_WORKER_PROTOCOL_INVALID' }
            );
          });
          child.once('error', () =>
            Queue.offerUnsafe(messages, { kind: 'failure', error: 'AUTOMATION_WORKER_FAILED' })
          );
          child.once('exit', (code) => Queue.offerUnsafe(messages, { kind: 'exit', code }));
          return child;
        }),
        (child) => Effect.promise(() => child.terminate()).pipe(Effect.asVoid)
      );
      const toolSlots = Semaphore.makeUnsafe(4);
      let result: AutomationResult | undefined;
      let calls = 0;
      while (true) {
        const message = yield* Queue.take(messages);
        if (message.kind === 'failure') return yield* Effect.fail(new Error(message.error));
        if (message.kind === 'result') {
          result = message.result;
          continue;
        }
        if (message.kind === 'exit') {
          if (message.code !== 0 || result === undefined)
            return yield* Effect.fail(new Error('AUTOMATION_PROGRAM_DID_NOT_COMPLETE'));
          return result;
        }
        if (++calls > 32 || validateOnly)
          return yield* Effect.fail(new Error('AUTOMATION_TOOL_BUDGET_EXHAUSTED'));
        const request = message;
        yield* toolSlots.withPermit(read(request.input)).pipe(
          Effect.matchEffect({
            onSuccess: (output) => Effect.try(() => worker.postMessage({ id: request.id, output })),
            onFailure: (cause) =>
              Effect.try(() =>
                worker.postMessage({
                  id: request.id,
                  error: cause instanceof Error ? cause.message : 'Automation tool failed',
                })
              ),
          }),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Queue.offer(messages, {
                  kind: 'failure',
                  error: 'AUTOMATION_TOOL_RESPONSE_FAILED',
                }).pipe(Effect.asVoid)
          ),
          Effect.forkScoped
        );
      }
    }).pipe(Effect.timeout('30 seconds'))
  );
});
