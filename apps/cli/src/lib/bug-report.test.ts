import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineId, WorkspaceId } from '@lody/shared';
import {
  collectBugReportLogs,
  formatBugReportLogDate,
  mergeBugReportLogs,
  submitBugReportFromMachine,
  tailOfLog,
} from './bug-report';

describe('formatBugReportLogDate', () => {
  it('formats with zero padding', () => {
    expect(formatBugReportLogDate(new Date(2026, 5, 3))).toBe('2026-06-03');
    expect(formatBugReportLogDate(new Date(2026, 11, 25))).toBe('2026-12-25');
  });
});

describe('tailOfLog', () => {
  it('returns full content when under the limit', () => {
    expect(tailOfLog('hello', 10)).toEqual({ text: 'hello', truncated: false });
  });

  it('keeps only the tail when over the limit', () => {
    const result = tailOfLog('abcdefgh', 4);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('efgh');
  });
});

describe('mergeBugReportLogs', () => {
  it('joins log files with headers and truncation markers', () => {
    const merged = mergeBugReportLogs([
      { fileName: '2026-06-10.log', content: 'yesterday', truncated: false },
      { fileName: '2026-06-11.log', content: 'today', truncated: true },
    ]);
    expect(merged).toBe(
      '===== 2026-06-10.log =====\nyesterday\n\n===== 2026-06-11.log =====\n' +
        '...[truncated: only the tail of this log file is included]\ntoday'
    );
  });

  it('returns an empty string when there are no log files', () => {
    expect(mergeBugReportLogs([])).toBe('');
  });
});

describe('collectBugReportLogs', () => {
  const tempDirs: string[] = [];

  const createTempLogDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-bug-report-'));
    tempDirs.push(dir);
    return dir;
  };

  const writeLog = (dir: string, name: string, content: string): void => {
    fs.writeFileSync(path.join(dir, name), name.endsWith('.gz') ? zlib.gzipSync(content) : content);
  };

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const now = new Date(2026, 7, 7, 16, 54);

  it('collects a day that has rolled past `<date>.log`', async () => {
    const dir = createTempLogDir();
    // The regression: a busy machine has no `<date>.log` at all, so the report
    // shipped nothing for the day the user is reporting about.
    writeLog(dir, '2026-08-07.log.gz', 'today archived\n');
    writeLog(dir, '2026-08-07.log.1', 'today live\n');

    const parts = await collectBugReportLogs(now, dir);

    expect(parts.map((part) => part.fileName)).toEqual(['2026-08-07.log.gz', '2026-08-07.log.1']);
    expect(parts.map((part) => part.content)).toEqual(['today archived\n', 'today live\n']);
  });

  it('includes yesterday before today and skips days with no files', async () => {
    const dir = createTempLogDir();
    writeLog(dir, '2026-08-05.log', 'two days ago\n');
    writeLog(dir, '2026-08-06.log.gz', 'yesterday\n');
    writeLog(dir, '2026-08-07.log', 'today\n');

    const parts = await collectBugReportLogs(now, dir);

    expect(parts.map((part) => part.fileName)).toEqual(['2026-08-06.log.gz', '2026-08-07.log']);
  });

  it('spends the day budget on the newest rotations first', async () => {
    const dir = createTempLogDir();
    writeLog(dir, '2026-08-07.log.gz', 'x'.repeat(6 * 1024 * 1024));
    writeLog(dir, '2026-08-07.log.1', 'y'.repeat(3 * 1024 * 1024));

    const parts = await collectBugReportLogs(now, dir);
    const budget = 4 * 1024 * 1024;

    // The live rotation arrives whole; the archive only fills what is left, and
    // the day as a whole stays inside the budget the upload cap is derived from.
    expect(parts.map((part) => part.fileName)).toEqual(['2026-08-07.log.gz', '2026-08-07.log.1']);
    const live = parts[1];
    expect(live?.truncated).toBe(false);
    expect(live?.content.length).toBe(3 * 1024 * 1024);
    const archived = parts[0];
    expect(archived?.truncated).toBe(true);
    expect(archived?.content.length).toBe(budget - 3 * 1024 * 1024);
    expect(
      parts.reduce((total, part) => total + Buffer.byteLength(part.content, 'utf8'), 0)
    ).toBeLessThanOrEqual(budget);
  });

  it('returns nothing when the log directory is absent', async () => {
    await expect(
      collectBugReportLogs(now, path.join(createTempLogDir(), 'absent'))
    ).resolves.toEqual([]);
  });
});

describe('submitBugReportFromMachine machine-access gate', () => {
  const baseArgs = {
    workspaceId: 'ws_1' as WorkspaceId,
    machineId: 'machine_1' as MachineId,
    description: 'something broke',
    requestToken: 'token',
    machineUserId: 'owner_user',
    token: 'cli-token',
    siteUrl: 'https://auth.example.test',
    logger: { info: () => {}, warn: () => {} },
    checkMachineAccess: vi.fn().mockResolvedValue({ allowed: true }),
  };

  it('denies non-owner requesters that fail the machine-access check', async () => {
    const checkMachineAccess = vi.fn().mockResolvedValue({ allowed: false, reason: 'not_visible' });
    const response = await submitBugReportFromMachine({
      ...baseArgs,
      reporterUserId: 'other_user',
      checkMachineAccess,
    });
    expect(response.success).toBe(false);
    expect(response.error).toContain('not allowed');
    expect(checkMachineAccess).toHaveBeenCalledWith({
      token: 'cli-token',
      workspaceId: 'ws_1',
      machineId: 'machine_1',
      requesterUserId: 'other_user',
    });
  });

  it('fails closed when the machine-access check errors', async () => {
    const checkMachineAccess = vi.fn().mockRejectedValue(new Error('convex unreachable'));
    const response = await submitBugReportFromMachine({
      ...baseArgs,
      reporterUserId: 'other_user',
      checkMachineAccess,
    });
    expect(response.success).toBe(false);
    expect(response.error).toContain('Could not verify machine access');
  });

  it('skips the remote check for the machine operator', async () => {
    const checkMachineAccess = vi.fn();
    // The stubbed upload fails; what matters is that the gate lets the owner
    // through without consulting the access oracle.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'nope',
      })
    );
    try {
      const response = await submitBugReportFromMachine({
        ...baseArgs,
        reporterUserId: 'owner_user',
        checkMachineAccess,
      });
      expect(checkMachineAccess).not.toHaveBeenCalled();
      expect(response.success).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
