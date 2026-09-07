import type {
  CliBackendAuthorization,
  CliBackendConnection,
  CliRuntimeConnectivity,
  CliRuntimeIssue,
  CliRuntimeIssueSeverity,
  CliRuntimePhase,
  CliRuntimeStartupStage,
  CliRuntimeState,
  CliRuntimeWorkspace,
  MachineId,
} from '@lody/shared';

const MAX_RUNTIME_ISSUES = 50;

type UpsertCliRuntimeIssueInput = {
  code: string;
  severity: CliRuntimeIssueSeverity;
  recoverable: boolean;
  message: string;
};

type CliRuntimeStateReporterOptions = {
  machineId?: MachineId;
  pid?: number;
  supervisor?: CliRuntimeState['supervisor'];
  trackBackendConnectionAge?: boolean;
  now?: () => number;
};

export class CliRuntimeStateReporter {
  private readonly pid: number;
  private readonly supervisor: CliRuntimeState['supervisor'];
  private phase: CliRuntimePhase = 'starting';
  private startupStage: CliRuntimeStartupStage | undefined = 'bootstrap';
  private connectivity: CliRuntimeConnectivity | undefined;
  private backend: NonNullable<CliRuntimeState['backend']>;
  private backendNotConnectedSinceMs: number | undefined;
  private connectedWorkspaces: CliRuntimeWorkspace[] = [];
  private workspaceNotConnectedSinceMs = new Map<string, number>();
  private machineId: string | undefined;
  private activeSessionCount = 0;
  private connectedRoomCount = 0;
  private updatedAtMs: number;
  private readonly issuesByCode = new Map<string, CliRuntimeIssue>();
  private readonly trackBackendConnectionAge: boolean;
  private readonly now: () => number;

  constructor(options: CliRuntimeStateReporterOptions = {}) {
    this.pid = options.pid ?? process.pid;
    this.machineId = options.machineId;
    this.supervisor = options.supervisor;
    this.trackBackendConnectionAge = options.trackBackendConnectionAge ?? true;
    this.now = options.now ?? Date.now;
    this.updatedAtMs = this.now();
    this.backend = {
      authorization: 'pending',
      connection: 'connecting',
    };
    this.backendNotConnectedSinceMs = this.trackBackendConnectionAge ? this.updatedAtMs : undefined;
  }

  setMachineId(machineId: MachineId): void {
    if (this.machineId === machineId) {
      return;
    }
    this.machineId = machineId;
    this.touch();
  }

  setStartupStage(stage: CliRuntimeStartupStage): void {
    if (this.startupStage === stage) {
      return;
    }
    this.startupStage = stage;
    this.touch();
  }

  setActiveSessionCount(count: number): void {
    if (this.activeSessionCount === count) {
      return;
    }
    this.activeSessionCount = count;
    this.touch();
  }

  setConnectedRoomCount(count: number): void {
    if (this.connectedRoomCount === count) {
      return;
    }
    this.connectedRoomCount = count;
    this.touch();
  }

  setConnectivity(connectivity: CliRuntimeConnectivity): void {
    if (this.connectivity === connectivity) {
      return;
    }
    this.connectivity = connectivity;
    this.touch();
  }

  setBackendAuthorization(authorization: CliBackendAuthorization): void {
    if (this.backend.authorization === authorization) {
      return;
    }
    this.backend = { ...this.backend, authorization };
    this.touch();
  }

  setBackendConnection(connection: CliBackendConnection): void {
    const nowMs = this.now();
    const notConnectedSinceMs =
      !this.trackBackendConnectionAge || connection === 'connected'
        ? undefined
        : this.backend.connection === 'connected'
          ? nowMs
          : (this.backendNotConnectedSinceMs ?? nowMs);
    if (
      this.backend.connection === connection &&
      this.backendNotConnectedSinceMs === notConnectedSinceMs
    ) {
      return;
    }
    this.backend = { ...this.backend, connection };
    this.backendNotConnectedSinceMs = notConnectedSinceMs;
    this.touch();
  }

  setConnectedWorkspaces(workspaces: CliRuntimeWorkspace[]): void {
    const nowMs = this.now();
    const previousById = new Map(
      this.connectedWorkspaces.map((workspace) => [workspace.id, workspace])
    );
    const nextWorkspaceNotConnectedSinceMs = new Map<string, number>();
    const nextWorkspaces = workspaces.map((workspace): CliRuntimeWorkspace => {
      const previous = previousById.get(workspace.id);
      const notConnectedSinceMs =
        !this.trackBackendConnectionAge || workspace.backendConnection === 'connected'
          ? undefined
          : previous?.backendConnection === 'connected'
            ? nowMs
            : (this.workspaceNotConnectedSinceMs.get(workspace.id) ?? nowMs);
      if (notConnectedSinceMs !== undefined) {
        nextWorkspaceNotConnectedSinceMs.set(workspace.id, notConnectedSinceMs);
      }
      return {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        role: workspace.role,
        backendConnection: workspace.backendConnection,
      };
    });
    if (
      JSON.stringify(this.connectedWorkspaces) === JSON.stringify(nextWorkspaces) &&
      JSON.stringify([...this.workspaceNotConnectedSinceMs]) ===
        JSON.stringify([...nextWorkspaceNotConnectedSinceMs])
    ) {
      return;
    }
    this.connectedWorkspaces = nextWorkspaces;
    this.workspaceNotConnectedSinceMs = nextWorkspaceNotConnectedSinceMs;
    this.touch();
  }

  upsertIssue(input: UpsertCliRuntimeIssueInput): void {
    const nowMs = this.now();
    const existing = this.issuesByCode.get(input.code);
    if (existing) {
      const next: CliRuntimeIssue = {
        ...existing,
        severity: input.severity,
        recoverable: input.recoverable,
        message: input.message,
        lastSeenAtMs: nowMs,
        count: existing.count + 1,
      };
      this.issuesByCode.set(input.code, next);
      this.touch();
      return;
    }

    this.issuesByCode.set(input.code, {
      id: `${input.code}:${nowMs}`,
      code: input.code,
      severity: input.severity,
      recoverable: input.recoverable,
      message: input.message,
      firstSeenAtMs: nowMs,
      lastSeenAtMs: nowMs,
      count: 1,
    });
    this.trimIssues();
    this.touch();
  }

  clearIssue(code: string): void {
    if (!this.issuesByCode.delete(code)) {
      return;
    }
    this.touch();
  }

  clearRecoverableIssues(): void {
    const codesToDelete: string[] = [];
    for (const [code, issue] of this.issuesByCode) {
      if (issue.recoverable) {
        codesToDelete.push(code);
      }
    }

    if (codesToDelete.length === 0) {
      return;
    }

    for (const code of codesToDelete) {
      this.issuesByCode.delete(code);
    }
    this.touch();
  }

  snapshot(): CliRuntimeState {
    const issues = [...this.issuesByCode.values()].sort((left, right) => {
      if (left.lastSeenAtMs !== right.lastSeenAtMs) {
        return right.lastSeenAtMs - left.lastSeenAtMs;
      }
      return left.code.localeCompare(right.code);
    });

    return {
      schemaVersion: 1,
      phase: this.phase,
      startupStage: this.startupStage,
      connectivity: this.connectivity,
      backend: this.backend,
      connectedWorkspaces: this.connectedWorkspaces,
      connectionAges: this.trackBackendConnectionAge
        ? {
            ...(this.backendNotConnectedSinceMs === undefined
              ? {}
              : { backendNotConnectedSinceMs: this.backendNotConnectedSinceMs }),
            ...(this.workspaceNotConnectedSinceMs.size === 0
              ? {}
              : {
                  workspaceNotConnectedSinceMs: Object.fromEntries(
                    this.workspaceNotConnectedSinceMs
                  ),
                }),
          }
        : undefined,
      machineId: this.machineId,
      pid: this.pid,
      updatedAtMs: this.updatedAtMs,
      issues,
      activeSessionCount: this.activeSessionCount,
      connectedRoomCount: this.connectedRoomCount,
      supervisor: this.supervisor,
    };
  }

  private trimIssues(): void {
    if (this.issuesByCode.size <= MAX_RUNTIME_ISSUES) {
      return;
    }

    const entries = [...this.issuesByCode.entries()];
    entries.sort((left, right) => left[1].lastSeenAtMs - right[1].lastSeenAtMs);
    const overflow = this.issuesByCode.size - MAX_RUNTIME_ISSUES;
    for (let i = 0; i < overflow; i += 1) {
      const code = entries[i]?.[0];
      if (code) {
        this.issuesByCode.delete(code);
      }
    }
  }

  private touch(): void {
    this.updatedAtMs = this.now();
    this.phase = this.computePhase();
  }

  private computePhase(): CliRuntimePhase {
    if ([...this.issuesByCode.values()].some((issue) => issue.severity === 'fatal')) {
      return 'fatal';
    }

    if (this.startupStage !== 'ready') {
      return 'starting';
    }

    if (this.connectivity === 'offline') {
      return 'offline';
    }

    if (this.connectivity === 'reconnecting') {
      return 'degraded';
    }

    if (this.issuesByCode.size > 0) {
      return 'degraded';
    }

    return 'running';
  }
}
