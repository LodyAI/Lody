import {
  MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES,
  defineMutation,
  defineQuery,
  hostQueries,
  type MachineRef,
  type PluginCallErrorCode,
  type ProjectRef,
  type SessionRef,
  type WorkspaceRef,
} from '@lody/plugin-sdk';
import { useHost, useMutation, useQuery, type ProjectPageProps } from '@lody/plugin-sdk/client';
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
    idempotencyKey: 'review/42/abc123',
  });
  if (byKeyRead.status === 'ready') {
    const key: string | undefined = byKeyRead.data.items[0]?.idempotencyKey;
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

  // @ts-expect-error Raw ID objects cannot forge a branded SessionRef capability.
  host.sessions.open({ workspaceId: 'lw_1', machineId: 'm_1', sessionId: 's_1' });

  // @ts-expect-error Route params are immutable; navigation goes through host.pages.openProject.
  pageProps.params.pr = '99';
}
