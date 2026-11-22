import {
  MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES,
  MAX_PACKED_CLIENT_BUNDLE_BYTES,
  MAX_PLUGIN_RPC_REQUEST_BYTES,
  defineMutation,
  defineQuery,
  hostQueries,
  type CreateSessionRequest,
  type MachineRef,
  type PluginCallErrorCode,
  type ProjectRef,
  type SessionRef,
  type WorkspaceRef,
} from '@lody/plugin-sdk';
import {
  useHost,
  useMutation,
  useQuery,
  type ProjectPageProps,
  type ToolRenderProps,
} from '@lody/plugin-sdk/client';
import type { PluginManifest } from '@lody/plugin-sdk/manifest';
import { z } from 'zod';

// @ts-expect-error Browser client bundles cannot import machine-only SDK modules.
import('@lody/plugin-sdk/machine');

// @ts-expect-error Browser client bundles cannot import Node built-in modules.
import('node:fs');

export const machineDigestQuery = defineQuery('machine', 'daemon.digest', {
  input: z.object({ limit: z.number().int().default(10) }),
  output: z.object({ count: z.number().int() }),
});

export const sessionMonitorQuery = defineQuery('session', 'monitor.state', {
  input: z.object({}),
  output: z.object({ activeStep: z.string().nullable() }),
});

export const projectPinMutation = defineMutation('project', 'item.pin', {
  input: z.object({ itemId: z.string() }),
  output: z.object({ pinned: z.boolean() }),
});

// @ts-expect-error Plugin-defined machine queries cannot use cross-machine 'workspace' scope.
defineQuery('workspace', 'invalid.workspaceQuery', {
  input: z.object({}),
  output: z.object({}),
});

export const inlineBudgetCheck: 16384 = MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES;
export const rpcRequestBudgetCheck: 262144 = MAX_PLUGIN_RPC_REQUEST_BYTES;
export const packedClientBundleBudgetCheck: 4194304 = MAX_PACKED_CLIENT_BUNDLE_BYTES;

export const validManifest: PluginManifest = {
  id: 'test-report',
  version: '0.1.0',
  sdk: '^1.0.0',
  title: 'Test Report',
  client: './dist/client.js',
  machine: './dist/machine.js',
  skills: ['test-triage'],
  env: {
    TRACKER_API_KEY: {
      description: 'API token for issue lookup on the daemon.',
      secret: true,
    },
  },
};

export const headlessOnlyManifest: PluginManifest = {
  id: 'ci-sentinel',
  version: '0.1.0',
  sdk: '^1.0.0',
  title: 'CI Sentinel',
  machine: './dist/machine.js',
  skills: ['ci-triage'],
};

export const clientOnlyManifest: PluginManifest = {
  id: 'focus-sidebar',
  version: '0.1.0',
  sdk: '^1.0.0',
  title: 'Focus Sidebar',
  client: './dist/client.js',
};

export const invalidSdkRangeManifest: PluginManifest = {
  id: 'bad-sdk',
  version: '0.1.0',
  // @ts-expect-error Manifest must target a supported SDK major range.
  sdk: '^2.0.0',
  title: 'Invalid SDK',
};

export const retriableOfflineCode: PluginCallErrorCode = 'machine_offline';
export const unknownOutcomeCode: PluginCallErrorCode = 'outcome_unknown';
export const quarantinedPluginCode: PluginCallErrorCode = 'plugin_faulted';

export function verifyToolRenderStateNarrowing(
  props: ToolRenderProps<{ readonly filter?: string }, { readonly passed: number }>
): number | null {
  const id: string = props.toolCallId;
  void id;
  if (props.status === 'running') {
    // @ts-expect-error Running tool cards have no final output until completion.
    void props.output.passed;
    return null;
  }
  return props.output.passed;
}

export async function verifyClientTypeSafety(
  workspace: WorkspaceRef,
  machine: MachineRef,
  project: ProjectRef,
  session: SessionRef,
  pageProps: ProjectPageProps
) {
  const host = useHost();

  // WorkspaceRef is purely logical and has no single machineId.
  // @ts-expect-error WorkspaceRef does not carry a single machineId.
  void workspace.machineId;

  const machinesRead = useQuery(workspace, hostQueries.machines, {});
  if (machinesRead.status === 'ready') {
    const firstMachine: MachineRef | undefined = machinesRead.data.items[0]?.machine;
    void firstMachine;
  }

  const okMachineRead = useQuery(machine, machineDigestQuery, {});
  if (okMachineRead.status === 'ready') {
    const count: number = okMachineRead.data.count;
    void count;
  }

  const okSessionRead = useQuery(session, sessionMonitorQuery, {});
  if (okSessionRead.status === 'ready') {
    const step: string | null = okSessionRead.data.activeStep;
    void step;
  }

  const detailRead = useQuery(session, hostQueries.sessionDetail, { recentTurnLimit: 5 });
  if (detailRead.status === 'ready') {
    const turnCount: number = detailRead.data.recentTurns.length;
    void turnCount;
  }

  const byKeyRead = useQuery(project, hostQueries.sessions, {
    createdByMe: true,
    createdByPlugin: true,
    businessKey: 'review/42/abc123',
  });
  if (byKeyRead.status === 'ready') {
    const key: string | undefined = byKeyRead.data.items[0]?.businessKey;
    void key;
  }

  // @ts-expect-error Project-scoped query cannot be called with a WorkspaceRef.
  useQuery(workspace, hostQueries.worktrees, {});

  // @ts-expect-error Machine-scoped plugin query cannot be called with a WorkspaceRef.
  useQuery(workspace, machineDigestQuery, {});

  // @ts-expect-error Workspace-scoped query cannot be called with a ProjectRef.
  useQuery(project, hostQueries.projects, {});

  const pin = useMutation(project, projectPinMutation);
  // @ts-expect-error Mutation input is validated against the Zod input schema.
  void pin.mutate({ itemId: 42 });

  const sendReceipt = await host.sessions.send(session, {
    idempotencyKey: 'followup-1',
    prompt: 'Summarize the latest test failures.',
    delivery: 'queue',
  });
  void sendReceipt.disposition;
  await host.sessions.requestStop(session);
  host.panels.openSession(session, 'issues', { identifier: 'LODY-101' });

  const createRequest: CreateSessionRequest = {
    requestId: 'create-review-attempt-1',
    businessKey: 'review/42/abc123',
    businessKeyScope: 'project',
    prompt: 'Review PR #42 at abc123.',
    waitCondition: {
      program: 'async ({ ctx }) => Boolean(ctx.params.prNumber)',
      params: { prNumber: 42 },
    },
  };
  await host.sessions.create(project, createRequest);
  // Unbound Sessions and drafts can target a MachineRef without a ProjectRef.
  await host.sessions.create(machine, {
    requestId: 'create-unbound-triage-1',
    prompt: 'Inspect recent daemon alerts.',
  });
  host.drafts.open(machine, { prompt: 'Quick machine-scoped investigation.' });

  // The same immutable request is used after an uncertain result, even if the
  // original Session has since been archived. A new generation gets a new ID.
  await host.sessions.create(project, createRequest);
  await host.sessions.create(project, { ...createRequest, requestId: 'create-review-attempt-2' });

  // @ts-expect-error A business key alone cannot identify a retryable creation request.
  const missingRequestId: CreateSessionRequest = { businessKey: 'review/42', prompt: 'Review.' };
  void missingRequestId;
  const legacyCreateRequest: CreateSessionRequest = {
    requestId: 'create-review-attempt-3',
    // @ts-expect-error Creation separates request identity from business-task identity.
    idempotencyKey: 'review/42',
    prompt: 'Review.',
  };
  void legacyCreateRequest;

  // @ts-expect-error Raw ID objects cannot forge a branded SessionRef capability.
  host.sessions.open({ workspaceId: 'lw_1', machineId: 'm_1', sessionId: 's_1' });

  // @ts-expect-error Route params are immutable; navigation goes through host.pages.openProject.
  pageProps.params.pr = '99';
}
