/**
 * Turn a real local conversation into a benchmark fixture that keeps every
 * performance-relevant property and none of the content.
 *
 * What is preserved, because it is what the cost is made of: the turn/item tree
 * shape, every item `type`/`kind`/`status` (they select code paths), array
 * lengths, key sets, exact string LENGTHS and newline positions (a `LoroText`
 * costs what its content costs), and referential integrity between a
 * `toolCallId` and its later update.
 *
 * What is replaced: every natural-language string, path, command, URL and id,
 * plus absolute timestamps (shifted onto a synthetic epoch, deltas intact).
 *
 * Root `AGENTS.md`: captured transcripts are never committed. A fixture built
 * from this is still derived from real data — keep it out of the repository.
 */

/** Keys whose value drives rendering/import code paths, so it must survive verbatim. */
const STRUCTURAL_KEYS = new Set([
  'type',
  'role',
  'kind',
  'status',
  'sendStatus',
  'cliType',
  'agentType',
  'source',
  'origin',
  'titleSource',
  'mimeType',
  'transport',
  'priority',
  'state',
  'visibility',
]);

/** Keys carrying an identifier: pseudonymized, but stable so cross-references hold. */
const ID_KEYS = new Set([
  'id',
  '$cid',
  'toolCallId',
  'taskId',
  'subagentId',
  'userTurnId',
  'acpTurnId',
  'userId',
  'sessionId',
  'acpSessionId',
  'imageId',
  'fileId',
  'machineId',
  'localProjectId',
  'workspaceId',
  'resume',
  'parentId',
  'messageId',
]);

const DATE_KEYS = new Set(['timestamp', 'createdAt', 'updatedAt', 'lastMessageAt']);

/** Fixed synthetic epoch: 2020-01-01T00:00:00Z. Deltas between turns are kept. */
const SYNTHETIC_EPOCH_MS = 1_577_836_800_000;

const FILLER_WORDS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliet',
  'kilo',
  'lima',
];

export type DesensitizeOptions = {
  /** Deterministic seed so two runs produce byte-identical fixtures. */
  seed?: number;
};

class Desensitizer {
  private readonly idMap = new Map<string, string>();
  private idCounter = 0;
  private timeBaseMs: number | null = null;
  private cursor: number;

  constructor(seed: number) {
    this.cursor = seed >>> 0 || 1;
  }

  /** Content-independent filler of exactly `length` chars, newlines preserved. */
  private filler(length: number, newlineAt: readonly number[]): string {
    const chars: string[] = [];
    let word = '';
    let wordIndex = 0;
    while (chars.length < length) {
      if (word.length === 0) {
        this.cursor = (this.cursor * 1_103_515_245 + 12_345) >>> 0;
        word = `${FILLER_WORDS[this.cursor % FILLER_WORDS.length]} `;
        wordIndex = 0;
      }
      chars.push(word[wordIndex]!);
      wordIndex += 1;
      if (wordIndex >= word.length) word = '';
    }
    for (const index of newlineAt) {
      if (index < chars.length) chars[index] = '\n';
    }
    return chars.join('');
  }

  private text(value: string): string {
    const newlineAt: number[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === '\n') newlineAt.push(index);
    }
    return this.filler(value.length, newlineAt);
  }

  private id(value: string): string {
    const existing = this.idMap.get(value);
    if (existing) return existing;
    // Keep the length class so hashing/id-keyed map costs stay comparable.
    const replacement = `id-${(this.idCounter += 1).toString(36).padStart(8, '0')}`;
    this.idMap.set(value, replacement);
    return replacement;
  }

  private date(value: string): string {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return value;
    if (this.timeBaseMs === null) this.timeBaseMs = parsed;
    return new Date(SYNTHETIC_EPOCH_MS + (parsed - this.timeBaseMs)).toISOString();
  }

  value(input: unknown, key: string | null): unknown {
    if (typeof input === 'string') {
      if (key !== null && STRUCTURAL_KEYS.has(key)) return input;
      if (key !== null && ID_KEYS.has(key)) return this.id(input);
      if (key !== null && DATE_KEYS.has(key)) return this.date(input);
      return this.text(input);
    }
    if (Array.isArray(input)) {
      return input.map((item) => this.value(item, key));
    }
    if (input && typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(input as Record<string, unknown>)) {
        out[childKey] = this.value(childValue, childKey);
      }
      return out;
    }
    // Numbers and booleans are sizes, counts and flags: structural, kept as-is.
    return input;
  }
}

export function desensitizeHistory<T>(history: readonly T[], options: DesensitizeOptions = {}): T[] {
  const desensitizer = new Desensitizer(options.seed ?? 0x5eed_1234);
  return history.map((entry) => desensitizer.value(entry, null) as T);
}
