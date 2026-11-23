import zlib from 'node:zlib';
import { z } from 'zod';
import {
  BUG_REPORT_CLIENT_LOG_LIMITS,
  type BugReportClientLog,
  type MachineBugReportResponse,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import { LODY_LOG_DIR } from '../utils/log-retention';
import { listDailyLogFiles, readDailyLogFile } from '../utils/log-files';
import type { MachineAccessCheckResult } from './workspace';

// Convex HTTP actions cap the request body at 20 MiB. A single day can span
// several 20 MB rotations, so this is the budget for each day as a whole and
// buys that day's most recent output.
const LOG_TAIL_MAX_BYTES = 4 * 1024 * 1024;
const TRUNCATION_MARKER = '...[truncated: only the tail of this log file is included]\n';

const BugReportCreateResponseSchema = z.object({
  bugReportId: z.string().min(1),
});

export const formatBugReportLogDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export const tailOfLog = (
  content: string,
  maxBytes: number
): { text: string; truncated: boolean } => {
  const buffer = Buffer.from(content, 'utf8');
  if (buffer.byteLength <= maxBytes) {
    return { text: content, truncated: false };
  }
  return { text: buffer.subarray(buffer.byteLength - maxBytes).toString('utf8'), truncated: true };
};

export type BugReportLogPart = {
  fileName: string;
  content: string;
  truncated: boolean;
};

export const mergeBugReportLogs = (parts: BugReportLogPart[]): string =>
  parts
    .map(
      (part) =>
        `===== ${part.fileName} =====\n${part.truncated ? TRUNCATION_MARKER : ''}${part.content}`
    )
    .join('\n\n');

/**
 * Read the machine's CLI logs for today and yesterday (winston DailyRotateFile
 * dates them in local time). A day is NOT one file: once it exceeds the
 * transport's `maxSize` it rolls to `<date>.log.1`, `<date>.log.2`, … and
 * gzips the file it rolled away from, so reading `<date>.log` alone finds
 * nothing on exactly the busy machines whose logs matter most.
 *
 * Each day is walked newest rotation first so its byte budget buys the most
 * recent output, then emitted oldest first. Missing days are skipped — a fresh
 * install may not have yesterday's log.
 */
export const collectBugReportLogs = async (
  now: Date = new Date(),
  logDir: string = LODY_LOG_DIR
): Promise<BugReportLogPart[]> => {
  const dates = [new Date(now.getTime() - 24 * 60 * 60 * 1000), now];
  const available = listDailyLogFiles(logDir);
  const parts: BugReportLogPart[] = [];
  for (const date of dates) {
    const day = formatBugReportLogDate(date);
    const dayParts: BugReportLogPart[] = [];
    let remaining = LOG_TAIL_MAX_BYTES;
    for (const file of available.filter((candidate) => candidate.date === day)) {
      if (remaining <= 0) break;
      let raw: string;
      try {
        raw = await readDailyLogFile(file);
      } catch {
        // Skip unreadable rotations.
        continue;
      }
      const { text, truncated } = tailOfLog(raw, remaining);
      remaining -= Buffer.byteLength(text, 'utf8');
      dayParts.push({ fileName: file.name, content: text, truncated });
    }
    parts.push(...dayParts.reverse());
  }
  return parts;
};

/** The section the reporter's client log occupies in the uploaded logs. */
export const BUG_REPORT_CLIENT_LOG_FILE_NAME = 'client.log';

/**
 * Turn the reporter's client log into one more log section. A log that does
 * not decode still becomes a section that says so, so a report never silently
 * drops it — and never fails the daemon logs because of it.
 */
export const decodeBugReportClientLog = (clientLog: BugReportClientLog): BugReportLogPart => {
  const failed = (reason: string): BugReportLogPart => ({
    fileName: BUG_REPORT_CLIENT_LOG_FILE_NAME,
    content: `[client log could not be decoded: ${reason}]\n`,
    truncated: false,
  });
  const compressed = Buffer.from(clientLog.data, 'base64');
  if (
    compressed.byteLength !== clientLog.compressedBytes ||
    compressed.byteLength > BUG_REPORT_CLIENT_LOG_LIMITS.maxCompressedBytes
  ) {
    return failed('compressed size mismatch');
  }
  let raw: Buffer;
  try {
    raw = zlib.gunzipSync(compressed, {
      maxOutputLength: BUG_REPORT_CLIENT_LOG_LIMITS.maxRawBytes,
    });
  } catch {
    return failed('not a gzip stream within the size limit');
  }
  if (raw.byteLength !== clientLog.rawBytes) {
    return failed('raw size mismatch');
  }
  try {
    return {
      fileName: BUG_REPORT_CLIENT_LOG_FILE_NAME,
      content: new TextDecoder('utf-8', { fatal: true }).decode(raw),
      truncated: false,
    };
  } catch {
    return failed('not UTF-8 text');
  }
};

export const submitBugReportFromMachine = async (args: {
  workspaceId: WorkspaceId;
  machineId: MachineId;
  description: string;
  reporterUserId: string;
  requestToken: string;
  /** The user this CLI is logged in as (machine operator). */
  machineUserId: string;
  /** The reporter's client log; appended after this machine's own logs. */
  clientLog?: BugReportClientLog;
  token: string;
  siteUrl: string;
  logger: { info: (message: string) => void; warn: (message: string) => void };
  checkMachineAccess: (input: {
    token: string;
    workspaceId: string;
    machineId: string;
    requesterUserId: string;
  }) => Promise<MachineAccessCheckResult>;
}): Promise<MachineBugReportResponse> => {
  const failure = (error: string): MachineBugReportResponse => ({
    type: 'machine/bug-report_response',
    machineId: args.machineId,
    success: false,
    error,
  });

  // Machine-access gate before touching any logs (same policy as Code Collab
  // ingress). The claimed reporter id is unauthenticated at the RPC layer, so
  // this only filters obviously unauthorized requests; the backend verifies
  // the signed requestToken before accepting the upload, which is what
  // actually prevents reporter spoofing.
  if (args.reporterUserId !== args.machineUserId) {
    try {
      const access = await args.checkMachineAccess({
        token: args.token,
        workspaceId: args.workspaceId,
        machineId: args.machineId,
        requesterUserId: args.reporterUserId,
      });
      if (!access.allowed) {
        args.logger.warn(
          `[bug-report] denied for requester ${args.reporterUserId}: ${access.reason}`
        );
        return failure('This user is not allowed to request logs from this machine.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      args.logger.warn(`[bug-report] machine access check failed: ${message}`);
      return failure('Could not verify machine access for this request.');
    }
  }

  try {
    const parts = await collectBugReportLogs();
    if (args.clientLog) parts.push(decodeBugReportClientLog(args.clientLog));
    const logContent = mergeBugReportLogs(parts);
    args.logger.info(
      `[bug-report] uploading ${parts.length} log file(s) (${logContent.length} chars) for workspace ${args.workspaceId}`
    );

    const response = await fetch(`${args.siteUrl}/api/bug-reports/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${args.token}`,
      },
      body: JSON.stringify({
        workspaceId: args.workspaceId,
        machineId: args.machineId,
        description: args.description,
        requestToken: args.requestToken,
        ...(logContent.length > 0 ? { logContent } : {}),
        ...(parts.length > 0 ? { logFileNames: parts.map((part) => part.fileName) } : {}),
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      args.logger.warn(
        `[bug-report] upload failed: status=${response.status} detail=${detail.slice(0, 500)}`
      );
      return failure(`Bug report upload failed with status ${response.status}.`);
    }

    const parsed = BugReportCreateResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return failure('Bug report upload returned an invalid response.');
    }

    args.logger.info(`[bug-report] created bug report ${parsed.data.bugReportId}`);
    return {
      type: 'machine/bug-report_response',
      machineId: args.machineId,
      success: true,
      bugReportId: parsed.data.bugReportId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    args.logger.warn(`[bug-report] upload failed: ${message}`);
    return failure(message);
  }
};
