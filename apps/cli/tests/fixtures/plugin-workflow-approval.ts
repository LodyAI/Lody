import { Effect, Scope, Exit } from 'effect';
import { encryptedRpcFixture } from '../../../../packages/loro-streams-rpc/tests/fixtures/e2ee-native-fixture';
import { makeCliE2eeExecutionAuthorization } from '../../src/lib/e2ee/execution-authorization';
import type {
  WorkflowCreateApproval,
  WorkflowApprovalReceipt,
} from '@lody/shared/plugins/machine-rpc';
import { bindWorkflowApprovalActor } from '../../src/plugins/workflow/authorized-project-create';
import type { PluginDaemon } from '../../src/plugins/plugin-host-legacy';
import type { MachineId } from '@lody/shared';

/** Fixed ledger with actual owner personal-device and machine signers; latest-history I/O is local. */
export async function ownerApprovalFixture() {
  const f = encryptedRpcFixture();
  const scope = Scope.makeUnsafe();
  const machineId = f.machineId as MachineId,
    workspaceId = f.workspaceId;
  const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
  const signingPublicKey = hex(f.ledger.phone.raw);
  const checkpoint = {
    length: f.ledger.view().length,
    headHash: hex(f.ledger.view().head.toBytes()),
  };
  const status = {
    ...checkpoint,
    writeEpoch: 0,
    length: checkpoint.length,
    position: null,
    epoch: 0,
    rotationRequired: false,
    hasCurrentKey: true,
    devicePublicKey: signingPublicKey,
    membershipId: hex(
      f.ledger.view().inspectState().devices.get(signingPublicKey)!.membershipId.toBytes()
    ),
    protection: 'file' as const,
  };
  const auth = await Effect.runPromise(
    Scope.provide(
      makeCliE2eeExecutionAuthorization({
        workspaceId,
        credential: 'synthetic',
        cloud: {
          getHistory: async () => ({
            workspaceId,
            genesisHash: hex(f.ledger.context.genesis.toBytes()),
            checkpoint,
            startIndex: checkpoint.length,
            recordsHex: [],
            position: 'fixture-tip',
            nextCursor: null,
          }),
        },
        runtime: {
          executionLedger: f.ledger.ledger,
          executionGeneration: () => 0,
          status: () => Effect.succeed(status),
          ingest: () => Effect.succeed(status),
        },
      }),
      scope
    )
  );
  const verifyWorkflowApproval = async (receipt: WorkflowApprovalReceipt, machine: string) => {
    const req = await Effect.runPromise(
      f.receiver.readWorkflowApproval(machine, receipt.signer, receipt.requestId)
    );
    const grant = await Effect.runPromise(
      auth.authorizeOwnedExecution(workspaceId, receipt.signer, true)
    );
    if (
      !req ||
      req.params.targetDevice !== signingPublicKey ||
      grant._tag !== 'Authorized' ||
      grant.principal !== 'owner' ||
      !grant.isCurrent?.() ||
      f.ledger.view().inspectState().devices.get(receipt.signer)?.kind !== 'personal'
    )
      throw Error('Owner approval denied');
    return { approval: req.params, isCurrent: grant.isCurrent };
  };
  const identity = {
    pluginAuthoritySignal: auth.authoritySignal,
    signingPublicKey,
    verifyWorkflowApproval,
  };
  return {
    f,
    identity,
    async issue(
      host: PluginDaemon,
      params: WorkflowCreateApproval,
      projectExists: (id: string) => Promise<boolean>
    ) {
      const request = {
        workspaceId,
        machineId,
        method: 'plugin/workflow-create-approval' as const,
        params,
      };
      const orig = await Effect.runPromise(
        f.sender.prepareFeature({ requestId: '11'.repeat(16), request })
      );
      const opened = await Effect.runPromise(f.receiver.openFeature(machineId, orig.frameHex));
      if (!opened || opened.input.request.method !== request.method)
        throw Error('Invalid approval envelope');
      await Effect.runPromise(f.receiver.retainFeatureRequest(machineId, opened));
      const receipt = { requestId: opened.requestId, signer: opened.requesterDevice };
      const proof = await verifyWorkflowApproval(receipt, machineId);
      const actor = await bindWorkflowApprovalActor({
        request: opened.input.request,
        machineId,
        identity,
        projectExists,
        actor: {
          userId: opened.requesterDevice,
          machineOwner: proof.isCurrent(),
          workflowReceipt: receipt,
        },
      });
      return host.dispatchMachineRpc(opened.input.request, actor);
    },
    async close() {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await Promise.all([
        Effect.runPromise(f.sender.close()),
        Effect.runPromise(f.receiver.close()),
      ]);
      f.close();
    },
  };
}
