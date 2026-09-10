import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ACP_ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/scripted-acp.mjs'
);

export const SESSION_MANAGEMENT_PROMPT =
  'Create a completed local Session for metadata and Archive management.';
export const CREATED_SESSION_TITLE = 'Synthetic session title';
export const RENAMED_SESSION_TITLE = 'Renamed local session';
export const SESSION_HISTORY_TEXT = 'Synthetic response started. Synthetic response complete.';

function quoteCommandArgument(value: string): string {
  if (/^[A-Za-z0-9_./:\\-]+$/u.test(value)) return value;
  return `"${value.replace(/["\\$`]/gu, '\\$&')}"`;
}

export class SessionManagementFixture {
  readonly agentCommandLine: string;
  sessionId: string | null = null;

  constructor(readonly eventLogPath: string) {
    this.agentCommandLine = [process.execPath, ACP_ENTRY, eventLogPath]
      .map(quoteCommandArgument)
      .join(' ');
  }

  captureSessionId(url: string): string {
    const match = /#\/local\/sessions\/([^?]+)/u.exec(url);
    if (!match?.[1]) throw new Error(`Expected a Session route, received ${url}`);
    this.sessionId = decodeURIComponent(match[1]);
    return this.sessionId;
  }

  requireSessionId(): string {
    if (!this.sessionId) throw new Error('The UI-created Session id has not been captured');
    return this.sessionId;
  }
}
