import {
  buildSessionImageApiUrl,
  getSessionImageDownloadApiPath,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import type { ContentBlock } from '@agentclientprotocol/sdk';

import { formatErrorMessage } from '@/utils/format-error';

type SessionImageDownloadLogger = {
  debug: (message: string) => void;
};

type DownloadSessionImageAsPromptBlockArgs = {
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  imageId: string;
  expectedMimeType: string;
  serverBaseUrl: string;
  token: string;
  logger?: SessionImageDownloadLogger;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
};

export type DownloadedSessionImagePromptBlock = {
  block: Extract<ContentBlock, { type: 'image' }>;
  bytes: Buffer;
  mimeType: string;
  sizeBytes: number;
};

export const SESSION_IMAGE_DOWNLOAD_RETRY_DELAYS_MS = [250, 750, 1500] as const;

const SESSION_IMAGE_DOWNLOAD_MAX_RETRY_AFTER_MS = 3_000;
const RETRYABLE_SESSION_IMAGE_DOWNLOAD_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const defaultSleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

class SessionImageDownloadHttpError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'SessionImageDownloadHttpError';
  }
}

const clampRetryDelayMs = (delayMs: number): number => {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    return 0;
  }
  return Math.min(Math.round(delayMs), SESSION_IMAGE_DOWNLOAD_MAX_RETRY_AFTER_MS);
};

const parseRetryAfterMs = (retryAfter: string | null): number | undefined => {
  if (!retryAfter) {
    return undefined;
  }

  const seconds = Number(retryAfter.trim());
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return clampRetryDelayMs(seconds * 1000);
};

const getRetryDelayMs = (attemptIndex: number, retryAfter?: string | null): number => {
  return (
    parseRetryAfterMs(retryAfter ?? null) ??
    SESSION_IMAGE_DOWNLOAD_RETRY_DELAYS_MS[attemptIndex] ??
    SESSION_IMAGE_DOWNLOAD_RETRY_DELAYS_MS[SESSION_IMAGE_DOWNLOAD_RETRY_DELAYS_MS.length - 1] ??
    1500
  );
};

const isRetryableSessionImageDownloadStatus = (status: number): boolean => {
  return RETRYABLE_SESSION_IMAGE_DOWNLOAD_STATUSES.has(status);
};

const formatErrorMessageWithCause = (
  error: unknown,
  seen: WeakSet<object> = new WeakSet()
): string => {
  const message = formatErrorMessage(error);
  if (!error || typeof error !== 'object' || seen.has(error)) {
    return message;
  }
  seen.add(error);

  const cause = (error as { cause?: unknown }).cause;
  if (cause === undefined || cause === null) {
    return message;
  }

  const causeMessage = formatErrorMessageWithCause(cause, seen);
  if (!causeMessage || message.includes(causeMessage)) {
    return message;
  }
  return `${message}: ${causeMessage}`;
};

const discardResponseBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort: this only avoids keeping an unread retry response body around.
  }
};

const readResponseErrorDetail = async (response: Response): Promise<string> => {
  const errorBody = await response.text().catch(() => '');
  return errorBody ? `: ${errorBody.slice(0, 200)}` : '';
};

export async function downloadSessionImageForPrompt(
  args: DownloadSessionImageAsPromptBlockArgs
): Promise<DownloadedSessionImagePromptBlock> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Session image download requires fetch');
  }

  const sleep = args.sleep ?? defaultSleep;
  const imageUrl = buildSessionImageApiUrl(
    args.serverBaseUrl,
    getSessionImageDownloadApiPath(args.workspaceId, args.sessionId, args.imageId)
  );
  const maxAttempts = SESSION_IMAGE_DOWNLOAD_RETRY_DELAYS_MS.length + 1;

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex++) {
    args.signal?.throwIfAborted();
    const attemptNumber = attemptIndex + 1;
    try {
      const response = await fetchImpl(imageUrl, {
        method: 'GET',
        signal: args.signal,
        headers: {
          Authorization: `Bearer ${args.token}`,
        },
      });

      if (!response.ok) {
        const canRetry =
          attemptNumber < maxAttempts && isRetryableSessionImageDownloadStatus(response.status);
        if (canRetry) {
          const delayMs = getRetryDelayMs(attemptIndex, response.headers.get('Retry-After'));
          args.logger?.debug(
            `[${args.sessionId}] Session image download returned ${response.status}; retrying in ${delayMs}ms (imageId=${args.imageId} attempt=${attemptNumber}/${maxAttempts})`
          );
          await discardResponseBody(response);
          await sleep(delayMs);
          continue;
        }

        const detail = await readResponseErrorDetail(response);
        throw new SessionImageDownloadHttpError(
          `Failed to download image ${args.imageId} (${response.status})${detail}`,
          isRetryableSessionImageDownloadStatus(response.status)
        );
      }

      const mimeTypeHeader = response.headers.get('Content-Type');
      const mimeType = mimeTypeHeader?.split(';')[0]?.trim().toLowerCase() || args.expectedMimeType;
      const imageBytes = await response.arrayBuffer();
      const bytes = Buffer.from(imageBytes);
      return {
        block: {
          type: 'image',
          mimeType,
          data: bytes.toString('base64'),
        },
        bytes,
        mimeType,
        sizeBytes: bytes.byteLength,
      };
    } catch (error) {
      args.signal?.throwIfAborted();
      if (error instanceof SessionImageDownloadHttpError && !error.retryable) {
        throw error;
      }

      const isFinalAttempt = attemptNumber >= maxAttempts;
      if (isFinalAttempt) {
        throw new Error(
          `Failed to download image ${args.imageId} after ${attemptNumber} attempts: ${formatErrorMessageWithCause(error)}`,
          { cause: error }
        );
      }

      const delayMs = getRetryDelayMs(attemptIndex);
      args.logger?.debug(
        `[${args.sessionId}] Session image download failed; retrying in ${delayMs}ms (imageId=${args.imageId} attempt=${attemptNumber}/${maxAttempts}): ${formatErrorMessageWithCause(error)}`
      );
      await sleep(delayMs);
    }
  }

  throw new Error(`Failed to download image ${args.imageId}`);
}

export async function downloadSessionImageAsPromptBlock(
  args: DownloadSessionImageAsPromptBlockArgs
): Promise<ContentBlock> {
  return (await downloadSessionImageForPrompt(args)).block;
}
