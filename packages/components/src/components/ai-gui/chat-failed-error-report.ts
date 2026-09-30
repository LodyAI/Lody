/**
 * Pure helpers for the `chat_failed` system notice detail surface.
 *
 * The inline notice only has room for a one-line title, so the raw agent error
 * is shown in a modal (see `chat-failed-detail-dialog.tsx`) and can be copied
 * verbatim — on mobile there is no hover surface to fall back to.
 */

/**
 * Try to extract a human-readable message from raw ACP error strings.
 * ACP errors often embed JSON like: 'Internal error: API Error: 500 {"error":{"message":"..."}}'
 */
export function extractReadableChatFailedMessage(raw: string): string {
  // Try to find and parse embedded JSON to extract the message field.
  // This handles escaped quotes inside the message value (e.g. "Missing required parameter \"messages\"").
  const jsonStart = raw.indexOf('{');
  if (jsonStart !== -1) {
    try {
      const parsed: unknown = JSON.parse(raw.slice(jsonStart));
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        // Handle nested {"error":{"message":"..."}} or flat {"message":"..."}
        const inner =
          obj.error && typeof obj.error === 'object' ? (obj.error as Record<string, unknown>) : obj;
        if (typeof inner.message === 'string' && inner.message.length > 0) {
          return inner.message;
        }
      }
    } catch {
      // JSON parse failed — fall through to prefix stripping
    }
  }
  // Strip common prefixes like "Internal error: API Error: 500 "
  const prefixStripped = raw.replace(/^(?:Internal error:\s*)?(?:API Error:\s*\d+\s*)?/, '');
  return prefixStripped || raw;
}

export type ChatFailedErrorReportInput = {
  /** Localized title shown in the notice. */
  title: string;
  /** Localized remediation copy, when the diagnostic code has one. */
  action?: string;
  reason?: string;
  code?: string;
  /** Raw agent/ACP error text, copied verbatim. */
  message?: string;
  sessionId?: string;
  agentType?: string;
  machineId?: string;
};

const trimmed = (value: string | undefined): string | undefined => {
  const next = value?.trim();
  return next ? next : undefined;
};

/**
 * Builds the clipboard payload for an agent error: identifying fields first,
 * then the raw message. Kept plain text so it pastes into an issue, a chat, or
 * a terminal without mangling.
 */
export function buildChatFailedErrorReport(input: ChatFailedErrorReportInput): string {
  const fields: Array<[string, string | undefined]> = [
    // A single-word `Error:` prefix can be interpreted as a custom URL scheme
    // by clipboard consumers. Keep the report unambiguously plain text.
    ['Error details', trimmed(input.title)],
    ['Reason', trimmed(input.reason)],
    ['Code', trimmed(input.code)],
    ['Session', trimmed(input.sessionId)],
    ['Agent', trimmed(input.agentType)],
    ['Machine', trimmed(input.machineId)],
    ['Suggested action', trimmed(input.action)],
  ];

  const header = fields
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');

  const message = trimmed(input.message);
  if (!message) {
    return header;
  }
  return header ? `${header}\n\n${message}` : message;
}
