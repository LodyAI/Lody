import os from 'os';
import { z } from 'zod';
import { CommandOutputTooLarge, CommandTimedOut } from '@/platform/process/command';
import { runCommandText } from '@/platform/promise-facade';

const PROCESS_TABLE_TIMEOUT_MS = 2_000;
const MAX_PROCESS_TABLE_BYTES = 8 * 1024 * 1024;
/** Only the start of a failing probe's stderr goes into its error. */
const MAX_PROBE_STDERR_CHARS = 64 * 1024;

export type ProcessTableEntry = {
  pid: number;
  parentPid: number;
  processGroupId: number | null;
  startedAtMs: number;
  cpuTimeMicros: number;
  memoryBytes: number;
};

export type ProcessTableSnapshot = {
  sampledAtMs: number;
  memoryKind: 'rss-sum' | 'physical-footprint-sum' | 'working-set-sum';
  entries: ProcessTableEntry[];
  warnings: string[];
};

const WindowsProcessSchema = z.object({
  ProcessId: z.coerce.number().int().nonnegative(),
  ParentProcessId: z.coerce.number().int().nonnegative(),
  CreationDateMs: z.coerce.number().finite().nonnegative(),
  KernelModeTime: z.coerce.number().finite().nonnegative(),
  UserModeTime: z.coerce.number().finite().nonnegative(),
  WorkingSetSize: z.coerce.number().finite().nonnegative(),
});

const WindowsProcessListSchema = z.union([
  WindowsProcessSchema.transform((item) => [item]),
  z.array(WindowsProcessSchema),
]);

export async function readProcessTable(
  platform: NodeJS.Platform = process.platform
): Promise<ProcessTableSnapshot> {
  if (platform === 'win32') return await readWindowsProcessTable();
  if (platform === 'darwin') return await readDarwinProcessTable();
  return await readPosixProcessTable();
}

async function readPosixProcessTable(): Promise<ProcessTableSnapshot> {
  const sampledAtMs = Date.now();
  const stdout = await runProbe('ps', ['-A', '-o', 'pid=,ppid=,pgid=,rss=,time=,lstart='], {
    ...process.env,
    LC_ALL: 'C',
    LANG: 'C',
  });
  const entries: ProcessTableEntry[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 10) continue;
    const pid = parseNonNegativeInteger(parts[0]);
    const parentPid = parseNonNegativeInteger(parts[1]);
    const processGroupId = parseNonNegativeInteger(parts[2]);
    const rssKiB = parseNonNegativeInteger(parts[3]);
    const cpuTimeMicros = parseCpuTimeMicros(parts[4]);
    const startedAtMs = Date.parse(parts.slice(5).join(' '));
    if (
      pid === null ||
      parentPid === null ||
      processGroupId === null ||
      rssKiB === null ||
      cpuTimeMicros === null ||
      !Number.isFinite(startedAtMs)
    ) {
      continue;
    }
    entries.push({
      pid,
      parentPid,
      processGroupId,
      startedAtMs,
      cpuTimeMicros,
      memoryBytes: rssKiB * 1024,
    });
  }
  return { sampledAtMs, memoryKind: 'rss-sum', entries, warnings: [] };
}

async function readDarwinProcessTable(): Promise<ProcessTableSnapshot> {
  const snapshot = await readPosixProcessTable();
  try {
    const stdout = await runProbe(
      'top',
      [
        '-l',
        '1',
        '-s',
        '0',
        '-n',
        String(Math.max(1, snapshot.entries.length)),
        '-stats',
        'pid,mem',
      ],
      {
        ...process.env,
        LC_ALL: 'C',
        LANG: 'C',
      }
    );
    const footprintByPid = parseDarwinTopMemory(stdout);
    if (!footprintByPid.has(process.pid)) {
      throw new Error('top did not return the CLI process footprint');
    }
    return {
      ...snapshot,
      memoryKind: 'physical-footprint-sum',
      entries: snapshot.entries.map((entry) => ({
        ...entry,
        // A row missing from the later top snapshot most likely exited between probes.
        memoryBytes: footprintByPid.get(entry.pid) ?? 0,
      })),
    };
  } catch {
    return { ...snapshot, warnings: ['macos_footprint_unavailable'] };
  }
}

async function readWindowsProcessTable(): Promise<ProcessTableSnapshot> {
  const command = [
    "$ProgressPreference = 'SilentlyContinue'; Get-CimInstance -ClassName Win32_Process",
    'Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime,WorkingSetSize,@{Name="CreationDateMs";Expression={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}}',
    'ConvertTo-Json -Compress',
  ].join(' | ');
  const stdout = await runProbe(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    process.env
  );
  const sampledAtMs = Date.now();
  const parsedJson: unknown = JSON.parse(stdout.replace(/^\uFEFF/, '').trim() || '[]');
  const parsed = WindowsProcessListSchema.parse(parsedJson);
  return {
    sampledAtMs,
    memoryKind: 'working-set-sum',
    warnings: [],
    entries: parsed.map((item) => ({
      pid: item.ProcessId,
      parentPid: item.ParentProcessId,
      processGroupId: null,
      startedAtMs: item.CreationDateMs,
      cpuTimeMicros: (item.KernelModeTime + item.UserModeTime) / 10,
      memoryBytes: item.WorkingSetSize,
    })),
  };
}

export function parseDarwinTopMemory(stdout: string): Map<number, number> {
  const memoryByPid = new Map<number, number>();
  for (const rawLine of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+(?:\.\d+)?[BKMGT]?)\+?\s*$/i.exec(rawLine);
    if (!match) continue;
    const pid = parseNonNegativeInteger(match[1]);
    const memoryBytes = parseDarwinMemoryBytes(match[2]);
    if (pid === null || memoryBytes === null) continue;
    memoryByPid.set(pid, memoryBytes);
  }
  return memoryByPid;
}

function parseDarwinMemoryBytes(value: string | undefined): number | null {
  const match = /^(\d+(?:\.\d+)?)([BKMGT]?)$/i.exec(value ?? '');
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const unit = (match[2] ?? '').toUpperCase();
  const exponent = unit === '' || unit === 'B' ? 0 : ['K', 'M', 'G', 'T'].indexOf(unit) + 1;
  if (exponent < 1 && unit !== '' && unit !== 'B') return null;
  return Math.round(amount * 1024 ** exponent);
}

async function runProbe(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  let result: Awaited<ReturnType<typeof runCommandText>>;
  try {
    result = await runCommandText({
      command,
      args,
      env,
      timeout: PROCESS_TABLE_TIMEOUT_MS,
      maxOutputBytes: MAX_PROCESS_TABLE_BYTES,
      check: 'none',
    });
  } catch (error) {
    if (error instanceof CommandTimedOut) {
      throw new Error(`${command} process-table probe timed out`, { cause: error });
    }
    if (error instanceof CommandOutputTooLarge) {
      throw new Error(`${command} process-table probe exceeded output limit`, { cause: error });
    }
    throw error;
  }
  if (result.code !== 0) {
    const stderr = result.stderr.slice(0, MAX_PROBE_STDERR_CHARS).trim();
    throw new Error(`${command} process-table probe exited with ${result.code}: ${stderr}`);
  }
  return result.stdout;
}

function parseNonNegativeInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function parseCpuTimeMicros(value: string | undefined): number | null {
  if (!value) return null;
  const dayParts = value.split('-');
  if (dayParts.length > 2) return null;
  const days = dayParts.length === 2 ? Number(dayParts[0]) : 0;
  const clock = dayParts[dayParts.length - 1];
  if (!clock || !Number.isFinite(days)) return null;
  const fields = clock.split(':').map(Number);
  if (fields.some((field) => !Number.isFinite(field)) || fields.length < 2 || fields.length > 3) {
    return null;
  }
  const seconds = fields[fields.length - 1];
  const minutes = fields[fields.length - 2];
  const hours = fields.length === 3 ? fields[0] : 0;
  if (seconds === undefined || minutes === undefined || hours === undefined) return null;
  return Math.round((((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000_000);
}

export const logicalCpuCount = (): number => Math.max(1, os.cpus().length);
