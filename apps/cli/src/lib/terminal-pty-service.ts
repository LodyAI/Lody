import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { IPty } from '@lydell/node-pty';
import {
  type SessionId,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type TerminalOpenParams,
  type TerminalOpenResult,
  type TerminalServerEvent,
  type TerminalSnapshot,
  type TerminalTitleEvent,
  TERMINAL_MAX_PER_SESSION,
} from '@lody/shared';
import { getCachedLoginShellEnvSync } from '@/agent/login-shell-env';
import { mergeLoginShellEnv, withDefaultAcpPathEntries } from '@/agent/setting';
import { LODY_GIT_CRED_CONTEXT_TOKEN_ENV } from '@/lib/git-credential-broker';
import { clearManagedGhTokenEnv, LODY_MANAGED_GH_TOKEN_SHA256_ENV } from '@/lib/gh-token-env';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';

const SCROLLBACK_MAX_CHARS = 512 * 1024;
const TITLE_PARSE_BUFFER_MAX_CHARS = 4096;
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const OSC_TITLE_REGEX = new RegExp(`${ESC}\\](?:0|2);([^${BEL}${ESC}]*)(?:${BEL}|${ESC}\\\\)`, 'g');
const TERMINAL_ENV_BLOCKLIST = new Set([
  'ELECTRON_RUN_AS_NODE',
  'LODY_CLI_TOKEN',
  'LODY_ELECTRON_BOOTSTRAP',
  'LODY_ELECTRON_SESSION_TOKEN',
  'LODY_GIT_CRED_BROKER_STATE_FILE',
  'LODY_GIT_CRED_BROKER_TOKEN',
  'LODY_GIT_CRED_BROKER_URL',
  LODY_GIT_CRED_CONTEXT_TOKEN_ENV,
  LODY_MANAGED_GH_TOKEN_SHA256_ENV,
]);
const require = createRequire(import.meta.url);

// @lydell/node-pty ships its binding through per-platform optional dependencies and
// never compiles from source, so hosts it has no prebuild for (musl, armv7, …) resolve
// to nothing. Load it on the first open() rather than at import time so those hosts
// lose only the terminal feature instead of failing CLI startup: local-terminal-server
// turns a throw here into a `terminal_error` reply on that one open request.
let ptyModule: typeof import('@lydell/node-pty') | undefined;

function loadPty(): typeof import('@lydell/node-pty') {
  ptyModule ??= require('@lydell/node-pty') as typeof import('@lydell/node-pty');
  return ptyModule;
}

export type TerminalReplay = {
  title: string;
  scrollback: string;
};

export interface TerminalPtyServiceApi {
  list(sessionId: string): TerminalSnapshot[];
  open(params: TerminalOpenParams): Promise<TerminalOpenResult>;
  attach(terminalId: string, cols: number, rows: number): TerminalReplay;
  input(terminalId: string, data: string): void;
  resize(terminalId: string, cols: number, rows: number): void;
  close(terminalId: string): void;
  closeSession(sessionId: string): void;
  closeAll(): void;
  onEvent(handler: (event: TerminalServerEvent) => void): () => void;
}

export type TerminalPtyServiceOptions = {
  logger: Logger;
  resolveSessionWorkdir: (sessionId: SessionId) => Promise<string>;
};

type TerminalRecord = {
  sessionId: string;
  terminalId: string;
  cwd: string;
  title: string;
  pty: IPty;
  scrollback: string;
  titleParseBuffer: string;
};

function basenameForTitle(cwd: string): string {
  const name = path.basename(cwd);
  return name || cwd;
}

function resolveShellCommand(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      file: process.env.ComSpec || 'powershell.exe',
      args: [],
    };
  }

  return {
    file: process.env.SHELL || '/bin/sh',
    args: ['-l'],
  };
}

function buildTerminalEnv(sessionId: string): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: process.env.COLORTERM ?? 'truecolor',
    FORCE_COLOR: '1',
    LODY_SESSION_ID: sessionId,
    LODY_WORKSPACE_SESSION_ID: sessionId,
  };
  const merged = withDefaultAcpPathEntries(mergeLoginShellEnv(base, getCachedLoginShellEnvSync()));
  clearManagedGhTokenEnv(merged);
  for (const key of TERMINAL_ENV_BLOCKLIST) {
    delete merged[key];
  }
  return merged;
}

function normalizeExitSignal(signal: number | string | undefined): string | undefined {
  if (typeof signal === 'undefined') return undefined;
  return String(signal);
}

function appendScrollback(current: string, data: string): string {
  const next = current + data;
  if (next.length <= SCROLLBACK_MAX_CHARS) return next;
  return next.slice(next.length - SCROLLBACK_MAX_CHARS);
}

function extractLatestTitle(record: TerminalRecord, data: string): string | null {
  record.titleParseBuffer = (record.titleParseBuffer + data).slice(-TITLE_PARSE_BUFFER_MAX_CHARS);
  let latest: string | null = null;
  for (const match of record.titleParseBuffer.matchAll(OSC_TITLE_REGEX)) {
    const title = match[1]?.trim();
    if (title) {
      latest = title;
    }
  }
  return latest;
}

class TerminalPtyServiceImpl implements TerminalPtyServiceApi {
  private readonly logger: Logger;
  private readonly resolveSessionWorkdir: (sessionId: SessionId) => Promise<string>;
  private readonly records = new Map<string, TerminalRecord>();
  private readonly sessionIndex = new Map<string, Set<string>>();
  private readonly pendingSessionOpens = new Map<string, number>();
  private readonly handlers = new Set<(event: TerminalServerEvent) => void>();

  constructor(options: TerminalPtyServiceOptions) {
    this.logger = options.logger;
    this.resolveSessionWorkdir = options.resolveSessionWorkdir;
  }

  list(sessionId: string): TerminalSnapshot[] {
    const ids = this.sessionIndex.get(sessionId);
    if (!ids) return [];
    return [...ids].flatMap((terminalId) => {
      const record = this.records.get(terminalId);
      if (!record) return [];
      return [
        {
          terminalId: record.terminalId,
          title: record.title,
          cwd: record.cwd,
        },
      ];
    });
  }

  async open(params: TerminalOpenParams): Promise<TerminalOpenResult> {
    const sessionId = params.sessionId as SessionId;
    this.reserveSessionOpen(params.sessionId);
    try {
      const cwd = await this.resolveSessionWorkdir(sessionId);
      const terminalId = randomUUID();
      const shell = resolveShellCommand();
      const terminal = loadPty().spawn(shell.file, shell.args, {
        name: 'xterm-256color',
        cols: params.cols,
        rows: params.rows,
        cwd,
        env: buildTerminalEnv(params.sessionId),
      });

      const record: TerminalRecord = {
        sessionId: params.sessionId,
        terminalId,
        cwd,
        title: basenameForTitle(cwd),
        pty: terminal,
        scrollback: '',
        titleParseBuffer: '',
      };

      this.records.set(terminalId, record);
      const sessionTerminals = this.sessionIndex.get(params.sessionId) ?? new Set<string>();
      sessionTerminals.add(terminalId);
      this.sessionIndex.set(params.sessionId, sessionTerminals);

      terminal.onData((data) => {
        record.scrollback = appendScrollback(record.scrollback, data);
        this.emit({
          type: 'data',
          terminalId,
          data,
        } satisfies TerminalDataEvent);

        const title = extractLatestTitle(record, data);
        if (title && title !== record.title) {
          record.title = title;
          this.emit({
            type: 'title',
            terminalId,
            title,
          } satisfies TerminalTitleEvent);
        }
      });

      terminal.onExit(({ exitCode, signal }) => {
        this.removeRecord(terminalId);
        this.emit({
          type: 'exit',
          terminalId,
          exitCode,
          ...(typeof signal === 'undefined' ? {} : { signal: normalizeExitSignal(signal) }),
        } satisfies TerminalExitEvent);
      });

      this.emit({
        type: 'title',
        terminalId,
        title: record.title,
      } satisfies TerminalTitleEvent);
      this.logger.debug(
        `[terminal] opened terminalId=${terminalId} sessionId=${params.sessionId} cwd=${cwd}`
      );

      return { terminalId, cwd };
    } finally {
      this.releaseSessionOpen(params.sessionId);
    }
  }

  attach(terminalId: string, cols: number, rows: number): TerminalReplay {
    const record = this.requireRecord(terminalId);
    record.pty.resize(cols, rows);
    return {
      title: record.title,
      scrollback: record.scrollback,
    };
  }

  input(terminalId: string, data: string): void {
    this.requireRecord(terminalId).pty.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.requireRecord(terminalId).pty.resize(cols, rows);
  }

  close(terminalId: string): void {
    const record = this.requireRecord(terminalId);
    record.pty.kill();
  }

  closeSession(sessionId: string): void {
    const ids = [...(this.sessionIndex.get(sessionId) ?? [])];
    for (const terminalId of ids) {
      this.closeIfPresent(terminalId);
    }
  }

  closeAll(): void {
    const ids = [...this.records.keys()];
    for (const terminalId of ids) {
      this.closeIfPresent(terminalId);
    }
  }

  onEvent(handler: (event: TerminalServerEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private requireRecord(terminalId: string): TerminalRecord {
    const record = this.records.get(terminalId);
    if (!record) {
      throw new Error(`terminal_not_found:${terminalId}`);
    }
    return record;
  }

  private closeIfPresent(terminalId: string): void {
    const record = this.records.get(terminalId);
    if (!record) return;
    try {
      record.pty.kill();
    } catch (error) {
      this.logger.debug(
        `[terminal] failed to close terminalId=${terminalId}: ${formatErrorMessage(error)}`
      );
      this.removeRecord(terminalId);
    }
  }

  private removeRecord(terminalId: string): void {
    const record = this.records.get(terminalId);
    if (!record) return;
    this.records.delete(terminalId);
    const sessionTerminals = this.sessionIndex.get(record.sessionId);
    sessionTerminals?.delete(terminalId);
    if (sessionTerminals && sessionTerminals.size === 0) {
      this.sessionIndex.delete(record.sessionId);
    }
  }

  private reserveSessionOpen(sessionId: string): void {
    const currentCount =
      (this.sessionIndex.get(sessionId)?.size ?? 0) +
      (this.pendingSessionOpens.get(sessionId) ?? 0);
    if (currentCount >= TERMINAL_MAX_PER_SESSION) {
      throw new Error(`terminal_limit_exceeded:${sessionId}:${TERMINAL_MAX_PER_SESSION}`);
    }
    this.pendingSessionOpens.set(sessionId, (this.pendingSessionOpens.get(sessionId) ?? 0) + 1);
  }

  private releaseSessionOpen(sessionId: string): void {
    const current = this.pendingSessionOpens.get(sessionId) ?? 0;
    if (current <= 1) {
      this.pendingSessionOpens.delete(sessionId);
      return;
    }
    this.pendingSessionOpens.set(sessionId, current - 1);
  }

  private emit(event: TerminalServerEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}

export function makeTerminalPtyService(options: TerminalPtyServiceOptions): TerminalPtyServiceApi {
  return new TerminalPtyServiceImpl(options);
}
