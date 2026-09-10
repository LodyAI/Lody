import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ACP_ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/scripted-acp.mjs'
);

export const FIRST_SESSION_PROMPT = 'Create the first Session for unread-state navigation.';
export const SECOND_SESSION_PROMPT = 'Create the second Session for unread-state navigation.';
export const SESSION_RESPONSE_TEXT = 'Synthetic response started. Synthetic response complete.';

function quoteCommandArgument(value: string): string {
  if (/^[A-Za-z0-9_./:\\-]+$/u.test(value)) return value;
  return `"${value.replace(/["\\$`]/gu, '\\$&')}"`;
}

export class SessionReadStateFixture {
  readonly agentCommandLine: string;
  firstSessionId: string | null = null;
  secondSessionId: string | null = null;

  constructor(eventLogPath: string) {
    this.agentCommandLine = [process.execPath, ACP_ENTRY, eventLogPath]
      .map(quoteCommandArgument)
      .join(' ');
  }

  captureSessionId(url: string, position: 'first' | 'second'): string {
    const match = /#\/local\/sessions\/([^?]+)/u.exec(url);
    if (!match?.[1]) throw new Error(`Expected a Session route, received ${url}`);
    const sessionId = decodeURIComponent(match[1]);
    if (position === 'first') this.firstSessionId = sessionId;
    else this.secondSessionId = sessionId;
    return sessionId;
  }

  requireSessionIds(): { firstSessionId: string; secondSessionId: string } {
    if (!this.firstSessionId || !this.secondSessionId) {
      throw new Error('Both UI-created Session ids must be captured');
    }
    return { firstSessionId: this.firstSessionId, secondSessionId: this.secondSessionId };
  }
}
