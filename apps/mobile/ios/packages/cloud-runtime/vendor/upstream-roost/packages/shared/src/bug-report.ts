import { z } from 'zod';
import {
  BUG_REPORT_CLIENT_LOG_LIMITS,
  BUG_REPORT_CLIENT_LOG_MAX_DATA_LENGTH,
  type BugReportClientLog,
} from './bug-report-client-log';

export const BUG_REPORT_LOG_PATH_PREFIX = '/bug-report-logs/workspaces/';

export const buildBugReportLogObjectKey = (workspaceId: string, logId: string): string =>
  `bug-reports/${workspaceId}/${logId}.log`;

export const buildBugReportLogPath = (workspaceId: string, logId: string): string =>
  `${BUG_REPORT_LOG_PATH_PREFIX}${encodeURIComponent(workspaceId)}/${encodeURIComponent(logId)}`;

export const parseBugReportLogPath = (
  pathname: string
): { workspaceId: string; logId: string } | null => {
  if (!pathname.startsWith(BUG_REPORT_LOG_PATH_PREFIX)) {
    return null;
  }
  const rest = pathname.slice(BUG_REPORT_LOG_PATH_PREFIX.length);
  const segments = rest.split('/').filter(Boolean);
  if (segments.length !== 2) {
    return null;
  }
  try {
    const workspaceId = decodeURIComponent(segments[0] ?? '');
    const logId = decodeURIComponent(segments[1] ?? '');
    if (!workspaceId || !logId) {
      return null;
    }
    return { workspaceId, logId };
  } catch {
    return null;
  }
};

export {
  BUG_REPORT_CLIENT_LOG_LIMITS,
  BUG_REPORT_CLIENT_LOG_MAX_DATA_LENGTH,
  type BugReportClientLog,
} from './bug-report-client-log';

/** Validates {@link BugReportClientLog}; `data` is bounded before any decode. */
export const BugReportClientLogSchema = z
  .object({
    encoding: z.literal('gzip-base64'),
    data: z.string().min(1).max(BUG_REPORT_CLIENT_LOG_MAX_DATA_LENGTH),
    rawBytes: z.number().int().positive().max(BUG_REPORT_CLIENT_LOG_LIMITS.maxRawBytes),
    compressedBytes: z
      .number()
      .int()
      .positive()
      .max(BUG_REPORT_CLIENT_LOG_LIMITS.maxCompressedBytes),
  })
  .strict() satisfies z.ZodType<BugReportClientLog>;
