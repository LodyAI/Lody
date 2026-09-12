import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ACP_ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/scripted-acp.mjs'
);

export const TARGET_SESSION_PROMPT =
  'Prepare the release checklist that must be found through Sidebar Search.';
export const SIMILAR_SESSION_PROMPT =
  'Plan the release calendar that should remain visible beside the target Session.';
export const UNRELATED_SESSION_PROMPT =
  'Record unrelated discovery notes that must not match release searches.';
export const TARGET_INITIAL_TITLE = 'Release Checklist Draft';
export const TARGET_RENAMED_TITLE = 'Release Checklist Final';
export const SIMILAR_SESSION_TITLE = 'Release Calendar';
export const UNRELATED_SESSION_TITLE = 'Discovery Notes';
export const SESSION_RESPONSE_TEXT = 'Synthetic response started. Synthetic response complete.';
export const RELEASE_SEARCH_QUERY = 'RELE';
export const TARGET_INITIAL_SEARCH_QUERY = 'DRAFT';
export const TARGET_RENAMED_SEARCH_QUERY = 'FINAL';
export const NO_MATCH_SEARCH_QUERY = 'XQZJ';

function quoteCommandArgument(value: string): string {
  if (/^[A-Za-z0-9_./:\\-]+$/u.test(value)) return value;
  return `"${value.replace(/["\\$`]/gu, '\\$&')}"`;
}

export class SidebarSearchFixture {
  readonly agentCommandLine: string;
  targetSessionId: string | null = null;
  similarSessionId: string | null = null;
  unrelatedSessionId: string | null = null;

  constructor(eventLogPath: string) {
    this.agentCommandLine = [process.execPath, ACP_ENTRY, eventLogPath]
      .map(quoteCommandArgument)
      .join(' ');
  }

  captureSessionId(url: string, kind: 'target' | 'similar' | 'unrelated'): string {
    const match = /#\/local\/sessions\/([^?]+)/u.exec(url);
    if (!match?.[1]) throw new Error(`Expected a Session route, received ${url}`);
    const sessionId = decodeURIComponent(match[1]);
    if (kind === 'target') this.targetSessionId = sessionId;
    else if (kind === 'similar') this.similarSessionId = sessionId;
    else this.unrelatedSessionId = sessionId;
    return sessionId;
  }

  requireSessionIds(): {
    targetSessionId: string;
    similarSessionId: string;
    unrelatedSessionId: string;
  } {
    if (!this.targetSessionId || !this.similarSessionId || !this.unrelatedSessionId) {
      throw new Error('All UI-created sidebar-search Session ids must be captured');
    }
    return {
      targetSessionId: this.targetSessionId,
      similarSessionId: this.similarSessionId,
      unrelatedSessionId: this.unrelatedSessionId,
    };
  }
}
