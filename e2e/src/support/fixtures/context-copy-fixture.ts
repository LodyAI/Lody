import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const SCRIPTED_ACP_ENTRY = resolve(fixtureDirectory, 'context-copy-scripted-acp.mjs');

export const FIRST_PROMPT_MARKER = 'CONTEXT-PRIMARY-USER-RICH';
export const FIRST_PROMPT = `${FIRST_PROMPT_MARKER}\n\n## Preserve this heading\n\n\`\`\`ts\nconst retainedUserCode = 'primary-user';\n\`\`\``;
export const FIRST_RESPONSE_MARKER = 'CONTEXT-PRIMARY-ASSISTANT-RICH';
export const FIRST_RESPONSE = `${FIRST_RESPONSE_MARKER}\n\n### Preserve this answer\n\n\`\`\`ts\nexport const retainedAssistantCode = 'primary-assistant';\n\`\`\``;
export const RICH_USER_CODE = "const retainedUserCode = 'primary-user';";
export const RICH_ASSISTANT_CODE = "export const retainedAssistantCode = 'primary-assistant';";
export const SECOND_PROMPT = 'CONTEXT-PRIMARY-LATER-USER: this must not be in the first prefix.';
export const SECOND_RESPONSE =
  'CONTEXT-PRIMARY-LATER-ASSISTANT: this must not be in the first prefix.';
export const PRIMARY_STREAM_PROMPT = 'CONTEXT-PRIMARY-STREAM: hold after the visible prefix.';
export const PRIMARY_STREAM_PREFIX = 'CONTEXT-PRIMARY-STREAM-PREFIX: visible while generating.';
export const PRIMARY_STREAM_TAIL =
  'CONTEXT-PRIMARY-STREAM-TAIL: available only after explicit release.';
export const ISOLATED_STREAM_PROMPT = 'CONTEXT-ISOLATED-CANCEL: do not share the primary history.';
export const ISOLATED_STREAM_PREFIX = 'CONTEXT-ISOLATED-PREFIX: visible before cancellation.';
export const INCOMPLETE_RESPONSE_MARKER = 'The last response was still generating when copied.';

export type ContextCopyPromptMode =
  | 'first'
  | 'second'
  | 'primary-stream'
  | 'isolated-stream'
  | 'title'
  | 'unknown';

export type ContextCopyAcpEvent = {
  at: string;
  event:
    | 'prompt-start'
    | 'prompt-end'
    | 'session-new'
    | 'session-close'
    | 'session-cancel'
    | 'stream-ready';
  mode?: ContextCopyPromptMode;
  promptText?: string;
  sessionId?: string;
  stopReason?: 'end_turn' | 'cancelled';
};

function quoteCommandArgument(value: string): string {
  if (/^[A-Za-z0-9_./:\\-]+$/u.test(value)) return value;
  return `"${value.replace(/["\\$`]/gu, '\\$&')}"`;
}

export class ContextCopyFixture {
  readonly agentCommandLine: string;
  private readonly sessionIds: Partial<Record<'primary' | 'isolated', string>> = {};

  constructor(
    readonly eventLogPath: string,
    readonly releasePrimaryStreamSignalPath: string
  ) {
    writeFileSync(eventLogPath, '', 'utf8');
    rmSync(releasePrimaryStreamSignalPath, { force: true });
    this.agentCommandLine = [
      process.execPath,
      SCRIPTED_ACP_ENTRY,
      eventLogPath,
      releasePrimaryStreamSignalPath,
    ]
      .map(quoteCommandArgument)
      .join(' ');
  }

  captureSessionId(url: string, kind: 'primary' | 'isolated'): string {
    const match = /#\/local\/sessions\/([^?]+)/u.exec(url);
    if (!match?.[1]) throw new Error(`Expected a Session route, received ${url}`);
    const sessionId = decodeURIComponent(match[1]);
    this.sessionIds[kind] = sessionId;
    return sessionId;
  }

  requireSessionId(kind: 'primary' | 'isolated'): string {
    const sessionId = this.sessionIds[kind];
    if (!sessionId) throw new Error(`The ${kind} context copy Session id has not been captured`);
    return sessionId;
  }

  releasePrimaryStream(): void {
    writeFileSync(this.releasePrimaryStreamSignalPath, 'release\n', { flag: 'wx' });
  }

  async waitForEvent(
    event: ContextCopyAcpEvent['event'],
    mode: ContextCopyPromptMode
  ): Promise<ContextCopyAcpEvent> {
    let match: ContextCopyAcpEvent | undefined;
    await expect
      .poll(
        () => {
          match = this.readEvents().find((entry) => entry.event === event && entry.mode === mode);
          return match !== undefined;
        },
        { timeout: 30_000, intervals: [50, 100, 250, 500] }
      )
      .toBe(true);
    return match!;
  }

  async expectPrimaryStreamReleased(): Promise<void> {
    const completed = await this.waitForEvent('prompt-end', 'primary-stream');
    expect(completed.stopReason).toBe('end_turn');
    expect(existsSync(this.releasePrimaryStreamSignalPath)).toBe(true);
  }

  readEvents(): ContextCopyAcpEvent[] {
    try {
      return readFileSync(this.eventLogPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as ContextCopyAcpEvent];
          } catch {
            return [];
          }
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}
