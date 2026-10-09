import type { CloudPrAssociationPort } from '@lody/platform';
import { getServerNow } from '@lody/shared';

const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 15 * 60_000;
const MAX_FAILURES = 256;

/** One port per authenticated cloud runtime; never cache successful authorization. */
export function createCloudPrAssociationPort(options: {
  token: string;
  authSiteUrl: string;
  fetch?: typeof fetch;
  nowMs?: () => number;
}): CloudPrAssociationPort {
  const request = options.fetch ?? fetch;
  const nowMs = options.nowMs ?? getServerNow;
  const failures = new Map<string, { delayMs: number; retryAtMs: number }>();
  const pending = new Set<string>();

  return {
    async associatePullRequest(input) {
      // Both turn finalization and the poller share this repository gate. Other
      // sessions must not inherit a successful association from an in-flight call.
      const key = JSON.stringify([input.workspaceId, input.repoFullName.toLowerCase()]);
      const previous = failures.get(key);
      if (pending.has(key) || (previous && nowMs() < previous.retryAtMs)) return false;
      pending.add(key);
      let status = 0;
      try {
        const { ownerSessionId, ...association } = input;
        const response = await request(new URL('/api/action', options.authSiteUrl), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: 'github:associatePullRequestForCli',
            args: { ...association, sessionId: ownerSessionId, cliToken: options.token },
          }),
          signal: AbortSignal.timeout(10_000),
        });
        status = response.status;
        if (response.ok) {
          failures.delete(key);
          return true;
        }
      } catch {
        // Transport failures (including timeout) use the same bounded retry path.
      } finally {
        pending.delete(key);
      }

      // Older servers report this rejection as 500: they still back off. New
      // servers' 401/403 responses take the full cooldown immediately.
      const delayMs =
        status === 401 || status === 403
          ? RETRY_MAX_MS
          : Math.min(RETRY_MAX_MS, previous ? previous.delayMs * 2 : RETRY_BASE_MS);
      failures.delete(key);
      failures.set(key, { delayMs, retryAtMs: nowMs() + delayMs });
      if (failures.size > MAX_FAILURES) {
        const oldest = failures.keys().next().value;
        if (oldest !== undefined) failures.delete(oldest);
      }
      return false;
    },
  };
}
