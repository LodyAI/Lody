import { Effect, Scope, Exit } from 'effect';
import { encryptedRpcFixture } from '../../../../packages/loro-streams-rpc/tests/fixtures/e2ee-native-fixture';
import { makeCliE2eeExecutionAuthorization } from '../../src/lib/e2ee/execution-authorization';
import type {
  WorkflowGrantRequest,
  DeclaredGrantSignature,
} from '@lody/shared/plugins/machine-rpc';
import { bindDeclaredGrantActor } from '../../src/plugins/workflow/declared-workflow';
import type { PluginDaemon } from '../../src/plugins/plugin-host-legacy';
import type { MachineId } from '@lody/shared';

/** Fixed ledger with actual owner personal-device and machine signers; latest-history I/O is local. */
export async function ownerApprovalFixture() {
  let nextRequest = 0;
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
  const verifyDeclaredWorkflowGrant = async (
    signature: DeclaredGrantSignature,
    machine: string
  ) => {
    const { request: req, signer } = await Effect.runPromise(
      f.receiver.openDeclaredWorkflowGrant(machine, signature)
    );
    const grant = await Effect.runPromise(auth.authorizeOwnedExecution(workspaceId, signer, true));
    if (
      !req ||
      req.params.grant.targetDevice !== signingPublicKey ||
      grant._tag !== 'Authorized' ||
      grant.principal !== 'owner' ||
      !grant.isCurrent?.() ||
      f.ledger.view().inspectState().devices.get(signer)?.kind !== 'personal'
    )
      throw Error('Owner approval denied');
    return { approval: req.params.grant, isCurrent: grant.isCurrent };
  };
  const identity = {
    pluginAuthoritySignal: auth.authoritySignal,
    signingPublicKey,
    verifyDeclaredWorkflowGrant,
  };
  return {
    f,
    identity,
    async issue(
      host: PluginDaemon,
      params: WorkflowGrantRequest,
      projectExists: (id: string) => Promise<boolean>
    ) {
      const orig = await Effect.runPromise(
        f.sender.prepareFeature({
          requestId: (++nextRequest).toString(16).padStart(32, '0'),
          request: {
            workspaceId,
            machineId,
            method: 'plugin/control',
            params: { action: 'manage-workflow-grant', grant: params },
          },
        })
      );
      const opened = await Effect.runPromise(f.receiver.openFeature(machineId, orig.frameHex));
      if (
        !opened ||
        opened.input.request.method !== 'plugin/control' ||
        opened.input.request.params.action !== 'manage-workflow-grant'
      )
        throw Error('Invalid approval envelope');
      await Effect.runPromise(f.receiver.retainFeatureRequest(machineId, opened));
      const receipt = Buffer.from(opened.frame).toString('hex');
      const proof = await verifyDeclaredWorkflowGrant(receipt, machineId);
      const verifiedRequest = opened.input.request;
      const actor = await bindDeclaredGrantActor({
        params: opened.input.request.params.grant,
        machineId,
        identity,
        projectExists,
        actor: {
          userId: opened.requesterDevice,
          machineOwner: proof.isCurrent(),
          declaredGrantSignature: receipt,
        },
      });
      return host.dispatchMachineRpc(verifiedRequest, actor);
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
