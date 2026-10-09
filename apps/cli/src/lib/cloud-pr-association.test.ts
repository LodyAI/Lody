import { describe, expect, it } from 'vitest';
import type { CloudPrAssociationInput } from '@lody/platform';
import type { SessionId, WorkspaceId } from '@lody/shared';
import { createCloudPrAssociationPort } from './cloud-pr-association';

const input: CloudPrAssociationInput = {
  workspaceId: 'workspace' as WorkspaceId,
  ownerSessionId: 'session' as SessionId,
  repoFullName: 'owner/repo',
  prNumber: 7,
  prUrl: 'https://github.com/owner/repo/pull/7',
  branch: 'feature',
  status: 'open',
};

function fixture() {
  let now = 0;
  let status = 403;
  let offline = false;
  const requests: Array<{ url: string; args: Record<string, unknown> }> = [];
  const linked: string[] = [];
  const port = createCloudPrAssociationPort({
    token: 'synthetic-token',
    authSiteUrl: 'https://synthetic.convex.site',
    nowMs: () => now,
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body)) as { args: Record<string, unknown> };
      requests.push({ url: String(url), args: body.args });
      if (offline) throw new Error('offline');
      if (status === 200) linked.push(String(body.args.sessionId));
      return new Response(null, { status });
    },
  });
  return {
    port,
    requests,
    linked,
    advance: (ms: number) => {
      now += ms;
    },
    respond: (code: number) => {
      status = code;
      offline = false;
    },
    disconnect: () => {
      offline = true;
    },
  };
}

describe('cloud PR association retry gate', () => {
  it.each([401, 403])(
    'cools down %s across sessions, then recovers without confirming skipped links',
    async (status) => {
      const f = fixture();
      f.respond(status);
      expect(await f.port.associatePullRequest(input)).toBe(false);
      f.respond(200);
      const other = { ...input, ownerSessionId: 'other' as SessionId, repoFullName: 'OWNER/REPO' };
      f.advance(15 * 60_000 - 1);
      expect(await f.port.associatePullRequest(other)).toBe(false);
      expect(f.linked).toEqual([]);
      expect(f.requests).toHaveLength(1);
      f.advance(1);
      expect(await f.port.associatePullRequest(other)).toBe(true);
      expect(await f.port.associatePullRequest(input)).toBe(true);
      expect(f.linked).toEqual(['other', 'session']);
      expect(f.requests[0]).toEqual({
        url: 'https://synthetic.convex.site/api/action',
        args: {
          ...input,
          ownerSessionId: undefined,
          sessionId: 'session',
          cliToken: 'synthetic-token',
        },
      });
    }
  );

  it('isolates repository and workspace gates', async () => {
    const f = fixture();
    expect(await f.port.associatePullRequest(input)).toBe(false);
    f.respond(200);
    expect(
      await f.port.associatePullRequest({ ...input, workspaceId: 'other-workspace' as WorkspaceId })
    ).toBe(true);
    expect(await f.port.associatePullRequest({ ...input, repoFullName: 'owner/another' })).toBe(
      true
    );
    expect(await f.port.associatePullRequest(input)).toBe(false);
    expect(f.linked).toHaveLength(2);
  });

  it.each(['500', 'network'])(
    'backs off %s failures to the cap and resets after success',
    async (failure) => {
      const f = fixture();
      if (failure === '500') f.respond(500);
      else f.disconnect();
      for (const delay of [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
        expect(await f.port.associatePullRequest(input)).toBe(false);
        const count = f.requests.length;
        f.advance(delay - 1);
        expect(await f.port.associatePullRequest(input)).toBe(false);
        expect(f.requests).toHaveLength(count);
        f.advance(1);
      }
      f.respond(200);
      expect(await f.port.associatePullRequest(input)).toBe(true);
      f.respond(500);
      expect(await f.port.associatePullRequest(input)).toBe(false);
      f.advance(60_000);
      f.respond(200);
      expect(await f.port.associatePullRequest(input)).toBe(true);
      expect(f.linked).toEqual(['session', 'session']);
    }
  );

  it('does not share a pending successful association between sessions', async () => {
    let finish: (response: Response) => void = () => {
      throw new Error('request not started');
    };
    const linked: string[] = [];
    const port = createCloudPrAssociationPort({
      token: 'synthetic-token',
      authSiteUrl: 'https://synthetic.convex.site',
      fetch: async (_url, init) => {
        const response = await new Promise<Response>((resolve) => {
          finish = resolve;
        });
        linked.push(JSON.parse(String(init?.body)).args.sessionId);
        return response;
      },
    });
    const first = port.associatePullRequest(input);
    expect(
      await port.associatePullRequest({ ...input, ownerSessionId: 'other' as SessionId })
    ).toBe(false);
    finish(new Response(null, { status: 200 }));
    expect(await first).toBe(true);
    expect(linked).toEqual(['session']);
  });
});
