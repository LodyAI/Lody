import {
  SessionRow,
  SidebarRow,
  defineClientPlugin,
  lodyQueries,
  useLody,
  useLodyQuery,
  type ScreenProps,
  type SessionRowSlotProps,
  type SessionSummary,
  type SidebarItemProps,
  type SidebarViewProps,
} from "@lody/plugin-sdk/client";
import { Alert, Badge, Button, Card, Input } from "@lody/ui";
import { useState } from "react";

/**
 * Layer 1 (`sidebar.sessionRow.decorate`): Composable row-level enhancement.
 * Adds a `? Input` pill and an interactive Claude Code-style hover popover to answer pending
 * `ask_user_question` prompts in place without switching out of the active Session — and works
 * automatically across both Lody's built-in sidebar and custom `<SessionRow />` sidebar views!
 */
function WaitingQuestionBadge({ session }: SessionRowSlotProps) {
  if (!session.pendingInteraction) return null;
  return (
    <Badge
      tone={
        session.pendingInteraction.kind === "ask_user_question"
          ? "running"
          : "warning"
      }
    >
      {session.pendingInteraction.kind === "ask_user_question"
        ? "? Input"
        : "Approval"}
    </Badge>
  );
}

function HoverQuickAnswerBody({ session }: { session: SessionSummary }) {
  const lody = useLody();
  const detail = useLodyQuery(session.session, lodyQueries.sessionDetail, {
    recentTurnLimit: 1,
  });
  const [step, setStep] = useState(0);
  const [draftAnswers, setDraftAnswers] = useState<Record<string, string>>({});
  const [customAnswer, setCustomAnswer] = useState("");

  if (detail.status !== "ready" || !detail.data.pendingQuestion) {
    return <div>Loading question…</div>;
  }

  const prompt = detail.data.pendingQuestion;
  const current = prompt.questions[step] ?? prompt.questions[0];
  if (!current) return null;

  const chooseAnswer = (value: string) => {
    const nextAnswers = { ...draftAnswers, [current.answerKey]: value };
    setDraftAnswers(nextAnswers);
    if (step < prompt.questions.length - 1) {
      setStep((index) => index + 1);
      return;
    }
    void lody.sessions.answerQuestion(session.session, {
      requestId: prompt.requestId,
      answers: nextAnswers,
    });
  };

  return (
    <Card.Root>
      <Card.Header>
        <Card.Title>{session.title}</Card.Title>
        {prompt.questions.length > 1 && (
          <div>
            <Button
              size="mini"
              variant="ghost"
              disabled={step === 0}
              onClick={() => setStep((index) => Math.max(0, index - 1))}
            >
              Prev
            </Button>
            <span>
              {step + 1}/{prompt.questions.length}
            </span>
            <Button
              size="mini"
              variant="ghost"
              disabled={step >= prompt.questions.length - 1}
              onClick={() =>
                setStep((index) =>
                  Math.min(prompt.questions.length - 1, index + 1),
                )
              }
            >
              Next
            </Button>
          </div>
        )}
      </Card.Header>
      <div>
        <Card.Description>{current.header}</Card.Description>
        <div>{current.question}</div>
        <div>
          {current.options.map((option) => (
            <Button
              key={option.label}
              size="small"
              variant={
                draftAnswers[current.answerKey] === option.label
                  ? "primary"
                  : "secondary"
              }
              onClick={() => chooseAnswer(option.label)}
            >
              {option.label}
            </Button>
          ))}
        </div>
        {(current.allowCustomAnswer ?? prompt.allowCustomAnswer) && (
          <Card.Footer>
            <Input
              size="small"
              value={customAnswer}
              placeholder="Or type your own answer…"
              onChange={(event) => setCustomAnswer(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && customAnswer.trim()) {
                  chooseAnswer(customAnswer.trim());
                  setCustomAnswer("");
                }
              }}
            />
          </Card.Footer>
        )}
      </div>
    </Card.Root>
  );
}

function HoverQuickAnswerCard({ session }: SessionRowSlotProps) {
  if (session.pendingInteraction?.kind !== "ask_user_question") return null;
  return <HoverQuickAnswerBody session={session} />;
}

/**
 * Layer 2 (`sidebar.headerItems` + `screens.add`): Native `<SidebarRow />` entry opening a
 * full-screen multi-Agent War Room without replacing the user's everyday conversation list.
 */
function SwarmHubHeaderEntry({ workspace }: SidebarItemProps) {
  const lody = useLody();
  const running = useLodyQuery(workspace, lodyQueries.sessions, {
    archived: false,
    status: "busy",
    limit: 50,
  });
  const runningCount =
    running.status === "ready" ? running.data.items.length : 0;

  return (
    <SidebarRow
      label="Swarm Hub"
      trailing={
        runningCount > 0 ? (
          <Badge tone="running">{runningCount}</Badge>
        ) : undefined
      }
      onClick={() => lody.screens.open(workspace, "swarm-hub")}
    />
  );
}

function SwarmHubScreen({ workspace }: ScreenProps) {
  const lody = useLody();
  const sessions = useLodyQuery(workspace, lodyQueries.sessions, {
    archived: false,
    limit: 60,
  });

  if (sessions.status === "loading") return <div>Loading active agents…</div>;
  if (sessions.status !== "ready") {
    return (
      <Alert.Root tone="warning">
        <Alert.Description>
          Unable to load workspace sessions.
        </Alert.Description>
      </Alert.Root>
    );
  }

  return (
    <div>
      {sessions.data.items.map((item) => (
        <Card.Root key={item.session.sessionId}>
          <Card.Header>
            <Card.Title>{item.title}</Card.Title>
            <Badge tone={item.status === "busy" ? "running" : "neutral"}>
              {item.status}
            </Badge>
          </Card.Header>
          <Card.Footer>
            <Button
              size="small"
              variant="secondary"
              onClick={() => lody.sessions.open(item.session)}
            >
              Open
            </Button>
            {item.status === "busy" && (
              <Button
                size="small"
                variant="ghost"
                onClick={() => void lody.sessions.requestStop(item.session)}
              >
                Stop
              </Button>
            )}
          </Card.Footer>
        </Card.Root>
      ))}
    </div>
  );
}

/**
 * Layer 3 (`sidebar.views.add`): Paseo-style pure custom sidebar view over raw `lodyQueries.sessions`
 * (`openedByRootSessionId`, `agentRoleId`). Rendering `<SessionRow />` composes `HoverQuickAnswerCard`!
 */
function SwarmTreeSidebarView({ workspace, activeSession }: SidebarViewProps) {
  const lody = useLody();
  const sessions = useLodyQuery(workspace, lodyQueries.sessions, {
    archived: false,
    limit: 100,
  });
  const roles = useLodyQuery(workspace, lodyQueries.agentRoles);

  if (sessions.status !== "ready")
    return <div>Loading workspace sessions…</div>;

  const roleById = new Map(
    roles.status === "ready"
      ? roles.data.items.map((role) => [role.roleId, role])
      : [],
  );
  const childrenByRoot = new Map<string, SessionSummary[]>();
  const roots: SessionSummary[] = [];

  for (const item of sessions.data.items) {
    const rootId = item.openedByRootSessionId ?? item.openedBySessionId;
    if (!rootId) {
      roots.push(item);
      continue;
    }
    const bucket = childrenByRoot.get(rootId) ?? [];
    bucket.push(item);
    childrenByRoot.set(rootId, bucket);
  }

  return (
    <div>
      {roots.map((root) => {
        const subagents = childrenByRoot.get(root.session.sessionId) ?? [];
        return (
          <div key={root.session.sessionId}>
            <SessionRow
              session={root}
              selected={activeSession?.sessionId === root.session.sessionId}
              onClick={() => lody.sessions.open(root.session)}
            />
            {subagents.map((child) => {
              const role = child.agentRoleId
                ? roleById.get(child.agentRoleId)
                : undefined;
              return (
                <SessionRow
                  key={child.session.sessionId}
                  session={child}
                  indent={1}
                  leading={role?.emoji ? <span>{role.emoji}</span> : undefined}
                  selected={
                    activeSession?.sessionId === child.session.sessionId
                  }
                  onClick={() => lody.sessions.open(child.session)}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export default defineClientPlugin((lody) => {
  lody.sidebar.sessionRow.decorate({
    id: "hover-quick-answer",
    trailing: WaitingQuestionBadge,
    hoverCard: HoverQuickAnswerCard,
  });

  lody.sidebar.headerItems.add({
    id: "swarm-hub-entry",
    Component: SwarmHubHeaderEntry,
  });

  lody.screens.add({
    id: "swarm-hub",
    title: "Swarm Hub",
    Component: SwarmHubScreen,
  });

  lody.sidebar.views.add({
    id: "swarm-tree",
    title: "Agent Tree",
    Component: SwarmTreeSidebarView,
  });
});
