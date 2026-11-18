import {
  createAgentRoleSchemaEvidence,
  type AcpCapabilityCacheEntry,
  type AgentRole,
  type AgentRoleSchemaEvidence,
} from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';
import { executeCatalogCommand } from './workspace-catalog-write';
export { reconcileAgentRoleSchema } from '@lody/shared';

/** A finite maintenance command; the backend rechecks the current stored row. */
export async function persistReconciledAgentRole(
  runtime: WorkspaceRuntime,
  expected: AgentRole,
  capability: AcpCapabilityCacheEntry,
  userId: string,
  now: number,
  signal?: AbortSignal,
  target?: AgentRoleSchemaEvidence['target']
): Promise<void> {
  if (runtime.accountId !== userId) return;
  await executeCatalogCommand(
    runtime,
    {
      kind: 'reconcile-role-schema',
      expected,
      evidence: createAgentRoleSchemaEvidence(expected, capability, target),
      now,
    },
    { signal }
  );
}
