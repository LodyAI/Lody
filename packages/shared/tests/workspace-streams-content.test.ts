import { describe, expect, it } from 'vitest';
import { getMachineFlockDocId } from '../src/machine-flock';
import { getWorkspaceFlockDocId } from '../src/workspace-flock';
import type { MachineId, WorkspaceId } from '../src/ids';
import { encryptedWorkspaceRoom } from '../src/workspace-streams-content';

describe('encrypted workspace room domains', () => {
  const workspace = 'room-owner' as WorkspaceId;
  it('accepts the actual shared Meta, session and configuration room identifiers', () => {
    expect(encryptedWorkspaceRoom(workspace, {kind:'meta'})).toEqual({resource:'meta', model:'flock'});
    expect(encryptedWorkspaceRoom(workspace, {kind:'doc',docId:'session-id'})).toEqual({resource:'doc:session-id',model:'loro'});
    for (const flockDocId of [getMachineFlockDocId(workspace, 'local' as MachineId), getWorkspaceFlockDocId(workspace)])
      expect(encryptedWorkspaceRoom(workspace,{kind:'flock',flockDocId})).toEqual({resource:`flock:${flockDocId}`,model:'flock'});
  });
  it('rejects other workspaces and all unimplemented Flock domains', () => {
    for (const flockDocId of [getMachineFlockDocId('other' as WorkspaceId,'local' as MachineId),getWorkspaceFlockDocId('other' as WorkspaceId),'wf','mf:local',`${workspace}:schedule:registry`,`${workspace}:collab:index`])
      expect(() => encryptedWorkspaceRoom(workspace,{kind:'flock',flockDocId})).toThrow('Encrypted workspace room is unavailable');
  });
});
