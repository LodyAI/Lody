import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const ACP_ENTRY = resolve(fixtureDirectory, '../../../fixtures/scripted-acp.mjs');

export const TEXT_ATTACHMENT_NAME = 'synthetic-text-attachment.txt';
export const TEXT_ATTACHMENT_PATH = resolve(fixtureDirectory, TEXT_ATTACHMENT_NAME);
export const PRIMARY_SESSION_PROMPT =
  'Create the primary synthetic Session for a local text attachment lifecycle.';
export const ATTACHMENT_PROMPT =
  'Read the attached synthetic text attachment and retain it in this Session history.';
export const FOLLOW_UP_PROMPT =
  'This is a later plain-text follow-up with no attachment carried from the prior message.';
export const SECONDARY_SESSION_PROMPT =
  'Create a separate synthetic Session that must remain free of the primary attachment.';
export const SESSION_RESPONSE_TEXT = 'Synthetic response started. Synthetic response complete.';

function quoteCommandArgument(value: string): string {
  if (/^[A-Za-z0-9_./:\\-]+$/u.test(value)) return value;
  return `"${value.replace(/["\\$`]/gu, '\\$&')}"`;
}

export class TextAttachmentFixture {
  readonly agentCommandLine: string;
  primarySessionId: string | null = null;
  secondarySessionId: string | null = null;

  constructor(eventLogPath: string) {
    this.agentCommandLine = [process.execPath, ACP_ENTRY, eventLogPath]
      .map(quoteCommandArgument)
      .join(' ');
  }

  captureSessionId(url: string, kind: 'primary' | 'secondary'): string {
    const match = /#\/local\/sessions\/([^?]+)/u.exec(url);
    if (!match?.[1]) throw new Error(`Expected a Session route, received ${url}`);
    const sessionId = decodeURIComponent(match[1]);
    if (kind === 'primary') this.primarySessionId = sessionId;
    else this.secondarySessionId = sessionId;
    return sessionId;
  }

  requirePrimarySessionId(): string {
    if (!this.primarySessionId) throw new Error('The primary Session id has not been captured');
    return this.primarySessionId;
  }

  requireSecondarySessionId(): string {
    if (!this.secondarySessionId) throw new Error('The secondary Session id has not been captured');
    return this.secondarySessionId;
  }

  requireSessionIds(): { primarySessionId: string; secondarySessionId: string } {
    return {
      primarySessionId: this.requirePrimarySessionId(),
      secondarySessionId: this.requireSecondarySessionId(),
    };
  }
}
