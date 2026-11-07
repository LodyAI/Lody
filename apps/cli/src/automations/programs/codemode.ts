import { CodeMode, Tool } from '@opencode/codemode';
import { parse } from 'acorn';
import { Effect, Schema, Semaphore } from 'effect';
import { fetchAutomationContext } from '../context/fetch';
import type { AutomationExecInput } from '../context/exec';
import { z } from 'zod';
import {
  automationReadRequestSchema,
  automationReadResponseSchema,
  automationResultSchema,
  type AutomationProgramContext,
  type AutomationReadRequest,
  type AutomationReadResponse,
  type AutomationResult,
} from '@lody/shared/automations';

/** Parse registration without executing user code or granting access to any reads. */
function conditionSource(program: string): string {
  const parsed = parse(program, { ecmaVersion: 'latest' });
  const expression = parsed.body[0];
  if (
    parsed.body.length !== 1 ||
    expression?.type !== 'ExpressionStatement' ||
    (expression.expression.type !== 'ArrowFunctionExpression' &&
      expression.expression.type !== 'FunctionExpression')
  )
    throw new Error('AUTOMATION_PROGRAM_MUST_BE_FUNCTION');
  return program.slice(expression.expression.start, expression.expression.end);
}

/** Run a condition using only the host-owned scoped read capability. */
export const evaluateAutomationProgram = Effect.fn('Automations.evaluate')(function* (
  program: string,
  context: AutomationProgramContext,
  read: (input: AutomationReadRequest) => Effect.Effect<AutomationReadResponse, unknown>,
  validateOnly = false,
  exec?: (input: AutomationExecInput) => Effect.Effect<unknown, unknown>
): Effect.fn.Return<AutomationResult, unknown> {
  const source = yield* Effect.try(() => conditionSource(program));
  if (validateOnly) return false;
  const slots = Semaphore.makeUnsafe(4);
  const tool = Tool.make({
    description: 'Read an observation in the current session',
    input: Schema.Unknown,
    output: Schema.Unknown,
    execute: (input) =>
      Effect.try(() => {
        if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 128 * 1024)
          throw new Error('AUTOMATION_TOOL_INPUT_TOO_LARGE');
        return automationReadRequestSchema.parse(input);
      }).pipe(
        Effect.flatMap((request) => slots.withPermit(read(request))),
        Effect.flatMap((output) => Effect.try(() => automationReadResponseSchema.parse(output)))
      ),
  });
  const fetchTool = Tool.make({
    description: 'Fetch an HTTP observation',
    input: Schema.Unknown,
    output: Schema.Unknown,
    execute: (input) =>
      slots.withPermit(
        Effect.tryPromise({
          try: (signal) => fetchAutomationContext(input, signal),
          catch: () => new Error('AUTOMATION_FETCH_FAILED'),
        })
      ),
  });
  const execTool = Tool.make({
    description: 'Run a command in the current session workspace',
    input: Schema.Unknown,
    output: Schema.Unknown,
    execute: (input) =>
      Effect.try(() =>
        z
          .object({
            command: z.string().min(1),
            args: z.array(z.string()).optional(),
            cwd: z.string().optional(),
          })
          .strict()
          .parse(input)
      ).pipe(
        Effect.flatMap((request) =>
          slots.withPermit(
            exec ? exec(request) : Effect.fail(new Error('AUTOMATION_EXEC_UNAVAILABLE'))
          )
        )
      ),
  });
  const code = `const condition = (${source});
    const ctx = { ...${JSON.stringify(context)},
      read: (resource, parameters = {}) => tools.context.read({ resource, parameters }),
      exec: (options) => tools.context.exec(options),
      fetch: async (url, options = {}) => {
        const result = await tools.context.fetch({ url, options });
        return { ok: result.ok, status: result.status, headers: result.headers, url: result.url,
          text: async () => result.body, json: async () => JSON.parse(result.body) };
      } };
    return await condition({ ctx });`;
  const runtime = CodeMode.make({
    tools: { context: { read: tool, fetch: fetchTool, exec: execTool } },
    limits: { timeoutMs: 30_000, maxToolCalls: 32, maxOutputBytes: 128 * 1024 },
  });
  const result = yield* runtime.execute(code);
  if (!result.ok) return yield* Effect.fail(new Error(result.error.message));
  if (result.truncated) return yield* Effect.fail(new Error('AUTOMATION_RESULT_TOO_LARGE'));
  return yield* Effect.try(() => automationResultSchema.parse(result.value));
});
