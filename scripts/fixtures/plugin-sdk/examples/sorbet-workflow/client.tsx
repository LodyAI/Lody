import {
  defineClientPlugin,
  useHostCapabilities,
  useLody,
  useLodySnapshot,
  type MatchedToolRenderProps,
  type MessageBlockRenderProps,
  type ScreenProps,
} from "@lody/plugin-sdk/client";
import { Badge, Button } from "@lody/ui";

function UniversalTestRunCard({
  call,
  appendToDraft,
  showRawOutput,
}: MatchedToolRenderProps) {
  return (
    <div>
      <Badge tone={call.status === "failed" ? "danger" : "success"}>
        {call.toolName}: {call.status}
      </Badge>
      {call.command ? <code>{call.command}</code> : null}
      <Button onClick={showRawOutput}>View Raw Output</Button>
      {call.status === "failed" && call.outputText ? (
        <Button
          onClick={() =>
            appendToDraft({
              kind: "text",
              text: `Fix failing test command \`${
                call.command ?? call.title
              }\`:\n${call.outputText}`,
            })
          }
        >
          Send Failure to Draft
        </Button>
      ) : null}
    </div>
  );
}

function SorbetPlanArtifact({
  code,
  streaming,
  project,
  session,
}: MessageBlockRenderProps) {
  const lody = useLody();
  return (
    <div>
      <Badge tone={streaming ? "neutral" : "success"}>
        {streaming ? "Drafting Sorbet Plan" : "Sorbet Plan Ready"}
      </Badge>
      <pre>{code}</pre>
      {!streaming && project ? (
        <Button
          onClick={() =>
            lody.drafts.open(project, {
              roleId: "plugin:sorbet-workflow:sorbet-architect",
              providerId: "plugin:sorbet-workflow:sorbet-acp",
              prompt: `Execute approved plan from ${session.sessionId}:\n${code}`,
            })
          }
        >
          Launch Sorbet Execution
        </Button>
      ) : null}
    </div>
  );
}

function SorbetWorkspaceHub({ workspace }: ScreenProps) {
  const capabilities = useHostCapabilities();
  const rawState = useLodySnapshot(
    { kind: "workspace-state", workspace },
    (snap) => ({
      revision: snap.revision,
      topLevelKeys: Object.keys(snap.doc).length,
    }),
    (a, b) => a.revision === b.revision && a.topLevelKeys === b.topLevelKeys,
  );

  return (
    <div>
      <Badge tone="neutral">
        {capabilities.platform} ({capabilities.formFactor})
      </Badge>
      {rawState.status === "ready" ? (
        <span>
          Workspace rev {rawState.data.revision} ({rawState.data.topLevelKeys}{" "}
          collections)
        </span>
      ) : null}
    </div>
  );
}

export default defineClientPlugin((lody) => {
  lody.tools.matchRender({
    id: "universal-test-runner-card",
    priority: 10,
    mode: "replace",
    match: {
      acpKinds: ["execute"],
      commandPattern: "(vitest|pytest|node --test|cargo test)",
    },
    Component: UniversalTestRunCard,
  });

  lody.messages.renderBlock({
    id: "sorbet-plan-block",
    languages: ["sorbet-plan"],
    priority: 10,
    Component: SorbetPlanArtifact,
  });

  lody.screens.add({
    id: "sorbet-hub",
    title: "Sorbet Hub",
    Component: SorbetWorkspaceHub,
  });
});
