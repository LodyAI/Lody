import { CodeMode, Tool } from '@opencode/codemode';
import { parse } from 'acorn';
import { Effect, Schema, Semaphore } from 'effect';
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
  validateOnly = false
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
  const code = `const condition = (${source});
    const ctx = { ...${JSON.stringify(context)},
      read: (resource, parameters = {}) => tools.context.read({ resource, parameters }) };
    return await condition({ ctx });`;
  const runtime = CodeMode.make({
    tools: { context: { read: tool } },
    limits: { timeoutMs: 30_000, maxToolCalls: 32, maxOutputBytes: 128 * 1024 },
  });
  const result = yield* runtime.execute(code);
  if (!result.ok) return yield* Effect.fail(new Error(result.error.message));
  if (result.truncated) return yield* Effect.fail(new Error('AUTOMATION_RESULT_TOO_LARGE'));
  return yield* Effect.try(() => automationResultSchema.parse(result.value));
});
