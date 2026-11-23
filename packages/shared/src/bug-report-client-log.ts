/**
 * The renderer's bug-report log contract without a schema library, so the
 * pre-React boot and recovery pages can share it. The schema that validates it
 * lives in `bug-report.ts`.
 *
 * The raw bound matches what the client keeps (2 MiB or 48 hours); the
 * compressed bound matches the 1 MiB Code Collab / file-preview payload that
 * already crosses the Loro Streams request path.
 */
export const BUG_REPORT_CLIENT_LOG_LIMITS = {
  maxRawBytes: 2 * 1024 * 1024,
  maxCompressedBytes: 1024 * 1024,
} as const;

/** Base64 of the largest accepted gzip payload: bounds the string before it is decoded. */
export const BUG_REPORT_CLIENT_LOG_MAX_DATA_LENGTH =
  Math.ceil(BUG_REPORT_CLIENT_LOG_LIMITS.maxCompressedBytes / 3) * 4;

/** The client log as sent in `machine/bug-report`: UTF-8 text, gzipped, base64. */
export interface BugReportClientLog {
  encoding: 'gzip-base64';
  data: string;
  rawBytes: number;
  compressedBytes: number;
}
