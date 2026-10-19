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
  const errors: string[] = [];
  const options: Parameters<typeof createCloudPrAssociationPort>[0] = {
    token: 'synthetic-token',
    authSiteUrl: 'https://synthetic.convex.site',
    nowMs: () => now,
    logger: {
      error: (message: string) => {
        errors.push(message);
      },
    },
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body)) as { args: Record<string, unknown> };
      requests.push({ url: String(url), args: body.args });
      if (offline) throw new Error('offline');
      if (status === 200) linked.push(String(body.args.sessionId));
      return new Response(
        JSON.stringify(
          status === 403 ? { error: { reason: 'repository_not_linked' } } : { error: 'unavailable' }
        ),
        { status }
      );
    },
  };
  const port = createCloudPrAssociationPort(options);
  return {
    port,
    restart: () => createCloudPrAssociationPort(options),
    requests,
    linked,
    errors,
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
      for (const delay of [60_000, 120_000, 240_000, 480_000, 900_000]) {
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
      logger: { error: () => {} },
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
  it.each([403, 500, 401, 0])(
    'stops after six failures (%s), shared across sessions and PRs',
    async (status) => {
      const f = fixture();
      if (status === 0) f.disconnect();
      else f.respond(status);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        expect(
          await f.port.associatePullRequest({
            ...input,
            ownerSessionId: `session-${attempt}` as SessionId,
            prNumber: attempt + 1,
          })
        ).toBe(false);
        f.advance(15 * 60_000);
      }
      expect(f.errors).toHaveLength(1);
      expect(f.errors[0]).toContain('stopped after 6 failed attempts');
      if (status === 403) {
        expect(f.errors[0]).toContain('repository_not_linked');
        expect(f.errors[0]).toContain('Settings > GitHub');
      }
      f.respond(200);
      f.advance(365 * 24 * 60 * 60_000);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        expect(await f.port.associatePullRequest({ ...input, repoFullName: ' OWNER/REPO ' })).toBe(
          false
        );
      }
      expect(f.requests).toHaveLength(6);
      expect(f.linked).toEqual([]);
      expect(f.errors).toHaveLength(1);
      expect(await f.port.associatePullRequest({ ...input, repoFullName: 'owner/healthy' })).toBe(
        true
      );
      expect(f.linked).toEqual(['session']);
    }
  );

  it('does not evict an exhausted repository to re-arm it when the tracking limit is reached', async () => {
    const f = fixture();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await f.port.associatePullRequest(input);
      f.advance(15 * 60_000);
    }
    for (let repo = 1; repo < 256; repo += 1) {
      await f.port.associatePullRequest({ ...input, repoFullName: `owner/repo-${repo}` });
    }
    const before = f.requests.length;
    expect(await f.port.associatePullRequest({ ...input, repoFullName: 'owner/overflow' })).toBe(
      false
    );
    f.respond(200);
    expect(await f.port.associatePullRequest(input)).toBe(false);
    expect(f.requests).toHaveLength(before);
    expect(f.errors).toHaveLength(2);
    // An existing, non-exhausted repository can still recover and free a slot.
    f.advance(15 * 60_000);
    expect(await f.port.associatePullRequest({ ...input, repoFullName: 'owner/repo-1' })).toBe(
      true
    );
    expect(await f.port.associatePullRequest({ ...input, repoFullName: 'owner/overflow' })).toBe(
      true
    );
    expect(f.linked).toEqual(['session', 'session']);
  });

  it('starts a fresh bounded budget when the runtime is recreated after configuration repair', async () => {
    const f = fixture();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await f.port.associatePullRequest(input);
      f.advance(15 * 60_000);
    }
    f.respond(200);
    expect(await f.port.associatePullRequest(input)).toBe(false);
    expect(await f.restart().associatePullRequest(input)).toBe(true);
    expect(f.linked).toEqual(['session']);
  });

  it('reserves bounded tracking space for concurrent repositories before starting network work', async () => {
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const requested: string[] = [];
    const port = createCloudPrAssociationPort({
      token: 'synthetic-token',
      authSiteUrl: 'https://synthetic.convex.site',
      logger: { error: () => {} },
      fetch: async (_url, init) => {
        requested.push(JSON.parse(String(init?.body)).args.repoFullName);
        await ready;
        return new Response(null, { status: 403 });
      },
    });
    const pending = Array.from({ length: 256 }, (_, index) =>
      port.associatePullRequest({ ...input, repoFullName: `owner/repo-${index}` })
    );
    expect(await port.associatePullRequest({ ...input, repoFullName: 'owner/overflow' })).toBe(
      false
    );
    expect(requested).toHaveLength(256);
    finish();
    expect(await Promise.all(pending)).toEqual(Array(256).fill(false));
    expect(await port.associatePullRequest({ ...input, repoFullName: 'owner/overflow' })).toBe(
      false
    );
    expect(requested).not.toContain('owner/overflow');
  });
});
