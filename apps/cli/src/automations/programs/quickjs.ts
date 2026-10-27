import { Effect } from 'effect';
import {
  getQuickJS,
  type QuickJSDeferredPromise,
  type QuickJSWASMModule,
} from 'quickjs-emscripten';
import {
  automationResultSchema,
  automationReadRequestSchema,
  automationReadResponseSchema,
  type AutomationReadRequest,
  type AutomationReadResponse,
  type AutomationProgramContext,
  type AutomationResult,
} from '@lody/shared/automations';

export const loadAutomationPrograms = Effect.tryPromise(() => getQuickJS());

/** Guest code evaluates a condition; only the Host can turn its result into a Session input. */
export async function evaluateAutomationProgram(
  module: QuickJSWASMModule,
  program: string,
  context: AutomationProgramContext,
  read: (input: AutomationReadRequest) => Promise<AutomationReadResponse>,
  validateOnly = false
): Promise<AutomationResult> {
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(256 * 1024);
  let fuel = 10_000;
  runtime.setInterruptHandler(() => --fuel <= 0);
  const vm = runtime.newContext();
  const deferred = new Set<QuickJSDeferredPromise>();
  const pending = new Set<Promise<void>>();
  let open = true;
  let calls = 0;
  try {
    const checked = vm.unwrapResult(
      vm.evalCode(`globalThis.__condition = ${program}
; typeof globalThis.__condition === 'function'`)
    );
    try {
      if (!vm.dump(checked)) throw new Error('AUTOMATION_PROGRAM_MUST_BE_FUNCTION');
    } finally {
      checked.dispose();
    }
    if (validateOnly) return false;
    const bridge = vm.newFunction('__read', (input) => {
      if (++calls > 32) throw new Error('AUTOMATION_TOOL_BUDGET_EXHAUSTED');
      const json = vm.getString(input);
      if (json.length > 128 * 1024) throw new Error('AUTOMATION_TOOL_INPUT_TOO_LARGE');
      const promise = vm.newPromise();
      deferred.add(promise);
      const task = Promise.resolve()
        .then(() => read(automationReadRequestSchema.parse(JSON.parse(json))))
        .then(
          (value) => {
            if (!open) return;
            const result = vm.newString(JSON.stringify(automationReadResponseSchema.parse(value)));
            try {
              promise.resolve(result);
            } finally {
              result.dispose();
            }
          },
          (cause) => {
            if (!open) return;
            const error = vm.newError(cause instanceof Error ? cause.message : 'Tool failed');
            try {
              promise.reject(error);
            } finally {
              error.dispose();
            }
          }
        );
      pending.add(task);
      void task.then(
        () => pending.delete(task),
        () => pending.delete(task)
      );
      return promise.handle;
    });
    vm.setProp(vm.global, '__read', bridge);
    bridge.dispose();
    const result = vm.unwrapResult(
      vm.evalCode(
        `
      "use strict";
      Promise.resolve(globalThis.__condition({
        ctx: Object.freeze({ ...${JSON.stringify(context)},
          read: async (resource, parameters = {}) => JSON.parse(await __read(JSON.stringify({resource, parameters})))
        })
      }))
    `,
        'automation-condition.js'
      )
    );
    try {
      while (true) {
        while (runtime.hasPendingJob()) {
          if (--fuel <= 0) throw new Error('AUTOMATION_PROGRAM_BUDGET_EXHAUSTED');
          const jobs = runtime.executePendingJobs(1);
          if (jobs.error) {
            jobs.error.dispose();
            throw new Error('AUTOMATION_PROGRAM_FAILED');
          }
        }
        const state = vm.getPromiseState(result);
        if (state.type === 'fulfilled') {
          try {
            if (pending.size) throw new Error('AUTOMATION_UNAWAITED_TOOL_CALL');
            return automationResultSchema.parse(vm.dump(state.value));
          } finally {
            state.value.dispose();
          }
        }
        if (state.type === 'rejected') {
          const error = vm.dump(state.error) as { message?: string } | undefined;
          state.error.dispose();
          throw new Error(error?.message ?? 'AUTOMATION_PROGRAM_FAILED');
        }
        if (!pending.size) throw new Error('AUTOMATION_PROGRAM_DID_NOT_COMPLETE');
        await Promise.race(pending);
      }
    } finally {
      result.dispose();
    }
  } finally {
    open = false;
    for (const promise of deferred) promise.dispose();
    vm.dispose();
    runtime.dispose();
  }
}
