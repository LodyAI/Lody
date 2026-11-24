import { useState } from 'react';
import {
  defineClientPlugin,
  useHostCapabilities,
  useLody,
  useLodyQuery,
  lodyQueries,
  type MatchedToolRenderProps,
  type MessageBlockRenderProps,
  type ScreenProps,
} from '@lody/plugin-sdk/client';
import { Badge, Button } from '@lody/ui';

function UniversalTestRunCard({ call, appendToDraft, showRawOutput }: MatchedToolRenderProps) {
  return (
    <div>
      <Badge tone={call.status === 'failed' ? 'danger' : 'success'}>
        {call.toolName}: {call.status}
      </Badge>
      {call.command ? <code>{call.command}</code> : null}
      <Button onClick={showRawOutput}>View Raw Output</Button>
      {call.status === 'failed' && call.outputText ? (
        <Button
          onClick={() =>
            appendToDraft({
              kind: 'text',
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

export function SorbetPlanArtifact({
  turnId,
  blockId,
  code,
  streaming,
  project,
  session,
}: MessageBlockRenderProps) {
  const lody = useLody();
  // Local interactive selection survives incremental streaming updates because the host
  // keys this mounted block renderer by stable `blockId` (`<turnId>:block:<ordinal>`).
  const [selectedSteps, setSelectedSteps] = useState<readonly string[]>([]);
  const steps = code
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  function toggleStep(step: string) {
    setSelectedSteps((prev) =>
      prev.includes(step) ? prev.filter((s) => s !== step) : [...prev, step]
    );
  }

  return (
    <div data-turn-id={turnId} data-block-id={blockId}>
      <Badge tone={streaming ? 'neutral' : 'success'}>
        {streaming ? 'Drafting Sorbet Plan' : 'Sorbet Plan Ready'}
      </Badge>
      <ul>
        {steps.map((step, index) => (
          <li key={`${blockId}-step-${index}`}>
            <Button onClick={() => toggleStep(step)}>
              {selectedSteps.includes(step) ? '[x]' : '[ ]'} {step}
            </Button>
          </li>
        ))}
      </ul>
      {!streaming && project ? (
        <Button
          onClick={() =>
            lody.drafts.open(project, {
              roleId: 'plugin:sorbet-workflow:sorbet-architect',
              providerId: 'plugin:sorbet-workflow:sorbet-acp',
              prompt: `Execute approved plan (${blockId}) from ${session.sessionId}:\n${
                selectedSteps.length > 0 ? selectedSteps.join('\n') : code
              }`,
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
  const verifiers = useLodyQuery(workspace, lodyQueries.sessions, {
    agentRoleId: 'plugin:sorbet-workflow:sorbet-verifier',
    archived: false,
    limit: 1,
  });

  return (
    <div>
      <Badge tone="neutral">
        {capabilities.platform} ({capabilities.formFactor})
      </Badge>
      {verifiers.status === 'ready' ? (
        <span>
          {verifiers.data.items.length ? 'Active verifier session' : 'No active verifier sessions'}
        </span>
      ) : null}
    </div>
  );
}

export default defineClientPlugin((lody) => {
  lody.tools.matchRender({
    id: 'universal-test-runner-card',
    priority: 10,
    mode: 'replace',
    match: {
      acpKinds: ['execute'],
      commandPattern: '(vitest|pytest|node --test|cargo test)',
    },
    Component: UniversalTestRunCard,
  });

  lody.messages.renderBlock({
    id: 'sorbet-plan-block',
    languages: ['sorbet-plan'],
    priority: 10,
    Component: SorbetPlanArtifact,
  });

  lody.screens.add({
    id: 'sorbet-hub',
    title: 'Sorbet Hub',
    Component: SorbetWorkspaceHub,
  });
});
