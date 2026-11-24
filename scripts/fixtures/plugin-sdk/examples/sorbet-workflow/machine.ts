import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defineMachinePlugin,
  lodyQueries,
  type MachineBaseContext,
  type ProjectRef,
  type SessionRef,
} from "@lody/plugin-sdk/machine";
import { workflowStatusQuery } from "./shared";

const ARCHITECT_ROLE_ID = "plugin:sorbet-workflow:sorbet-architect";
const VERIFIER_ROLE_ID = "plugin:sorbet-workflow:sorbet-verifier";
const SORBET_PROVIDER_ID = "plugin:sorbet-workflow:sorbet-acp";

interface WorkflowEntry {
  readonly sessionId: string;
  readonly turnId: string;
  readonly userTurnId?: string;
  readonly requestId: string;
  readonly businessKey: string;
  readonly verifierSessionId: string | null;
}

interface WorkflowJournal {
  readonly lastReconciledUpdatedAt: number;
  readonly entries: Record<string, WorkflowEntry>;
  readonly latestTurnBySession: Record<string, string>;
}

let writeQueue = Promise.resolve();
const inFlightByEntry = new Map<string, Promise<void>>();

function makeEntryKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}

async function readJournal(dataDir: string): Promise<WorkflowJournal> {
  try {
    const raw = await readFile(
      path.join(dataDir, "workflow-journal.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as Partial<WorkflowJournal>;
    return {
      lastReconciledUpdatedAt: parsed.lastReconciledUpdatedAt ?? 0,
      entries: parsed.entries ?? {},
      latestTurnBySession: parsed.latestTurnBySession ?? {},
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        lastReconciledUpdatedAt: 0,
        entries: {},
        latestTurnBySession: {},
      };
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

function ensureTurnVerified(
  ctx: MachineBaseContext,
  params: {
    readonly session: SessionRef;
    readonly project?: ProjectRef;
    readonly turnId: string;
    readonly userTurnId?: string;
  },
): Promise<void> {
  const entryKey = makeEntryKey(params.session.sessionId, params.turnId);
  const active = inFlightByEntry.get(entryKey);
  if (active) return active;

  const task = runTurnVerification(ctx, entryKey, params).finally(() => {
    inFlightByEntry.delete(entryKey);
  });
  inFlightByEntry.set(entryKey, task);
  return task;
}

async function runTurnVerification(
  ctx: MachineBaseContext,
  entryKey: string,
  params: {
    readonly session: SessionRef;
    readonly project?: ProjectRef;
    readonly turnId: string;
    readonly userTurnId?: string;
  },
): Promise<void> {
  const current = await readJournal(ctx.dataDir);
  const existing = current.entries[entryKey];
  if (existing && existing.verifierSessionId !== null) {
    return;
  }

  const requestId =
    existing?.requestId ??
    `verify-${params.session.sessionId}-${params.turnId}`;
  const businessKey =
    existing?.businessKey ??
    `verify/${params.session.sessionId}/${params.turnId}`;
  const userTurnId = params.userTurnId ?? existing?.userTurnId;

  // Persist intent to durable ctx.dataDir BEFORE spawning so a mid-call daemon crash can recover
  if (!existing) {
    await saveJournal(ctx.dataDir, (prev) => ({
      ...prev,
      entries: {
        ...prev.entries,
        [entryKey]: {
          sessionId: params.session.sessionId,
          turnId: params.turnId,
          userTurnId,
          requestId,
          businessKey,
          verifierSessionId: null,
        },
      },
    }));
  }

  if (!params.project) return;
  const verifier = await ctx.lody.sessions.create(params.project, {
    requestId,
    businessKey,
    roleId: VERIFIER_ROLE_ID,
    providerId: SORBET_PROVIDER_ID,
    parentSession: params.session,
    ...(userTurnId ? { originTurn: { session: params.session, userTurnId } } : {}),
    skillIds: ["sorbet-verifier"],
    prompt: `Verify completed Architect turn ${params.turnId}.`,
  });

  await saveJournal(ctx.dataDir, (prev) => ({
    ...prev,
    entries: {
      ...prev.entries,
      [entryKey]: {
        sessionId: params.session.sessionId,
        turnId: params.turnId,
        userTurnId,
        requestId,
        businessKey,
        verifierSessionId: verifier.sessionId,
      },
    },
    latestTurnBySession: {
      ...prev.latestTurnBySession,
      [params.session.sessionId]: params.turnId,
    },
  }));
  ctx.invalidate(workflowStatusQuery, params.session);
}

export default defineMachinePlugin((machine) => {
  // Reconcile both mid-call journal entries AND missed turn completions across daemon restarts
  machine.onStart(async (ctx) => {
    if (ctx.config.autoVerify === false) return;
    const journal = await readJournal(ctx.dataDir);

    // 1. Replay unfinished journal entries using live host-minted SessionRef + ProjectRef
    const pendingEntries = Object.values(journal.entries).filter(
      (entry) => entry.verifierSessionId === null,
    );
    if (pendingEntries.length > 0) {
      const pendingSessionIds = [
        ...new Set(pendingEntries.map((entry) => entry.sessionId)),
      ];
      const lookup = await ctx.lody.read(ctx.machine, lodyQueries.sessions, {
        sessionIds: pendingSessionIds,
      });
      const bySessionId = new Map(
        lookup.items.map((item) => [item.session.sessionId, item]),
      );
      for (const entry of pendingEntries) {
        const summary = bySessionId.get(entry.sessionId);
        if (!summary) continue;
        await ensureTurnVerified(ctx, {
          session: summary.session,
          project: summary.project,
          turnId: entry.turnId,
          userTurnId: entry.userTurnId,
        });
      }
    }

    // 2. Incrementally reconcile Architect sessions updated while the daemon/plugin was down
    const scanStartedAt = Date.now();
    let maxUpdatedAt = journal.lastReconciledUpdatedAt;
    let cursor: string | undefined;
    do {
      const page = await ctx.lody.read(ctx.machine, lodyQueries.sessions, {
        agentRoleId: ARCHITECT_ROLE_ID,
        updatedAfter: journal.lastReconciledUpdatedAt,
        ...(cursor ? { cursor } : {}),
      });
      for (const item of page.items) {
        if (item.updatedAt > maxUpdatedAt) {
          maxUpdatedAt = item.updatedAt;
        }
        let turnCursor: string | undefined;
        const completedTurns = [];
        do {
          const turnsPage = await ctx.lody.read(
            item.session,
            lodyQueries.sessionTurns,
            { limit: 20, ...(turnCursor ? { cursor: turnCursor } : {}) },
          );
          for (const turn of turnsPage.items) {
            if (
              turn.role === "assistant" &&
              turn.finished &&
              turn.stopReason === "end_turn"
            ) {
              completedTurns.push(turn);
            }
          }
          turnCursor = turnsPage.nextCursor;
        } while (turnCursor);

        completedTurns.sort((a, b) => a.createdAt - b.createdAt);
        for (const turn of completedTurns) {
          await ensureTurnVerified(ctx, {
            session: item.session,
            project: item.project,
            turnId: turn.turnId,
            userTurnId: turn.userTurnId,
          });
        }
      }
      cursor = page.nextCursor;
    } while (cursor);

    const nextWatermark = Math.min(scanStartedAt, maxUpdatedAt);
    if (nextWatermark > journal.lastReconciledUpdatedAt) {
      await saveJournal(ctx.dataDir, (prev) => ({
        ...prev,
        lastReconciledUpdatedAt: Math.max(
          prev.lastReconciledUpdatedAt,
          nextWatermark,
        ),
      }));
    }
  });

  machine.query(workflowStatusQuery, async (ctx) => {
    const journal = await readJournal(ctx.dataDir);
    const latestTurnId = journal.latestTurnBySession[ctx.target.sessionId];
    const state = latestTurnId
      ? journal.entries[makeEntryKey(ctx.target.sessionId, latestTurnId)]
      : undefined;
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
    if (rawMeta.doc.agentRoleId !== ARCHITECT_ROLE_ID) {
      return;
    }

    await ensureTurnVerified(ctx, {
      session: event.session,
      project: event.project,
      turnId: event.turnId,
      userTurnId: event.userTurnId,
    });
  });
});
