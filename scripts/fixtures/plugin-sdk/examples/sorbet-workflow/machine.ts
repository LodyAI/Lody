import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineMachinePlugin } from "@lody/plugin-sdk/machine";
import { workflowStatusQuery } from "./shared";

interface WorkflowEntry {
  readonly sessionId: string;
  readonly projectId?: string;
  readonly turnId: string;
  readonly requestId: string;
  readonly businessKey: string;
  readonly verifierSessionId: string | null;
}

interface WorkflowJournal {
  readonly entries: Record<string, WorkflowEntry>;
}

let writeQueue = Promise.resolve();

async function readJournal(dataDir: string): Promise<WorkflowJournal> {
  try {
    const raw = await readFile(
      path.join(dataDir, "workflow-journal.json"),
      "utf8",
    );
    return JSON.parse(raw) as WorkflowJournal;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: {} };
    }
    throw err;
  }
}

async function saveJournal(
  dataDir: string,
  updater: (prev: WorkflowJournal) => WorkflowJournal,
): Promise<WorkflowJournal> {
  const nextOp = writeQueue.then(async () => {
    await mkdir(dataDir, { recursive: true });
    const current = await readJournal(dataDir);
    const updated = updater(current);
    const dest = path.join(dataDir, "workflow-journal.json");
    const tmp = `${dest}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(updated, null, 2), { flag: "wx" });
    await rename(tmp, dest);
    return updated;
  });
  writeQueue = nextOp.then(
    () => undefined,
    () => undefined,
  );
  return nextOp;
}

export default defineMachinePlugin((machine) => {
  // Recover any pending workflow verification interrupted by a daemon restart
  machine.onStart(async (ctx) => {
    const journal = await readJournal(ctx.dataDir);
    for (const entry of Object.values(journal.entries)) {
      if (entry.verifierSessionId !== null) continue;
      // Replay the exact persisted (requestId, businessKey) against Lody's durable receipt store
      const verifier = await ctx.lody.sessions.create(ctx.machine, {
        requestId: entry.requestId,
        businessKey: entry.businessKey,
        roleId: "plugin:sorbet-workflow:sorbet-architect",
        providerId: "plugin:sorbet-workflow:sorbet-acp",
        skillIds: ["sorbet-verifier"],
        prompt: `Verify completed Architect turn ${entry.turnId}.`,
      });
      await saveJournal(ctx.dataDir, (prev) => ({
        entries: {
          ...prev.entries,
          [entry.sessionId]: {
            ...entry,
            verifierSessionId: verifier.sessionId,
          },
        },
      }));
    }
  });

  machine.query(workflowStatusQuery, async (ctx) => {
    const journal = await readJournal(ctx.dataDir);
    const state = journal.entries[ctx.target.sessionId];
    return {
      lastVerifiedTurnId: state?.turnId ?? null,
      verifierSessionId: state?.verifierSessionId ?? null,
    };
  });

  machine.events.on("session.turn.completed", async (ctx, event) => {
    if (event.stopReason !== "end_turn") return;
    if (ctx.config.autoVerify === false) return;

    const rawMeta = await ctx.lody.readSnapshot({
      kind: "session-meta",
      session: event.session,
    });
    if (rawMeta.doc.agentRoleId !== "plugin:sorbet-workflow:sorbet-architect") {
      return;
    }

    const requestId = `verify-${event.session.sessionId}-${event.turnId}`;
    const businessKey = `verify/${event.session.sessionId}`;

    // Persist intent to durable ctx.dataDir BEFORE spawning so a mid-call daemon crash can recover
    await saveJournal(ctx.dataDir, (prev) => ({
      entries: {
        ...prev.entries,
        [event.session.sessionId]: {
          sessionId: event.session.sessionId,
          projectId: event.project?.projectId,
          turnId: event.turnId,
          requestId,
          businessKey,
          verifierSessionId: null,
        },
      },
    }));

    const target = event.project ?? event.machine;
    const verifier = await ctx.lody.sessions.create(target, {
      requestId,
      businessKey,
      roleId: "plugin:sorbet-workflow:sorbet-architect",
      providerId: "plugin:sorbet-workflow:sorbet-acp",
      parentSession: event.session,
      skillIds: ["sorbet-verifier"],
      prompt: `Verify completed Architect turn ${event.turnId}.`,
    });

    await saveJournal(ctx.dataDir, (prev) => ({
      entries: {
        ...prev.entries,
        [event.session.sessionId]: {
          sessionId: event.session.sessionId,
          projectId: event.project?.projectId,
          turnId: event.turnId,
          requestId,
          businessKey,
          verifierSessionId: verifier.sessionId,
        },
      },
    }));
    ctx.invalidate(workflowStatusQuery, event.session);
  });
});
