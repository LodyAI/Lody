import { EphemeralStore, type Value } from 'loro-crdt';
import { isLodyPromptSuggestion, type LodyPromptSuggestion } from 'acp-extension-core';

export const PROMPT_SUGGESTION_CHANNEL = 'prompt-suggestions';
// Transport retention, not a turn freshness rule. No persistence or heartbeat renewal.
export const PROMPT_SUGGESTION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TEXT_LENGTH = 16_384;
const MAX_SESSIONS = 256;
export type SessionPromptSuggestion = LodyPromptSuggestion & { machineId: string };
const keyFor = (machineId: string, sessionId: string) =>
  `${encodeURIComponent(machineId)}:${encodeURIComponent(sessionId)}`;

export function isSessionPromptSuggestion(value: unknown): value is SessionPromptSuggestion {
  return (
    isLodyPromptSuggestion(value) &&
    'machineId' in value &&
    typeof value.machineId === 'string' &&
    value.machineId.length > 0 &&
    value.machineId.length <= 256 &&
    value.sessionId.length <= 256 &&
    (value.sourceTurnId?.length ?? 0) <= 256 &&
    (value.suggestionId?.length ?? 0) <= 256 &&
    (value.result.type !== 'completed' ||
      value.result.text === null ||
      value.result.text.length <= MAX_TEXT_LENGTH)
  );
}

export function readPromptSuggestion(
  states: Record<string, unknown>,
  machineId: string,
  sessionId: string
): string | null {
  const value = states[keyFor(machineId, sessionId)];
  if (
    !isSessionPromptSuggestion(value) ||
    value.machineId !== machineId ||
    value.sessionId !== sessionId
  )
    return null;
  return value.result.type === 'completed' && value.result.text ? value.result.text : null;
}

export function toPromptSuggestionStreamUrl(streamUrl: string): string {
  const url = new URL(streamUrl);
  url.searchParams.set('ephemeral', PROMPT_SUGGESTION_CHANNEL);
  return url.toString();
}

/** Only this daemon's authored values enter the local plane. Remote values never write back. */
export class PromptSuggestionStore {
  readonly store = new EphemeralStore(PROMPT_SUGGESTION_TTL_MS);
  private readonly keys = new Set<string>();
  publish(machineId: string, suggestion: LodyPromptSuggestion): void {
    const value = { ...suggestion, machineId };
    if (!isSessionPromptSuggestion(value)) return;
    const key = keyFor(machineId, suggestion.sessionId);
    this.keys.delete(key);
    this.keys.add(key);
    if (this.keys.size > MAX_SESSIONS) {
      const oldest = this.keys.values().next().value!;
      this.keys.delete(oldest);
      this.store.delete(oldest);
    }
    // Select contract fields only: no extra provider fields enter the sync channel.
    this.store.set(key, {
      machineId,
      sessionId: suggestion.sessionId,
      ...(suggestion.sourceTurnId ? { sourceTurnId: suggestion.sourceTurnId } : {}),
      ...(suggestion.suggestionId ? { suggestionId: suggestion.suggestionId } : {}),
      result:
        suggestion.result.type === 'completed'
          ? { type: 'completed', text: suggestion.result.text }
          : { type: 'failed' },
    } as Value);
  }
  encode(): Uint8Array {
    return this.store.encodeAll();
  }
  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener);
  }
  destroy(): void {
    this.keys.clear();
    this.store.destroy();
  }
}
