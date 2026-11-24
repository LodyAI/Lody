import type { SessionId, SessionMeta } from '@lody/shared';
import type { LoroDocumentManager } from '../lib/loro/doc';
import type { HostToChildFrame } from '@lody/shared/plugins/ipc-protocol';

type TurnEvent =
  | { type: 'session.turn.started'; turnId: string; userTurnId?: string }
  | {
      type: 'session.turn.completed';
      turnId: string;
      userTurnId?: string;
      endedAt: number;
      stopReason: 'cancelled' | 'error' | 'unknown';
      durationMs?: number;
    };
export class PluginTurnEvents {
  private tails = new Map<SessionId, Promise<void>>();
  private closed = false;
  pending(sessionId: SessionId) {
    return this.tails.get(sessionId) ?? Promise.resolve();
  }
  close() {
    this.closed = true;
  }
  constructor(
    private readonly docs: LoroDocumentManager,
    private readonly workspaceId: string,
    private readonly machineId: string,
    private readonly userId: string,
    private readonly warn: (id: SessionId) => void
  ) {}
  publish(
    sessionId: SessionId,
    meta: () => Promise<SessionMeta | undefined>,
    fact: () => Promise<TurnEvent | undefined>
  ) {
    if (this.closed || !this.docs.pluginDaemon) return;
    const next = (this.tails.get(sessionId) ?? Promise.resolve())
      .then(async () => {
        const m = await meta();
        if (
          !m ||
          m.id !== sessionId ||
          m.machineId !== this.machineId ||
          m.userId !== this.userId ||
          m.isArchived
        )
          return;
        const projectId = m.project?.kind === 'local' ? m.project.localProjectId : undefined;
        const daemon = await this.docs.pluginDaemon?.();
        if (!daemon) return;
        const event = await fact();
        if (!event) return;
        const workspace = { workspaceId: this.workspaceId };
        const machine = { ...workspace, machineId: this.machineId };
        const project = projectId ? { ...machine, projectId } : undefined;
        const session = { ...(project ?? machine), sessionId };
        const frame: Extract<HostToChildFrame, { type: 'event' }> = {
          type: 'event',
          eventType: event.type,
          eventId: JSON.stringify([
            event.type,
            sessionId,
            event.turnId,
            event.type === 'session.turn.completed' ? event.endedAt : null,
          ]),
          payload: {
            workspace,
            machine,
            session,
            ...(project ? { project } : {}),
            turnId: event.turnId,
            ...(event.userTurnId ? { userTurnId: event.userTurnId } : {}),
            ...(event.type === 'session.turn.completed'
              ? {
                  stopReason: event.stopReason,
                  ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
                }
              : {}),
          },
        };
        // A completed input is provenance in the payload, not a live signing principal.
        await daemon.event(frame, async () => {
          const current = await meta();
          if (
            !current ||
            current.id !== m.id ||
            current.machineId !== m.machineId ||
            current.userId !== m.userId ||
            current.isArchived ||
            current.parentSessionId !== m.parentSessionId ||
            (current.project?.kind === 'local' ? current.project.localProjectId : undefined) !==
              projectId
          )
            return false;
          if (
            this.docs.isEncryptedWorkspace() &&
            (current.parentSessionId ||
              !(await this.docs.authorizeEncryptedSessionRead({
                machineId: m.machineId,
                rootSessionId: m.id,
                requesterUserId: this.userId,
                sessionOwnerUserId: m.userId,
                localProjectId: projectId,
              })))
          )
            return false;
          return !this.closed && (await this.docs.pluginDaemon?.()) === daemon;
        });
      })
      .catch(() => this.warn(sessionId));
    this.tails.set(sessionId, next);
    void next.then(() => {
      if (this.tails.get(sessionId) === next) this.tails.delete(sessionId);
    });
    return next;
  }
}
