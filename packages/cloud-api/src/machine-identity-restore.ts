/** Account-authorized recovery of a daemon installation's previous identity. */
export interface MachineIdentityRestoreIntent {
  workspaceId: string;
  sourceMachineId: string;
  targetMachineId: string;
  requesterUserId: string;
  requestId: string;
}

/** Confirmation of the retained operation, including exact retries. */
export interface MachineIdentityRestoreResult {
  requestId: string;
  machineId: string;
}
