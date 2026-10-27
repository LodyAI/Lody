import { parentPort, workerData } from 'node:worker_threads';
import { getQuickJS } from 'quickjs-emscripten';
import { z } from 'zod';
import {
  automationProgramContextSchema,
  automationProgramSchema,
  type AutomationReadResponse,
} from '@lody/shared/automations';
import { evaluateAutomationProgram } from './quickjs';

const input = z
  .object({
    program: automationProgramSchema,
    context: automationProgramContextSchema,
    validateOnly: z.boolean().default(false),
  })
  .strict()
  .parse(workerData);
const port = parentPort;
if (!port) throw new Error('AUTOMATION_WORKER_PORT_REQUIRED');
const requests = new Map<
  number,
  { resolve(value: AutomationReadResponse): void; reject(cause: Error): void }
>();
let sequence = 0;
port.on('message', (message: { id: number; output?: AutomationReadResponse; error?: string }) => {
  const request = requests.get(message.id);
  if (!request) return;
  requests.delete(message.id);
  if (message.output) request.resolve(message.output);
  else request.reject(new Error(message.error ?? 'Automation tool failed'));
});
try {
  const result = await evaluateAutomationProgram(
    await getQuickJS(),
    input.program,
    input.context,
    (args) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        requests.set(id, { resolve, reject });
        port.postMessage({ kind: 'read', id, input: args });
      }),
    input.validateOnly
  );
  port.postMessage({ kind: 'result', result });
} catch (cause) {
  port.postMessage({
    kind: 'failure',
    error: cause instanceof Error ? cause.message : 'Automation program failed',
  });
} finally {
  port.close();
}
