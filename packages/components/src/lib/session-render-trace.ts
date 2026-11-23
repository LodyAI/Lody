/**
 * Session render trace: a tiny module-level ring buffer behind the crash
 * report.
 *
 * A React #185 (nested update limit) report names the fiber whose update
 * tripped the limit — the VICTIM — but not the loop that drove ~50 synchronous
 * commits there. The 0.89.x open-session crash is exactly that shape: the
 * stack ends in a chat surface's mount layout effect, while the driver
 * (whatever keeps remounting the surface or rewriting navigation) is invisible
 * in the report. Session surfaces therefore append one compact line per
 * render/mount/navigation event here, and the ErrorBoundary copy payload
 * carries the tail, so the next crash report shows WHAT oscillated instead of
 * only where the limit tripped.
 *
 * Consecutive identical lines collapse into a repeat count: a loop then reads
 * as alternating lines with ×N counts rather than flushing the buffer, and a
 * quiet session costs a few strings per user action.
 */

const MAX_TRACE_ENTRIES = 120;

type TraceEntry = {
  seq: number;
  atMs: number;
  line: string;
  repeats: number;
};

let nextSeq = 1;
let entries: TraceEntry[] = [];

export const recordSessionRenderTrace = (line: string): void => {
  const seq = nextSeq;
  nextSeq += 1;
  const last = entries[entries.length - 1];
  if (last && last.line === line) {
    last.repeats += 1;
    last.seq = seq;
    last.atMs = Date.now();
    return;
  }
  entries.push({ seq, atMs: Date.now(), line, repeats: 1 });
  if (entries.length > MAX_TRACE_ENTRIES) {
    entries = entries.slice(entries.length - MAX_TRACE_ENTRIES);
  }
};

/** Shorten a session/tab id for trace lines; full ids are in the report URL. */
export const shortTraceId = (id: string | null | undefined): string =>
  id ? id.slice(0, 8) : '∅';

export const getSessionRenderTraceText = (): string | undefined => {
  if (entries.length === 0) {
    return undefined;
  }
  const baseMs = entries[0]!.atMs;
  return entries
    .map(
      (entry) =>
        `#${entry.seq} +${entry.atMs - baseMs}ms ${entry.line}${
          entry.repeats > 1 ? ` ×${entry.repeats}` : ''
        }`
    )
    .join('\n');
};

export const clearSessionRenderTraceForTest = (): void => {
  entries = [];
  nextSeq = 1;
};
