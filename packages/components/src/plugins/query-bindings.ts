import type { ScopeTarget } from '@lody/plugin-sdk';
import { useSyncExternalStore, useState } from 'react';
import type {
  ClientHostBindings,
  MachinePluginScope,
  ReadonlyJsonValue,
} from '@lody/plugin-sdk/client';
import type { PluginQueryRegistry } from './query-registry';

type Target = ScopeTarget<MachinePluginScope>;
export interface PluginCallPort {
  call(
    method:
      | 'plugin/query'
      | 'plugin/mutate'
      | 'plugin/attachment-search'
      | 'plugin/attachment-resolve',
    descriptorId: string,
    target: Target,
    input: unknown,
    signal: AbortSignal
  ): Promise<unknown>;
}
function targetKey(target: Target) {
  return JSON.stringify([
    target.workspaceId,
    target.machineId,
    'sessionId' in target ? target.sessionId : 'projectId' in target ? target.projectId : null,
  ]);
}
export function createPluginQueryBindings(
  registry: PluginQueryRegistry,
  port: PluginCallPort,
  owner: { workspaceId: string; machineId: string; signal: AbortSignal }
): Pick<ClientHostBindings, 'useQuery' | 'useMutation'> {
  function check(target: Target) {
    owner.signal.throwIfAborted();
    if (target.workspaceId !== owner.workspaceId || target.machineId !== owner.machineId)
      throw Object.assign(Error('Target outside plugin installation'), { code: 'forbidden' });
  }
  return {
    useQuery(target, descriptor, input) {
      const entry = registry.query(
        descriptor.id,
        descriptor.scope,
        targetKey(target),
        input as ReadonlyJsonValue,
        async (signal) => {
          check(target);
          const output = await port.call(
            'plugin/query',
            descriptor.id,
            target,
            descriptor.input.parse(input),
            signal
          );
          signal.throwIfAborted();
          return descriptor.output.parse(output);
        }
      );
      return useSyncExternalStore(entry.subscribe, entry.getSnapshot, entry.getSnapshot);
    },
    useMutation(target, descriptor) {
      const [count, setCount] = useState(0);
      return {
        pending: count > 0,
        mutate: async (input) => {
          check(target);
          const data = descriptor.input.parse(input);
          setCount((n) => n + 1);
          try {
            const output = await port.call(
              'plugin/mutate',
              descriptor.id,
              target,
              data,
              owner.signal
            );
            owner.signal.throwIfAborted();
            return descriptor.output.parse(output);
          } finally {
            setCount((n) => n - 1);
          }
        },
      };
    },
  };
}
