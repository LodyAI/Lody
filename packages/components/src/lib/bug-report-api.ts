import { z } from 'zod';
import { requireCloudAuthBaseUrl } from './cloud-http-port';

const BugReportCreateResponseSchema = z.object({
  bugReportId: z.string().min(1),
});

const BugReportRequestTokenResponseSchema = z.object({
  requestToken: z.string().min(1),
});

export type MintBugReportRequestTokenResult =
  | { ok: true; requestToken: string }
  | { ok: false; error: string };

/**
 * Mint the signed requester proof that must accompany a machine-backed bug
 * report. The backend derives the reporter identity from this token, so the
 * machine never has to trust a caller-supplied user id.
 */
export async function mintBugReportRequestToken({
  workspaceId,
  machineId,
  sessionToken,
  authBaseUrl,
}: {
  workspaceId: string;
  machineId: string;
  sessionToken: string;
  authBaseUrl?: string;
}): Promise<MintBugReportRequestTokenResult> {
  authBaseUrl = requireCloudAuthBaseUrl('bugReport', authBaseUrl);
  const trimmedToken = sessionToken.trim();
  if (!trimmedToken) {
    return { ok: false, error: 'not_authenticated' };
  }
  if (!authBaseUrl) {
    return { ok: false, error: 'missing_auth_site_url' };
  }

  try {
    const response = await fetch(
      `${authBaseUrl.replace(/\/+$/, '')}/api/bug-reports/request-token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${trimmedToken}`,
        },
        body: JSON.stringify({ workspaceId, machineId }),
      }
    );
    if (!response.ok) {
      return { ok: false, error: `Bug report request failed with status ${response.status}.` };
    }
    const parsed = BugReportRequestTokenResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return { ok: false, error: 'Bug report request returned an invalid response.' };
    }
    return { ok: true, requestToken: parsed.data.requestToken };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export type SubmitWebBugReportResult =
  | { ok: true; bugReportId: string }
  | { ok: false; error: string };

/**
 * Report filed directly from the app without machine logs. Client diagnostics
 * are attached separately after the report ID is returned. Machine-backed reports
 * go through machine RPC so the CLI can bundle its local logs.
 */
export async function submitWebBugReport({
  workspaceId,
  description,
  sessionToken,
  authBaseUrl,
}: {
  workspaceId: string;
  description: string;
  sessionToken: string;
  authBaseUrl?: string;
}): Promise<SubmitWebBugReportResult> {
  authBaseUrl = requireCloudAuthBaseUrl('bugReport', authBaseUrl);
  const trimmedToken = sessionToken.trim();
  if (!trimmedToken) {
    return { ok: false, error: 'not_authenticated' };
  }
  if (!authBaseUrl) {
    return { ok: false, error: 'missing_auth_site_url' };
  }

  try {
    const response = await fetch(`${authBaseUrl.replace(/\/+$/, '')}/api/bug-reports/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${trimmedToken}`,
      },
      body: JSON.stringify({ workspaceId, description }),
    });
    if (!response.ok) {
      return { ok: false, error: `Bug report upload failed with status ${response.status}.` };
    }
    const parsed = BugReportCreateResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return { ok: false, error: 'Bug report upload returned an invalid response.' };
    }
    return { ok: true, bugReportId: parsed.data.bugReportId };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export const CLIENT_DIAGNOSTICS_UPLOAD_TIMEOUT_MS = 15_000;

/** Session-authenticated, bounded attachment; independent of the selected daemon's version. */
export async function attachClientDiagnostics({
  workspaceId,
  bugReportId,
  diagnostics,
  sessionToken,
  authBaseUrl,
  signal,
}: {
  workspaceId: string;
  bugReportId: string;
  diagnostics: string;
  sessionToken: string;
  authBaseUrl?: string;
  signal?: AbortSignal;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  authBaseUrl = requireCloudAuthBaseUrl('bugReport', authBaseUrl);
  if (!sessionToken.trim()) return { ok: false, error: 'not_authenticated' };
  if (signal?.aborted) return { ok: false, error: 'Client diagnostics upload cancelled.' };
  const controller = new AbortController();
  let cancel = () => {};
  let timeout: ReturnType<typeof setTimeout> | undefined;
  // Bound headers AND response-body reads, even when an adapter ignores abort.
  const interrupted = new Promise<{ ok: false; error: string }>((resolve) => {
    cancel = () => {
      controller.abort();
      resolve({ ok: false, error: 'Client diagnostics upload cancelled.' });
    };
    signal?.addEventListener('abort', cancel, { once: true });
    timeout = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, error: 'Client diagnostics upload timed out.' });
    }, CLIENT_DIAGNOSTICS_UPLOAD_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      interrupted,
      (async () => {
        const response = await fetch(
          `${authBaseUrl.replace(/\/+$/, '')}/api/bug-reports/client-diagnostics`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${sessionToken.trim()}`,
            },
            body: JSON.stringify({ workspaceId, bugReportId, diagnostics }),
            signal: controller.signal,
          }
        );
        if (!response.ok)
          return {
            ok: false as const,
            error: `Client diagnostics upload failed with status ${response.status}.`,
          };
        const data = z.object({ attached: z.literal(true) }).safeParse(await response.json());
        return data.success
          ? { ok: true as const }
          : { ok: false as const, error: 'Invalid client diagnostics response.' };
      })(),
    ]);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
