import { describe, it, expect } from 'vitest';
import { LoroRepo } from 'loro-repo';
import { type SessionId } from '@lody/shared';
import { pluginProposalMetaSchema } from '@lody/shared/plugins/proposal';
import { SessionDocument } from './loro/doc';
import { createSessionBackend } from '@/session/session-backend';
import { publishPluginProposal } from './plugin-proposal';
describe('plugin proposal receipt', () => {
  it('replays the decision without activating or replacing the frozen artifact', async () => {
    const repo = await LoroRepo.create({}),
      sessionId = 'proposal-test' as SessionId,
      doc = new SessionDocument(repo, sessionId, async () => {});
    await doc.initOffline(undefined, { historyBackend: 'loro' });
    try {
      const backend = await createSessionBackend(doc, { historyBackend: 'loro' });
      const cmd = { requestId: 'r', action: 'propose_install' as const, packagePath: 'dist/pkg' },
        scope = { workspaceId: 'w', sessionId, machineId: 'm', requesterUserId: 'u' };
      let digest = 'a'.repeat(64),
        now = 0;
      const run = () =>
        publishPluginProposal(
          backend,
          scope,
          cmd,
          async () => ({
            pluginId: 'example',
            title: 'Example',
            version: '1.0.0',
            sha256: digest,
            requestedCapabilities: ['machine'],
          }),
          () => now
        );
      expect((await run()).status).toBe('pending');
      digest = 'b'.repeat(64);
      expect(await run()).toMatchObject({
        status: 'superseded',
        artifact: { sha256: 'a'.repeat(64) },
      });
      now = 24 * 3600 * 1000;
      expect((await run()).status).toBe('expired');
      const read = await backend.readTurn('plugin-proposal-r');
      if (read.state !== 'ready') throw Error('No review card');
      const meta = pluginProposalMetaSchema.parse((read.turn.items?.[0] as { meta: unknown }).meta);
      await doc.sessionData.commands.replaceTurn(read.turn.id, {
        ...read.turn,
        items: [
          { type: 'system_notice', name: 'plugin_proposal', meta: { ...meta, status: 'rejected' } },
        ],
      });
      expect((await run()).status).toBe('rejected');
      expect(await backend.history.count()).toBe(1);
    } finally {
      await doc.destroy();
      await repo.destroy();
    }
  });

  it('renders an unrendered proposal from the canonical ledger record', async () => {
    const repo = await LoroRepo.create({}),
      sessionId = 'proposal-resume' as SessionId,
      doc = new SessionDocument(repo, sessionId, async () => {});
    await doc.initOffline(undefined, { historyBackend: 'loro' });
    try {
      const backend = await createSessionBackend(doc, { historyBackend: 'loro' });
      const command = {
          requestId: 'r',
          action: 'propose_install' as const,
          packagePath: 'dist/pkg',
        },
        scope = { workspaceId: 'w', sessionId, machineId: 'm', requesterUserId: 'u' },
        artifact = {
          pluginId: 'example',
          title: 'Example',
          version: '1.0.0',
          sha256: 'a'.repeat(64),
          requestedCapabilities: ['machine'],
        };
      const canonical = pluginProposalMetaSchema.parse({
        ...scope,
        command,
        artifact,
        status: 'pending',
        expiresAt: 5000,
      });
      const ledger = {
        read: async () => ({ meta: canonical, path: '/pkg' }),
        write: async () => {
          throw Error('must not rewrite the canonical proposal');
        },
      };
      const result = await publishPluginProposal(
        backend,
        scope,
        command,
        async () => {
          throw Error('must reuse the canonical artifact');
        },
        () => 2000,
        ledger
      );
      expect(result).toMatchObject({ status: 'pending', artifact });
      const card = await backend.readTurn('plugin-proposal-r');
      if (card.state !== 'ready') throw Error('No review card');
      expect(
        pluginProposalMetaSchema.parse((card.turn.items?.[0] as { meta: unknown }).meta)
      ).toEqual(canonical);
      await expect(
        publishPluginProposal(
          backend,
          scope,
          { ...command, packagePath: 'elsewhere' },
          async () => artifact,
          () => 2000,
          ledger
        )
      ).rejects.toThrow('Idempotency key conflict');
      expect(await backend.history.count()).toBe(1);
    } finally {
      await doc.destroy();
      await repo.destroy();
    }
  });
});

it('only the machine owner may consume an exact review, and replay never launches a second generation', async () => {
  const { mkdtemp, writeFile, rm, readdir } = await import('node:fs/promises'),
    { tmpdir } = await import('node:os'),
    { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'plugin-review-'));
  const { PluginDaemon } = await import('../plugins/plugin-host-legacy');
  const host = new PluginDaemon(join(root, 'host'), 'w', 'm', () => {});
  try {
    await host.start();
    const pkg = join(root, 'plugin.tgz');
    const { packPlugin } = await import('../plugins/plugin-package');
    await writeFile(
      join(root, 'lody.plugin.json'),
      JSON.stringify({
        id: 'test-plugin',
        title: 'Test',
        sdk: '^1.0.0',
        version: '1.0.0',
        client: 'main.ts',
      })
    );
    await writeFile(join(root, 'main.ts'), 'export default {};');
    await packPlugin(root, pkg);
    const { inspectProposalPackage } = await import('../plugins/plugin-package'),
      { decidePluginProposal, rememberPluginProposal } = await import('./plugin-proposal-decision');
    const artifact = await inspectProposalPackage(pkg);
    let meta = pluginProposalMetaSchema.parse({
      workspaceId: 'w',
      machineId: 'm',
      sessionId: 's',
      requesterUserId: 'u',
      expiresAt: 100,
      status: 'pending',
      artifact,
      command: { action: 'propose_install', requestId: 'r', packagePath: 'plugin.tgz' },
    });
    await rememberPluginProposal(root, meta, pkg);
    const params = {
      sessionId: 's',
      requestId: 'r',
      sha256: artifact.sha256,
      decision: 'approve' as const,
    };
    let now = 1;
    const call = (owner: boolean, decision: 'approve' | 'deny' = 'approve') =>
      decidePluginProposal({
        root,
        workspaceId: 'w',
        machineId: 'm',
        actor: { machineOwner: owner, userId: 'human' },
        params: { ...params, decision },
        now: () => now,
        readCard: async () => meta,
        updateCard: async (m) => {
          meta = m;
        },
        activate: (m, p) => host.activateProposal(m, p),
      });
    await expect(call(false)).rejects.toThrow('Owner');
    expect(await host.dispatch({ action: 'list' })).toMatchObject({ plugins: [] });
    now = 100;
    expect(await call(true)).toMatchObject({ status: 'expired' });
    now = 1;
    meta = { ...meta, artifact: { ...artifact, requestedCapabilities: ['machine'] } };
    await expect(call(true)).rejects.toThrow('Review card changed');
    meta = { ...meta, artifact };
    expect(await call(true, 'deny')).toMatchObject({ status: 'rejected' });
    expect(await call(true)).toMatchObject({ status: 'rejected' });
    expect(await host.dispatch({ action: 'list' })).toMatchObject({ plugins: [] });
    params.requestId = 'changed';
    meta = {
      ...meta,
      status: 'pending',
      command: { ...meta.command, requestId: params.requestId },
    };
    await rememberPluginProposal(root, meta, pkg);
    const original = await (await import('node:fs/promises')).readFile(pkg);
    await writeFile(join(root, 'main.ts'), 'export default { changed:true };');
    await rm(pkg);
    await packPlugin(root, pkg);
    expect(await call(true)).toMatchObject({ status: 'superseded' });
    await writeFile(pkg, original);
    expect(await call(true)).toMatchObject({ status: 'superseded' });
    expect(await host.dispatch({ action: 'list' })).toMatchObject({ plugins: [] });
    params.requestId = 'next';
    meta = { ...meta, status: 'pending', command: { ...meta.command, requestId: 'next' } };
    await rememberPluginProposal(root, meta, pkg);
    expect(await call(true)).toMatchObject({ status: 'approved' });
    expect(await host.dispatch({ action: 'list' })).toMatchObject({
      plugins: [{ pluginId: 'test-plugin', enabled: true }],
    });
    const generations = await readdir(join(root, 'host', 'generations'));
    expect(await call(true)).toMatchObject({ status: 'approved' });
    expect(await readdir(join(root, 'host', 'generations'))).toEqual(generations);
  } finally {
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
