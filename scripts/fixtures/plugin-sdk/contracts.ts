import {
  MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES,
  MAX_PACKED_CLIENT_BUNDLE_BYTES,
  MAX_PLUGIN_RPC_REQUEST_BYTES,
  defineMutation,
  defineQuery,
  lodyQueries,
  type CreateSessionRequest,
  type MachineRef,
  type PluginCallErrorCode,
  type ProjectRef,
  type SessionRef,
  type WorkspaceRef,
} from "@lody/plugin-sdk";
import {
  defineClientPlugin,
  useLody,
  useLodyQuery,
  useMutation,
  useQuery,
  type ProjectPageProps,
  type ToolRenderProps,
} from "@lody/plugin-sdk/client";
import type { PluginManifest } from "@lody/plugin-sdk/manifest";
import { z } from "zod";

// @ts-expect-error Browser client bundles cannot import machine-only SDK modules.
import("@lody/plugin-sdk/machine");

// @ts-expect-error Browser client bundles cannot import Node built-in modules.
import("node:fs");

export const machineDigestQuery = defineQuery("machine", "daemon.digest", {
  input: z.object({ limit: z.number().int().default(10) }),
  output: z.object({ count: z.number().int() }),
});

export const sessionMonitorQuery = defineQuery("session", "monitor.state", {
  input: z.object({}),
  output: z.object({ activeStep: z.string().nullable() }),
});

export const projectPinMutation = defineMutation("project", "item.pin", {
  input: z.object({ itemId: z.string() }),
  output: z.object({ pinned: z.boolean() }),
});

// @ts-expect-error Plugin-defined machine queries cannot use cross-machine 'workspace' scope.
defineQuery("workspace", "invalid.workspaceQuery", {
  input: z.object({}),
  output: z.object({}),
});

export const inlineBudgetCheck: 16384 = MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES;
export const rpcRequestBudgetCheck: 262144 = MAX_PLUGIN_RPC_REQUEST_BYTES;
export const packedClientBundleBudgetCheck: 4194304 =
  MAX_PACKED_CLIENT_BUNDLE_BYTES;

export const validManifest: PluginManifest = {
  id: "test-report",
  version: "0.1.0",
  sdk: "^1.0.0",
  title: "Test Report",
  client: "./dist/client.js",
  machine: "./dist/machine.js",
  skills: ["test-triage"],
  themes: [
    {
      id: "cyber-war-room",
      label: "Cyber War Room",
      appearance: "dark",
      path: "./assets/cyber-war-room.json",
      tokens: { density: "compact", radius: "4px" },
    },
    {
      id: "amber-ember",
      label: "Amber Ember",
      appearance: "dark",
      seed: {
        bg: "#11100e",
        fg: "#f5efe6",
        accent: "#f59e0b",
        surface: "#1b1916",
      },
      tokens: { fontMono: "JetBrains Mono", density: "comfortable" },
    },
  ],
  styles: ["./assets/war-room-snippet.css"],
  env: {
    TRACKER_API_KEY: {
      description: "API token for issue lookup on the daemon.",
      secret: true,
    },
  },
};

export const headlessOnlyManifest: PluginManifest = {
  id: "ci-sentinel",
  version: "0.1.0",
  sdk: "^1.0.0",
  title: "CI Sentinel",
  machine: "./dist/machine.js",
  skills: ["ci-triage"],
};

export const clientOnlyManifest: PluginManifest = {
  id: "focus-sidebar",
  version: "0.1.0",
  sdk: "^1.0.0",
  title: "Focus Sidebar",
  client: "./dist/client.js",
};

export const invalidSdkRangeManifest: PluginManifest = {
  id: "bad-sdk",
  version: "0.1.0",
  // @ts-expect-error Manifest must target a supported SDK major range.
  sdk: "^2.0.0",
  title: "Invalid SDK",
};

export const retriableOfflineCode: PluginCallErrorCode = "machine_offline";
export const unknownOutcomeCode: PluginCallErrorCode = "outcome_unknown";
export const quarantinedPluginCode: PluginCallErrorCode = "plugin_faulted";

// @ts-expect-error Whole-package revision_mismatch was removed in favor of clientDigest + runtime instanceId.
export const removedRevisionCode: PluginCallErrorCode = "revision_mismatch";

export const minimalShellPlugin = defineClientPlugin((lody) => {
  // @ts-expect-error Singleton `sidebar.replace` was unified into selectable `sidebar.views.add` + `sessionRow.decorate`.
  void lody.sidebar.replace;

  // @ts-expect-error Speculative `results.add` MIME renderer was removed because history stores structured `tool_call` outputs.
  void lody.results;

  lody.themes.add({
    id: "live-ocean",
    label: "Live Ocean",
    appearance: "dark",
    seed: { bg: "#0b1220", fg: "#e2e8f0", accent: "#38bdf8" },
    tokens: { density: "compact", radius: "6px" },
  });

  lody.styles.add({
    id: "custom-backdrop",
    css: ":root { --composer-backdrop-blur: 12px; }",
  });

  lody.settings.pages.add({
    id: "tracker-installation-settings",
    title: "Tracker Connection",
    binding: "installation",
    Component: () => null,
  });

  return async () => {};
});

export function verifyToolRenderStateNarrowing(
  props: ToolRenderProps<
    { readonly filter?: string },
    { readonly passed: number }
  >,
): number | null {
  const id: string = props.toolCallId;
  void id;
  if (props.status === "running") {
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
  pageProps: ProjectPageProps,
) {
  const lody = useLody();
  const workspaceSessions = await lody.read(workspace, lodyQueries.sessions, {
    archived: false,
  });
  const repoGit = await lody.read(project, lodyQueries.gitState);
  void workspaceSessions.items;
  void repoGit.branch;

  // @ts-expect-error Queries with required input parameters cannot omit input.
  void lody.read(project, lodyQueries.filePreview);

  // Surface props stay thin — raw repository state comes from `useLodyQuery`, not prop stuffing.
  // @ts-expect-error Raw repositoryState is pulled via useLodyQuery(project, lodyQueries.gitState).
  void pageProps.repositoryState;

  // WorkspaceRef is purely logical and has no single machineId.
  // @ts-expect-error WorkspaceRef does not carry a single machineId.
  void workspace.machineId;

  const machinesRead = useLodyQuery(workspace, lodyQueries.machines);
  if (machinesRead.status === "ready") {
    const firstMachine: MachineRef | undefined =
      machinesRead.data.items[0]?.machine;
    void firstMachine;
  }

  const rolesRead = useLodyQuery(workspace, lodyQueries.agentRoles);
  if (rolesRead.status === "ready") {
    const firstRoleName: string | undefined = rolesRead.data.items[0]?.name;
    void firstRoleName;
  }

  const gitRead = useLodyQuery(project, lodyQueries.gitState);
  if (gitRead.status === "ready") {
    const dirty: boolean = gitRead.data.dirty;
    void dirty;
  }

  const diffRead = useLodyQuery(session, lodyQueries.sessionDiff);
  if (diffRead.status === "ready") {
    const fileCount: number = diffRead.data.files.length;
    void fileCount;
  }

  const okMachineRead = useQuery(machine, machineDigestQuery, {});
  if (okMachineRead.status === "ready") {
    const count: number = okMachineRead.data.count;
    void count;
  }

  const okSessionRead = useQuery(session, sessionMonitorQuery, {});
  if (okSessionRead.status === "ready") {
    const step: string | null = okSessionRead.data.activeStep;
    void step;
  }

  // @ts-expect-error Built-in `lodyQueries` go through `useLodyQuery`, keeping `useQuery` strictly for plugin `QueryDescriptor`.
  useQuery(project, lodyQueries.sessions, { archived: false });

  const detailRead = useLodyQuery(session, lodyQueries.sessionDetail, {
    recentTurnLimit: 5,
  });
  if (detailRead.status === "ready") {
    const turnCount: number = detailRead.data.recentTurns.length;
    const questionSource: "lody" | "claude" | "codex" | undefined =
      detailRead.data.pendingQuestion?.source;
    const answerKey: string | undefined =
      detailRead.data.pendingQuestion?.questions[0]?.answerKey;
    void turnCount;
    void questionSource;
    void answerKey;
  }

  const byKeyRead = useLodyQuery(project, lodyQueries.sessions, {
    createdByMe: true,
    createdByPlugin: true,
    businessKey: "review/42/abc123",
  });
  if (byKeyRead.status === "ready") {
    const first = byKeyRead.data.items[0];
    const key: string | undefined = first?.businessKey;
    const rootOpener: string | undefined = first?.openedByRootSessionId;
    const roleId: string | undefined = first?.agentRoleId;
    const pendingKind: "permission" | "ask_user_question" | undefined =
      first?.pendingInteraction?.kind;
    void key;
    void rootOpener;
    void roleId;
    void pendingKind;
  }

  // @ts-expect-error Project-scoped query cannot be called with a WorkspaceRef.
  useLodyQuery(workspace, lodyQueries.worktrees);

  // @ts-expect-error Machine-scoped plugin query cannot be called with a WorkspaceRef.
  useQuery(workspace, machineDigestQuery, {});

  // @ts-expect-error Workspace-scoped query cannot be called with a ProjectRef.
  useLodyQuery(project, lodyQueries.projects);

  const pin = useMutation(project, projectPinMutation);
  // @ts-expect-error Mutation input is validated against the Zod input schema.
  void pin.mutate({ itemId: 42 });

  const sendReceipt = await lody.sessions.send(session, {
    idempotencyKey: "followup-1",
    prompt: "Summarize the latest test failures.",
    delivery: "queue",
  });
  void sendReceipt.disposition;
  await lody.sessions.answerQuestion(session, {
    requestId: "req-1",
    answers: { rolloutTarget: "Canary shard (5%)" },
  });
  await lody.sessions.requestStop(session);
  lody.panels.openSession(session, "issues", { identifier: "LODY-101" });
  lody.screens.open(workspace, "swarm-hub");
  lody.pages.openProject(project, "worktrees");
  lody.themes.activate("cyber-war-room");

  const createRequest: CreateSessionRequest = {
    requestId: "create-review-attempt-1",
    businessKey: "review/42/abc123",
    roleId: "role_reviewer",
    parentSession: session,
    pullRequestUrl: "https://github.com/lodyai/lody/pull/42",
    prompt: "Review PR #42 at abc123.",
  };
  await lody.sessions.create(project, createRequest);
  // Unbound Sessions and drafts can target a MachineRef without a ProjectRef.
  await lody.sessions.create(machine, {
    requestId: "create-unbound-triage-1",
    prompt: "Inspect recent daemon alerts.",
  });
  lody.drafts.open(machine, {
    prompt: "Quick machine-scoped investigation.",
    roleId: "role_reviewer",
  });

  // The same immutable request is used after an uncertain result, even if the
  // original Session has since been archived. A new generation gets a new ID.
  await lody.sessions.create(project, createRequest);
  await lody.sessions.create(project, {
    ...createRequest,
    requestId: "create-review-attempt-2",
  });

  // @ts-expect-error A business key alone cannot identify a retryable creation request.
  const missingRequestId: CreateSessionRequest = {
    businessKey: "review/42",
    prompt: "Review.",
  };
  void missingRequestId;
  const legacyCreateRequest: CreateSessionRequest = {
    requestId: "create-review-attempt-3",
    // @ts-expect-error Creation separates request identity from business-task identity.
    idempotencyKey: "review/42",
    prompt: "Review.",
  };
  void legacyCreateRequest;

  // @ts-expect-error Raw ID objects cannot forge a branded SessionRef capability.
  lody.sessions.open({
    workspaceId: "lw_1",
    machineId: "m_1",
    sessionId: "s_1",
  });

  // @ts-expect-error Route params are immutable; navigation goes through lody.pages.openProject.
  pageProps.params.pr = "99";
}

import {
  useHostCapabilities,
  useLodySnapshot,
  usePluginConfig,
} from "@lody/plugin-sdk/client";

export const invalidClientSecretManifest: PluginManifest = {
  id: "bad-secret-scope",
  version: "0.1.0",
  sdk: "^1.0.0",
  title: "Bad Secret Scope",
  config: {
    // @ts-expect-error Secret config fields MUST NOT target client scope.
    API_SECRET: {
      type: "secret",
      label: "Secret Key",
      scope: "client",
    },
  },
};

export async function verifyExtensibilityAndRawSnapshots(
  workspace: WorkspaceRef,
  session: SessionRef,
) {
  const lody = useLody();
  const caps = useHostCapabilities();
  const platform: "desktop" | "web" | "mobile" = caps.platform;
  void platform;

  const cfg = usePluginConfig<{ readonly volume: number }>();
  await cfg.set("volume", 0.8);
  // @ts-expect-error Config setter validates value types per declared key.
  void cfg.set("volume", "loud");

  const turnsRead = useLodyQuery(session, lodyQueries.sessionTurns, {
    limit: 20,
  });
  if (turnsRead.status === "ready") {
    const firstToolName: string | undefined =
      turnsRead.data.items[0]?.toolCalls[0]?.toolName;
    void firstToolName;
  }

  const subagentRead = useLodyQuery(session, lodyQueries.subagentRun, {
    runId: "run_1",
  });
  if (subagentRead.status === "ready") {
    const nestedTurnCount: number | undefined = subagentRead.data?.turns.length;
    void nestedTurnCount;
  }

  const rawSnap = await lody.readSnapshot({
    kind: "session-transcript",
    session,
  });
  const rev: string = rawSnap.revision;
  void rev;
  // @ts-expect-error RawDocumentSnapshot is deeply readonly; mutations go through Kernel/HistoryWriter APIs.
  rawSnap.doc.mutated = true;

  const selectedSnap = useLodySnapshot(
    { kind: "session-meta", session },
    (snap) => snap.schemaVersion,
  );
  if (selectedSnap.status === "ready") {
    const ver: number = selectedSnap.data;
    void ver;
  }
}
